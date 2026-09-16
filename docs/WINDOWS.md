# Run OK Workbench on Windows with WSL2

You can try running OK Workbench inside a WSL2 Linux distribution and opening its web UI in a Windows browser. **The author has not tested this setup.** These steps offer a possible route; they do not establish Windows support. Native Windows execution does not provide the Linux sandbox that file-changing chat tools require.

## Before you begin

- Use Windows 10 version 2004 (build 19041) or later, or Windows 11, with permission to install WSL2. See [Microsoft's WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install).
- Use an Ubuntu distribution running as WSL2 for the commands below. Other distributions need equivalent packages and commands.
- Install Node.js 22.19.0 or newer **inside Ubuntu**, with `npm`. A Windows installation of Node.js does not satisfy this requirement. See [Microsoft's Node.js on WSL guide](https://learn.microsoft.com/en-us/windows/dev-environment/javascript/nodejs-on-wsl).
- Keep the checkout, workspace, and Node.js installation in the WSL filesystem, for example under `/home/<user>/`. Accessing a project under `/mnt/c/` from Linux can be much slower. See [Microsoft's filesystem guidance](https://learn.microsoft.com/en-us/windows/wsl/filesystems).

## Install WSL2 and Ubuntu

1. If WSL is not installed, open PowerShell as administrator and run:

   ```powershell
   wsl --install
   ```

   Restart Windows if prompted, then launch Ubuntu and create a Linux user account. If WSL is already installed, follow the [WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install) to add Ubuntu if needed.

2. In PowerShell, confirm that Ubuntu shows `VERSION 2`:

   ```powershell
   wsl --list --verbose
   ```

   If it shows version 1, follow Microsoft's [WSL version conversion instructions](https://learn.microsoft.com/en-us/windows/wsl/install#upgrade-version-from-wsl-1-to-wsl-2) before continuing.

## Install and run OK Workbench

1. Open the Ubuntu terminal. Install Git and the Linux utilities used by the sandbox and resource controls:

   ```sh
   sudo apt update
   sudo apt install -y git bubblewrap util-linux
   ```

2. Install Node.js 22.19.0 or newer in Ubuntu using the [Node.js on WSL guide](https://learn.microsoft.com/en-us/windows/dev-environment/javascript/nodejs-on-wsl). Then check that Ubuntu resolves the Linux versions of the required commands:

   ```sh
   node --version
   npm --version
   command -v node
   command -v bwrap
   command -v prlimit
   ```

   `node` must report version 22.19.0 or newer. If `command -v node` points into `/mnt/c/`, install Node.js in Ubuntu and use that installation.

3. Clone and build the application in your WSL home directory:

   ```sh
   cd ~
   git clone https://github.com/edoloughlin/ok-workbench.git
   cd ok-workbench
   npm ci
   npm run build
   npm install --global .
   ```

4. Initialise a new workspace with Git change review, then check the installation:

   ```sh
   ok-workbench init ~/workspace --yes --git
   ok-workbench doctor --root ~/workspace
   ```

   Check that `doctor` reports `ok` for the workspace root, Git, and `Sandbox (Bubblewrap/user namespaces)`. A successful check is a prerequisite, but it does not prove that every worker operation works under WSL2.

5. Start the server from Ubuntu:

   ```sh
   ok-workbench serve --root ~/workspace
   ```

   Open `http://localhost:3477/workspace/` in a Windows browser. WSL2 normally forwards Linux server ports to Windows `localhost`; see [Microsoft's WSL networking guide](https://learn.microsoft.com/en-us/windows/wsl/networking). Keep the Ubuntu terminal running while you use the app.

## Verify and use the sandbox

To check the same basic Bubblewrap capability that `doctor` checks, run this command in Ubuntu:

```sh
bwrap --unshare-user --ro-bind / / -- /usr/bin/true
```

The command exits successfully without output when that check passes. To test the complete file-changing path, try a small edit in a disposable project and review the resulting Git changes. If sandbox startup fails, file-changing chat tools remain unavailable; do not disable the sandbox to make them run.

The optional `run_python` tool also needs Ubuntu's `/usr/bin/python3` and `/usr/bin/prlimit`. If you want to use it, install `python3` in Ubuntu and follow [Run Python with isolated dependencies](PYTHON.md). The author has not tested this WSL2 path either.

## Troubleshooting

| Symptom | Cause to check | Action |
| :--- | :--- | :--- |
| `doctor` warns about Bubblewrap or file-changing tools fail to start. | Bubblewrap or unprivileged user namespaces are unavailable in this WSL installation. | Check `command -v bwrap` and run the Bubblewrap command above. Review your WSL and Ubuntu configuration; keep file-changing tools disabled until the sandbox works. |
| `node --version` is too old, or `node` resolves under `/mnt/c/`. | Ubuntu is using an old package or the Windows Node.js installation. | Install a supported Node.js version inside Ubuntu and reopen the terminal. |
| The browser cannot reach `localhost:3477`. | The server stopped, the port changed, or WSL localhost forwarding is unavailable. | Keep `ok-workbench serve` running, use the configured port, and follow [Microsoft's networking guidance](https://learn.microsoft.com/en-us/windows/wsl/networking). |
| Builds or file operations are slow. | The checkout or workspace is under `/mnt/c/`. | Move the checkout and workspace into the WSL filesystem and run Linux tools there. |

## What's next

- Read the [main README](../README.md) for provider setup and workspace usage.
- Read the [security model](THREAT-MODEL.md) before relying on file-changing chat tools.
