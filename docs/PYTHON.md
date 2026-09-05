# Run Python with isolated dependencies

Use `run_python` for calculations, CSV and JSON processing, image conversion, and existing Python scripts. The tool uses your locally installed `/usr/bin/python3`; it never downloads a Python interpreter or changes your Python installation.

## Before you begin

- Use Linux with working unprivileged user namespaces, `/usr/bin/bwrap`, `/usr/bin/prlimit`, and `/usr/bin/python3`.
- To install dependencies, provide pip for that interpreter. Check with `/usr/bin/python3 -I -m pip --version`.
- For CairoSVG, provide the system Cairo shared library. Python wheels do not install system libraries. OpenCV uses `opencv-python-headless` for processing without a desktop display.
- Keep secrets out of system runtime directories. The sandbox exposes `/usr`, `/lib`, and `/lib64` read-only to load the local interpreter and native libraries.
- General Python execution currently fails closed on macOS and Windows. Existing trusted workspace scripts retain their existing platform support.

## Enable Python

1. Set `OK_WORKBENCH_PYTHON=1` in the environment that starts your server, then restart it. The model cannot enable this setting through a tool request.
2. Optionally, set `OK_WORKBENCH_PYTHON_PACKAGES` to a comma-separated list of permitted package names. The default is `Pillow,CairoSVG,opencv-python-headless,numpy`. An empty value disables dependency installation while retaining standard-library execution.
3. Ask the assistant to process specific project files and save the result. Only explicitly listed input files enter the execution sandbox.

## Run code and save artifacts

The following tool request creates a thumbnail:

```json
{
  "code": "from PIL import Image\nwith Image.open('photo.png') as image:\n    image.thumbnail((320, 320))\n    image.save('/output/thumbnail.png')",
  "inputs": ["photo.png"],
  "packages": ["Pillow"],
  "artifacts": [
    {
      "staged_path": "/output/thumbnail.png",
      "project_path": "assets/thumbnail.png",
      "preserve": true
    }
  ],
  "timeoutSeconds": 30
}
```

The working directory is `/workspace`, which contains read-only copies of the requested inputs. Write intermediate and final files under the invocation's private `/output` directory. In the required `artifacts` manifest, declare each final file to preserve. After a successful exit, the harness validates and copies only entries with `preserve: true` to their exact `project_path`. The destination's parent directory must already exist, and the destination file must not exist. The harness then deletes the invocation's entire staging directory, including undeclared files and entries with `preserve: false`.

If you only need computation output, pass `"artifacts": []`. The result still includes the exit status, `stdout`, `stderr`, and an output truncation flag. Python exceptions return `ok: false` and captured `stderr` without promoting artifacts. Timeout and cancellation raise a tool error and discard all staged output.

A successful artifact-producing response has this shape:

```json
{
  "ok": true,
  "exitCode": 0,
  "signal": null,
  "stdout": "created thumbnail\n",
  "stderr": "",
  "truncated": false,
  "phase": "execute",
  "artifacts": [
    {
      "staged_path": "/output/thumbnail.png",
      "project_path": "assets/thumbnail.png",
      "preserve": true,
      "bytes": 18420
    }
  ],
  "paths": ["assets/thumbnail.png"],
  "packages": ["Pillow"]
}
```

### Response fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `ok` | Boolean | Indicates whether Python exited with code `0` and no signal. |
| `exitCode` | Integer or null | Contains the Python process exit code. |
| `signal` | String or null | If a signal ended Python, identifies that signal. |
| `stdout` | String | Contains captured standard output, capped at 64 KiB. The model receives this field even when `artifacts` is empty. |
| `stderr` | String | Contains captured standard error, capped at 64 KiB. The model receives this field even when `artifacts` is empty or Python exits with an exception. |
| `truncated` | Boolean | Indicates whether either captured stream exceeded its limit. |
| `phase` | String | Identifies `install` or `execute` as the phase that produced the result. |
| `artifacts` | Object array | Lists only files that the harness successfully promoted. Each entry includes `staged_path`, `project_path`, `preserve`, and `bytes`. |
| `paths` | String array | Lists promoted project-relative paths for workspace change notifications. |
| `packages` | String array | Lists the requested Python package specifications. |

To run an existing script, list the script and its data files in `inputs`, then use `import runpy; runpy.run_path('script.py', run_name='__main__')` as `code`. Pass script arguments through `arguments`. Local helper modules require an explicit `sys.path.append('/workspace')`; the interpreter starts with `-I -S` to exclude implicit project imports and site startup hooks.

