# macOS `sandbox-exec` backend specification

Status: proposed

## Summary

OK Workbench must use `/usr/bin/sandbox-exec` to isolate the workspace tool worker when `process.platform === 'darwin'`. Linux must continue to use Bubblewrap. Unsupported platforms, a missing sandbox executable, an invalid profile, or a failed capability probe must leave model file tools unavailable; none may fall back to an unsandboxed worker.

This backend aims to preserve the security properties of the Linux worker, not its mount layout. Seatbelt does not provide Bubblewrap-style mount or PID namespaces, so the macOS worker uses canonical host paths while a deny-by-default profile limits which paths and services it can access.

`sandbox-exec` is deprecated by Apple in favour of App Sandbox, but App Sandbox does not fit the current unsigned Node CLI distribution. Treat this backend as a contained compatibility layer and retain the option to replace it if Apple removes the command or publishes a supported mechanism for sandboxing an arbitrary child process.

## Goals

- Enable the existing `list_files`, `read_file`, `search_files`, `apply_project_update`, and `create_project` tools on macOS.
- Give the worker read/write access only to the selected workspace and a private temporary directory.
- Give the worker read-only access to the packaged project template and the minimum macOS and Node runtime files required to start.
- Deny inbound and outbound network access.
- Keep provider credentials, application state, the rest of the user's home directory, and unrelated worktrees unavailable to the worker.
- Preserve the existing JSONL worker protocol and `TurnWorker` lifecycle.
- Fail closed and report an actionable platform-specific diagnostic.

## Non-goals

- Emulating Linux namespaces, `/workspace`, or a synthetic root filesystem on macOS.
- Adding shell or arbitrary command execution to the worker.
- Sandboxing the HTTP server or model-provider client. Only the file-tool worker is in scope.
- Supporting Mac App Store packaging or replacing Seatbelt with App Sandbox entitlements.
- Claiming cgroup-equivalent CPU or memory controls. This change does not add resource supervision.

## Backend selection

Introduce a platform-neutral worker launcher rather than adding Darwin branches throughout `runPiTurn`:

```text
createTurnWorker(projectRoot)
  -> selectSandboxBackend(process.platform)
       linux  -> Bubblewrap backend
       darwin -> sandbox-exec backend
       other  -> unavailable
  -> backend.probe()
  -> backend.spawn(worker configuration)
  -> TurnWorker
```

Selection is automatic and based only on `process.platform`. Do not select a backend by testing which executable happens to be on `PATH`: a Homebrew `bwrap` installation on macOS is not a substitute for a Linux kernel, and a command named `sandbox-exec` on another platform is not sufficient.

Use fixed system paths where the platform supplies them:

- macOS: `/usr/bin/sandbox-exec`
- Linux: retain the existing `/usr/bin/bwrap`, then `/bin/bwrap`, search

The launcher result must distinguish `available`, `unavailable`, and `failed`. `unavailable` means the platform dependency is absent. `failed` means the dependency exists but its probe or worker startup failed. Both disable file tools, but the latter must retain stderr for diagnosis.

## Common worker contract

Both backends receive a configuration containing canonical absolute paths for:

- the selected workspace;
- the packaged project template;
- the Node executable;
- the evaluated worker source; and
- a newly-created per-worker temporary directory.

Resolve the workspace, template, Node executable, and temporary directory with `realpath` before constructing sandbox arguments. Reject a workspace or template that changes type or cannot be resolved. Preserve the worker's existing path-containment and symlink checks as defence in depth.

The child environment must be constructed from an allowlist, never copied from `process.env`:

```text
PATH=/usr/bin:/bin
HOME=<private temporary directory>
TMPDIR=<private temporary directory>
OK_WORKSPACE_ROOT=<canonical workspace path>
OKF_WORKSPACE_ROOT=<canonical workspace path>       # compatibility
OK_WORKBENCH_PROJECT_TEMPLATE=<canonical template path>
```

Do not pass provider keys, state-directory paths, proxy variables, shell startup variables, `NODE_OPTIONS`, or dynamic-loader variables. Launch Node by canonical absolute path, so `PATH` is not used to find it.

The worker must emit an explicit ready message after Node has started and initialized its JSONL input. `createTurnWorker` must wait for that message with a short timeout before returning. A successful `spawn` event alone does not prove that Bubblewrap or Seatbelt accepted its policy. Preserve stderr through startup and runtime failures.

The private temporary directory must be created with owner-only permissions before launch and removed after the child closes. Cleanup failure may be logged but must not mask the worker's primary error.

