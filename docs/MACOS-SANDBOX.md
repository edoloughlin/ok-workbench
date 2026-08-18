# macOS Seatbelt sandbox

Status: implemented.

OK Workbench uses Apple's Seatbelt sandbox through `/usr/bin/sandbox-exec` for
the file-tool worker on macOS. Linux continues to use Bubblewrap. The server,
browser UI, provider authentication, and Git client remain outside this
worker; only the small JSONL process that implements workspace file tools is
sandboxed.

## Requirements and selection

- Node.js 22.19.0 or newer.
- A macOS installation that provides executable `/usr/bin/sandbox-exec`.
- The packaged Seatbelt profile at `src/macos-sandbox.sb` (copied to `dist/`
  during the build).

The launcher selects Seatbelt only when `process.platform === 'darwin'`. It
selects Bubblewrap only on Linux. Missing or failed platform support returns no
file-tool worker; it never falls back to an unsandboxed process. Run
`ok-workbench doctor` to see the selected backend.

## How the worker starts

Before launch, the application resolves the workspace, project template, Node
binary, and private temporary directory to canonical paths. It then starts
Node through an argument array equivalent to:

```text
/usr/bin/sandbox-exec \
  -D WORKSPACE=<canonical workspace> \
  -D TEMPLATE=<canonical template> \
  -D PRIVATE_TMP=<owner-only temporary directory> \
  -D NODE_BINARY=<canonical Node binary> \
  -D NODE_RUNTIME=<resolved Node installation> \
  -f macos-sandbox.sb \
  <Node binary> --input-type=commonjs --eval <worker source>
```

Dynamic paths are supplied with `-D` parameters, not interpolated into the
profile. The worker receives an allowlisted environment: `PATH`, a private
`HOME` and `TMPDIR`, the canonical workspace variables, the project-template
path, and a CoreFoundation text-encoding hint. Provider keys, browser state,
proxy settings, shell configuration, and `NODE_OPTIONS` are not inherited.

The worker sends an explicit JSONL ready message. The server does not expose it
to the agent until that handshake succeeds; an early exit, timeout, or profile
failure disables the operation and preserves its diagnostic.

## Effective policy

The profile is deny-by-default and explicitly denies `network*`. It grants:

- read/write access to the selected workspace and a per-worker owner-only
  scratch directory;
- read-only access to the packaged project template;
- the minimum Node/macOS runtime files, metadata traversal, devices, shared
  memory, process information, and named Mach services needed to start Node;
- execution only of the resolved Node binary and forked descendants under the
  same Seatbelt policy.

It does not grant the worker access to application state, provider credentials,
unrelated workspace files, or arbitrary shell execution. The file-tool API
also rejects traversal, symbolic-link escapes, Git metadata, dotenv-style
files, common private-key names, and binary reads before filesystem access.

Seatbelt cannot provide Bubblewrap's synthetic root or namespaces. On macOS,
the worker uses canonical host paths internally, while its browser-visible
project links remain `/workspace/<project>` routes. Metadata-only access to
some system and user-path ancestors is required for Node and macOS path
resolution; it is not permission to read arbitrary home-directory file data.

## Operations and limits

The sandboxed worker provides `list_files`, `read_file`, `search_files`,
`apply_project_update`, and `create_project`. It intentionally has no shell or
general command-execution operation.

`sandbox-exec` is deprecated by Apple. It remains present on current supported
macOS releases, but it is not a long-term API guarantee. Seatbelt also lacks
Bubblewrap-style PID, mount, and resource namespaces, so this backend does not
claim cgroup-equivalent CPU or memory limits. A failed backend remains a hard
failure for mutating tools.

## Verification and diagnostics

The test suite includes a Darwin-only worker smoke test that reads a workspace
file through the production profile, and CI runs that test on `macos-latest`.
For an unexpected Seatbelt exit, the server logs the worker PID, exit status,
signal, and captured stderr. A targeted macOS diagnostic can be collected with:

```sh
sudo log stream --style compact --info --debug \
  --predicate 'eventMessage CONTAINS[c] "Sandbox: node"'
```

Use the resulting `Sandbox: node(...) deny` operation and path to identify a
missing narrow runtime permission. Do not solve such failures by allowing broad
filesystem, network, Mach-service, or command-execution access.