### Request fields

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `code` | String | Yes | Nonempty Python code, at most 64 KiB. |
| `artifacts` | Object array | Yes | Up to 64 explicit artifact declarations. Use an empty array to preserve no files. |
| `inputs` | String array | No | Up to 64 selected-project-relative regular files, totaling at most 256 MiB. The runner rejects hidden paths, credential filenames, parent traversal, and symbolic links. |
| `packages` | String array | No | Up to 16 allowed package names, optionally pinned with `==version`. The runner rejects URLs, local paths, extras, pip flags, and requirements files. |
| `arguments` | String array | No | Up to 32 arguments, each at most 4,096 characters. |
| `stdin` | String | No | At most 64 KiB of standard input. |
| `timeoutSeconds` | Integer | No | Execution wall-time limit from 1 to 120 seconds; defaults to 30. Installation has a separate 120-second limit. |

### Artifact fields

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `staged_path` | String | Yes | The final regular file under `/output`, for example `/output/thumbnail.png`. The file must exist after a successful execution and must not be a link or special file. |
| `project_path` | String | Yes | The selected-project-relative destination. Its parent directory must exist, and the file must not exist. The harness rejects hidden paths, credential names, traversal, symbolic-link directories, workspace tools, and tool manifests. |
| `preserve` | Boolean | Yes | If `true`, validate and promote the file. If `false`, discard it with the rest of the staging directory. |

## Understand isolation and limits

Dependency installation and code execution use separate Bubblewrap sandboxes:

| Component | Filesystem access | Network access |
| :--- | :--- | :--- |
| Installer | System runtime files and a fresh package directory; no project inputs or outputs | Enabled for pip; fixed primary index `https://pypi.org/simple` |
| Python execution | Read-only staged inputs and packages; writable output and temporary directories | Disabled through a separate network namespace |
| Artifact promotion | After a successful exit, the harness copies only manifest entries with `preserve: true` to new, explicit project paths | None |