## macOS launch

The macOS backend launches:

```text
/usr/bin/sandbox-exec
  -D WORKSPACE=<canonical workspace>
  -D TEMPLATE=<canonical packaged template>
  -D PRIVATE_TMP=<canonical private temporary directory>
  -D NODE_BINARY=<canonical Node executable>
  -D NODE_RUNTIME=<canonical Node installation root>
  -f <packaged profile>
  <canonical Node executable>
  --input-type=commonjs
  --eval
  <worker source>
```

Pass dynamic values through separate `-D` arguments and `(param ...)` expressions in the profile. Do not interpolate paths into profile source. Argument-array spawning is required; no shell may parse the command.

`NODE_RUNTIME` is the narrowest stable installation directory containing the resolved Node binary and its adjacent runtime data. For a Homebrew Cellar installation this is the versioned Node directory, not `/opt/homebrew` or `/usr/local`. For `/usr/bin/node`, the system-path rules below are sufficient and `NODE_RUNTIME` may equal the resolved binary's parent. Tests must cover paths containing spaces and parentheses.

Unlike Bubblewrap, Seatbelt does not remap the workspace to `/workspace`. Set the worker root variables to the canonical host path. The `location` returned by `create_project` remains the application's `/workspace/<id>` browser route; it is not a filesystem path and must not be derived from the worker root.

## Seatbelt policy

Package a versioned, reviewed profile with the application. Its semantic policy is:

```scheme
(version 1)
(deny default)

; Permit the process to run and communicate over inherited stdio only.
(allow process-exec (literal (param "NODE_BINARY")))
(allow signal (target self))

; Keep the no-network invariant explicit as well as covered by deny-default.
(deny network*)

; Runtime reads. Keep this list explicit and validate it on every supported
; macOS version and architecture.
(allow file-read*
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/private/var/db/dyld")
  (subpath (param "NODE_RUNTIME")))

; Application data.
(allow file-read* file-write*
  (subpath (param "WORKSPACE"))
  (subpath (param "PRIVATE_TMP")))
(allow file-read*
  (subpath (param "TEMPLATE")))

; Network and unrelated filesystem access remain denied by the default rule.
```

This excerpt defines the required boundary, not a promise that these are the only operations Node needs on every macOS release. The checked-in profile may add narrowly-scoped runtime operations such as specific `sysctl-read`, Mach lookups, device reads, or metadata access only when a failing integration test demonstrates the need. Each addition must name the consumer and security effect in an adjacent comment. It must not add any of the following broad grants:

- unrestricted `file-read*`, `file-write*`, `network*`, or `mach*`;
- a read grant for `/Users`, `/Volumes`, `/private`, `/opt/homebrew`, or `/usr/local` as a whole;
- writes outside `WORKSPACE` and `PRIVATE_TMP`;
- execution of shells or arbitrary binaries; or
- access to the application state or credential directories.

The final checked-in profile must explicitly deny `network*`, even though `(deny default)` already does so. This makes the no-network invariant reviewable and protects it from an accidentally broad later rule. macOS-specific integration tests, rather than profile compilation alone, are the authority for the effective policy.

The template path is read-only at the Seatbelt layer. `create_project` copies from it into the writable workspace, matching the Linux read-only bind mount.

## Security-property mapping

| Property | Linux/Bubblewrap | macOS/Seatbelt |
| --- | --- | --- |
| Backend detection | `process.platform === 'linux'` | `process.platform === 'darwin'` |
| Filesystem default | Temporary root namespace | Deny-default filesystem policy |
| Workspace | Read/write bind at `/workspace` | Read/write canonical host subpath |
| Project template | Read-only bind | Read-only canonical host subpath |
| System/runtime files | Read-only system binds | Explicit read-only path rules |
| Temporary files | Private tmpfs | Owner-only per-worker host directory |
| Environment | Bubblewrap `--clearenv` | Explicit `spawn` environment allowlist |
| Network | Unshared network namespace | Seatbelt `network*` denial |
| Parent lifetime | `--die-with-parent` | Supervisor closes/kills worker; verify no orphan in tests |
| Process namespace | Unshared | Not available; no worker command-execution tool |

Seatbelt's lack of namespace isolation is a documented residual difference. The acceptance tests below are required before describing macOS isolation as equivalent for the current file-only worker.

## Capability probe and diagnostics

The macOS probe must verify all of the following:

1. `process.platform` is `darwin`.
2. `/usr/bin/sandbox-exec` exists and is executable.
3. A minimal deny-default profile can launch `/usr/bin/true`.
4. A dedicated probe program under the production profile can launch the actual Node binary, read a fixture through the workspace grant, write only inside the fixture workspace/private temp directory, and is denied a network connection and a read of an ungranted fixture.

The lightweight checks may run in `doctor`; the full production-profile smoke check must run when starting the first worker and in macOS CI. Cache a successful probe only for the lifetime of the server process and only for the tuple of platform, OS release, Node realpath, and packaged profile hash.

`ok-workbench doctor` output becomes platform-aware:

```text
ok    Sandbox (sandbox-exec/Seatbelt)
```

or:

```text
warn  Sandbox (sandbox-exec/Seatbelt): <concise reason>
```

Linux retains `Sandbox (Bubblewrap/user namespaces)`. Unsupported platforms report that isolated model file tools are unavailable. Deprecation text emitted by `sandbox-exec` may be recognized and summarized, but must not hide other stderr or turn a successful probe into failure.

User-facing runtime errors must say `A supported sandbox is required before agent file tools can run`, followed by the backend-specific reason when known. Remove Bubblewrap-specific wording from shared `TurnWorker` comments and errors.

## Test plan

### Platform-independent unit tests

- Backend selection chooses Bubblewrap for `linux`, Seatbelt for `darwin`, and no backend otherwise.
- The macOS argument builder uses arrays, fixed `/usr/bin/sandbox-exec`, `-D` parameters, canonical paths, and the explicit environment allowlist.
- Malicious or unusual path text cannot alter the profile or add arguments.
- A missing command, profile parse failure, startup timeout, early exit, and signal termination all reject pending tool calls with stderr context.
- The ready handshake prevents a worker from being returned after sandbox setup fails.
- Temporary-directory cleanup runs after normal close and startup failure.

Unit tests must inject platform, filesystem lookup, and spawn operations; they must not pretend a Linux CI host can enforce a Seatbelt profile.

### macOS integration tests

Run on every supported macOS major version and on both Apple silicon and Intel where those architectures are claimed. From inside the production worker sandbox, verify:

- reading and writing normal files beneath the workspace succeeds;
- creating a project from the packaged template succeeds;
- writing the packaged template fails;
- reading a canary in the user's home directory, application state directory, a sibling worktree, and the workspace's `.git` directory fails;
- following a symlink from the workspace to an outside canary fails;
- writing outside the workspace and private temporary directory fails;
- DNS, TCP, UDP, Unix-domain connections to non-inherited sockets, and listening sockets fail;
- spawning `/bin/sh`, `/usr/bin/env`, and another arbitrary executable fails;
- the worker exits when its supervisor closes and leaves no child behind; and
- provider credentials and proxy variables are absent from the environment.

Also run all existing tool-worker behavior tests under both backends. A policy relaxation required for a new macOS release must land with a regression test demonstrating the original failure and the narrow grant.

## Documentation changes at implementation time

When the backend ships, update `README.md`, `docs/README.md`, `docs/index.md`, and `docs/THREAT-MODEL.md` together:

- requirements become Linux with Bubblewrap or macOS with the system `sandbox-exec` command;
- security claims name the selected backend and the residual lack of namespace isolation on macOS;
- known limits state that `sandbox-exec` is deprecated and may change or disappear; and
- `doctor` documentation describes its platform-specific probe.

Do not update the current support claim until the integration suite passes on the minimum supported macOS release.

## Rollout and acceptance

Land the work in these reviewable stages:

1. Extract the common launcher contract, ready handshake, allowlisted environment, and generic diagnostics without changing Linux behavior.
2. Add the packaged Seatbelt profile, Darwin backend, and unit tests behind automatic platform selection.
3. Add macOS CI security tests and document the tested OS/architecture matrix.
4. Update public support and threat-model documentation only after the security tests pass.

The feature is complete when a normal macOS installation can use every existing workspace tool, all denial canaries remain inaccessible, `doctor` identifies the effective backend accurately, Linux behavior is unchanged, and no failure path launches the worker without an enforced sandbox.

## References

- Apple, [Configuring the macOS App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox) — overview of macOS kernel-enforced sandboxing and least-privilege resource access.
- Apple, [Accessing files from the macOS App Sandbox](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox) — filesystem access behavior and interaction with POSIX permissions, ACLs, and other macOS controls.
- [`sandbox-exec(1)` manual](https://www.manpagez.com/man/1/sandbox-exec/) — command, profile-file, and `-D key=value` interface. The installed macOS manual is authoritative for each tested release.