Pip installs wheels, including transitive dependencies, into a fresh temporary directory on every call. The installer disables source builds, user configuration, caches, and bytecode compilation. The harness checks requested packages against the allowlist but does not check each transitive dependency independently. Pin versions when reproducibility matters. Wheels and PyPI are still supply-chain dependencies: binary-only installation prevents source-build hooks but does not make installed code trustworthy. See [pip installation options](https://pip.pypa.io/en/stable/cli/pip_install/).

The execution interpreter skips site initialization, including wheel `.pth` files. Both sandboxes receive a cleared environment without provider keys, server settings, or proxy credentials. The installer has general network access, not an enforced hostname allowlist, but cannot access project data. Execution has no access to the original project and cannot rewrite trusted tools or manifests.

Each operation has a hard wall timeout. Killing Bubblewrap tears down its PID namespace and descendants. CPU time, 4 GiB address space, 256 MiB file size, 128 open descriptors, and disabled core dumps apply through inherited hard resource limits. The harness caps `stdout` and `stderr` at 64 KiB each. Promotion accepts at most 64 declared regular files totaling 256 MiB; the harness rejects links and special files. Only one Python operation runs at a time per server process.

These are per-process resource limits, not aggregate quotas. This implementation does not impose a cgroup process-count limit, total memory quota, or scratch disk quota. Multiple child processes or files can consume resources before timeout. Use a dedicated OS account or container with aggregate quotas for untrusted multi-user workloads; this opt-in feature targets a local single-user workbench. See [Python resource-limit semantics](https://docs.python.org/3/library/resource.html).

### Assess security coverage

The Python runner provides useful isolation, but it does not yet satisfy the full hardening checklist below. This assessment covers `run_python` only; existing trusted workspace tools retain their previous policy. Do not treat this implementation as fully hardened for hostile code.

| Requirement | Current protection | Remaining gap or limitation |
| :--- | :--- | :--- |
| Process isolation | Installation and execution run in separate Bubblewrap processes with PID namespaces and timeout/cancellation teardown. | Process isolation alone does not prevent resource exhaustion or kernel exploits. |
| Filesystem isolation | Execution receives read-only copies of explicit inputs and dependencies, plus writable scratch/output directories. The original workspace, real home directory, SSH keys, browser profiles, and cloud credential directories are not mounted. | `/usr`, `/lib`, and `/lib64` are broader than a minimal runtime allowlist. Sensitive files or unexpected nested mounts under these paths need additional controls. |
| Network isolation | Execution has no network access. Only dependency installation receives network access, without project inputs or outputs. | The installer uses a fixed primary package index, but the harness does not restrict egress to an enforced hostname allowlist. |
| Privilege reduction | A development runtime check reported UID `1000`, empty effective, permitted, inherited, bounding, and ambient capability sets, and `NoNewPrivs: 1`. | These observations describe the tested environment, not an application-enforced guarantee. The runner does not explicitly reject root launches or verify UID, dropped capabilities, and `no_new_privs` on every invocation. Setuid executables are not removed from runtime mounts; prevention of privilege gain relies on Bubblewrap's `no_new_privs` behavior. |
| Resource limits | The harness bounds CPU time, address space, individual file size, open descriptors, wall time, captured output, and artifact promotion. One Python operation runs at a time per server process. | The harness enforces no process-count limit, aggregate memory limit, or total scratch disk quota. Child processes and multiple files can exceed the intended total resource budget before timeout. |
| Syscall restrictions | The runner supplies no seccomp filter. | The development runtime check reported `Seccomp: 0`. Syscall filtering remains unimplemented. |
| Environment sanitisation | Both sandboxes receive a cleared environment with a small fixed set of variables. Provider keys, arbitrary Python settings, and proxy credentials are not inherited. | Environment sanitisation does not protect sensitive files placed inside the runtime mounts. |
| Workspace boundary | Input validation rejects traversal, hidden/credential paths, symbolic links, and special files. Artifact promotion is explicit and rejects links, special files, missing parent directories, and existing destinations. The sandbox uses fresh `/proc` and minimal `/dev` mounts; it does not mount the host Docker socket, and input staging rejects Unix sockets. | The current path checks do not fully address concurrent host-side path replacement. Unexpected nested bind mounts or sockets within broad runtime paths require further hardening. Fresh `/proc` and minimal `/dev` reduce exposure but do not replace syscall restrictions. |
| Policy above the sandbox | Server-operator opt-in and a package allowlist control availability. Python cannot overwrite existing project files or run destructive Git operations against the original repository through its mounts. Persistence requires an explicit artifact manifest and successful execution. | This implementation adds no general destructive-action approval framework. Any future writable-workspace or broader command capability needs a separate harness policy for destructive actions. |

`bwrap --unshare-all` is not a complete security policy. Review every bind mount and inherited file descriptor: exposing the real home directory, a Docker socket, or other privileged service sockets can defeat the intended isolation. Bubblewrap leaves the security policy to its caller; see the [Bubblewrap security documentation](https://github.com/containers/bubblewrap#security).

Before treating this runner as hardened for hostile code, enforce and verify privilege reduction, add a tested seccomp policy, impose aggregate resource and process-count quotas, narrow or validate runtime mounts, and strengthen filesystem operations against concurrent path replacement. Keep destructive-action decisions in the harness if future functionality grants access to existing project files. These are outstanding requirements, not protections supplied by the current implementation.

## Troubleshoot errors

| Error | Cause | Action |
| :--- | :--- | :--- |
| Python unavailable | Server opt-in is absent | Set `OK_WORKBENCH_PYTHON=1` and restart the server. |
| Python requires an executable | A local prerequisite is missing | Install the prerequisite through your OS tools. Workbench does not install Python. |
| Bubblewrap namespace failure | The OS disallows the required namespaces | Configure Bubblewrap and user namespaces; execution has no unsandboxed fallback. |
| No module named pip | The local interpreter has no pip | Provide pip for `/usr/bin/python3`. |
| No matching distribution | No compatible wheel exists for the local Python version and platform | Select a compatible version or package; source builds are not supported. |
| Cairo shared library not found | CairoSVG cannot load native Cairo | Install the system Cairo runtime through your OS tools. |
| Another Python operation is running | A previous call is still active | Retry after it finishes. |
| Artifact destination already exists | Promotion would overwrite a project file | Choose a new `project_path` or use a reviewed project-edit tool for replacement. |
| Artifact destination directory is unsafe | The parent directory is missing or contains a symbolic link | Create or select an existing regular project directory, then retry. |
| Declared artifact does not exist | Python did not create the declared `staged_path` | Correct the code or manifest path, then retry. |
| Timeout or cancellation | The harness stopped execution or installation | Reduce the workload or retry with an appropriate timeout. |

## What's next

- Review the [workspace security model](THREAT-MODEL.md).
- To use trusted scripts with explicitly granted credentials or network access, see [workspace tools](../README.md#workspace-tools).
- To test isolation and real package installation on Linux, run `OK_WORKBENCH_REQUIRE_PYTHON_TESTS=1 OK_WORKBENCH_TEST_PYPI=1 node --test test/python-runner.test.mjs`.
