# OK Workbench

OK Workbench is a local, multi-project knowledge base and wiki where an AI does the filing. Instead of editing notes by hand, you talk to a project-scoped assistant that reads and writes your Markdown documents for you: it keeps each project's status current, maintains a dated log, manages todos, and makes sure related files are updated together so the workspace doesn't drift. It works well as a planning or coaching aid — sit down, ask "where was I?", and the assistant orients itself from the same files you can read — or simply as a wiki you browse in the local web UI with no AI involved at all.

Everything lives in a portable `workspace/` bundle of plain Markdown, structured with OKF (indexes, frontmatter, and standard links) so the assistant can reliably discover what's related to what. Edits arrive as reviewable, Git-backed batches that must keep the project index, log, and status consistent; file-changing tools run in a platform sandbox and fail closed without it. Non-Markdown sources (PDF, DOCX, PPTX, XLSX, ODT/ODP/ODS) can be stored alongside your notes, and the assistant can extract their text — naively, text only — to fold into the knowledge base. Browsing needs no provider credentials; chat is optional and remains project-scoped. See the [overview](docs/OVERVIEW.md) for a longer tour.

## Status and scope

This is an early local-first release for Linux and macOS. It is designed for local project knowledge and reviewable LLM-assisted edits, not hosted multi-user collaboration, a cloud credential manager, an autonomous background agent, or a replacement for Git review. The bundled starter workflow is original minimal material, not a redistribution of any private workflow.

## Requirements

- Node.js 22.19.0 or newer.
- Linux with Bubblewrap and unprivileged user namespaces, or macOS with the system `/usr/bin/sandbox-exec`, for file-changing chat tools. Browsing and read-only chat remain available when an isolation backend is unavailable.
- Git for the change-review controls.

Run `ok-workbench doctor` to check the effective root, Git, the platform-specific sandbox backend, state location, and provider configuration without printing secrets.

## Install and quick start

```sh
git clone https://github.com/edoloughlin/ok-workbench.git
cd ok-workbench
npm ci
npm run build
npm install --global .
ok-workbench init ~/workspace --yes
ok-workbench serve --root ~/workspace
```

Install from a source checkout; this project is not published to the npm registry.

Open `http://localhost:3477/workspace/`. Add `--git` to `init` only when a new Git repository is wanted. `init` refuses `/`, the home directory, the application state directory, and non-empty directories by default. `--merge` reports conflicts and copies only absent seed files; it never overwrites user content.

## Workspace bundle

```text
workspace/
  index.md                 # root index, declares OKF 0.2
  AGENTS.md                # default assistant instructions
  workflow/                # supplied, versioned working loop
  templates/               # starter project artifacts
  example-project/         # minimal valid OKF project
  bundle-manifest.json     # managed hashes and independent versions
```

`bundle-manifest.json` separately records the OKF/schema version (`0.2`), workflow version, seed version, and hashes of supplied reference files. Project content is yours to edit. Workflow and template files are supplied reference material that you may customize; the manifest lets `seed diff` identify later user changes safely. Automatic `seed update` is deliberately not available in 1.0.0.

OK Workbench’s seed is original material. It uses the [upstream OKF v0.2 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) only as its declared format reference.

## CLI and configuration

```text
ok-workbench init [directory] [--yes] [--merge] [--git]
ok-workbench serve [--root directory] [--port port]
ok-workbench doctor [--root directory]
ok-workbench seed diff [directory]
ok-workbench migrate-state --yes
```

The content root resolves in this order: explicit `--root`, `OK_WORKSPACE_ROOT`, legacy `OKF_WORKSPACE_ROOT`/`AGENTS_BUNDLE_ROOT`, `workspaceRoot` in `$XDG_CONFIG_HOME/ok-workbench/config.json` (then the legacy `okf-workbench` location), `./workspace` when present, then `~/workspace`.

Chat state and provider credentials live outside the bundle under the XDG state directory (default `~/.local/state/ok-workbench/chat`). Set `OK_WORKBENCH_STATE_DIR` to use another state location. Provider API keys belong in the server environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or compatible-provider variables) or can be supplied through the local sign-in UI; GitHub Copilot subscription sign-in uses GitHub's device flow. Never put credentials in the workspace.

## Workspace tools

The assistant can discover executable Python 3 and Node.js scripts placed directly in `tools/` or `<project>/tools/`. Each tool needs a standard shebang such as `#!/usr/bin/env python3` or `#!/usr/bin/env node`. Tools run without a shell, with each supplied argument kept separate, a 30-second default limit, and captured output.

Optional policy lives beside the script in `<tool-name>.tool.json`, where `<tool-name>` excludes the script extension. For example, the policy for `tools/jira-sync.js` is `tools/jira-sync.tool.json`. The full-filename form (`jira-sync.js.tool.json`) is also accepted for compatibility, but do not create both. It is visible to the assistant but is not writable by it; scripts under `tools/` are likewise read/run-only from the assistant's perspective. Never put a secret value in this file.

When tools are discovered, malformed, conflicting, or orphaned metadata is returned as a diagnostic and written to the backend log. This makes a metadata filename mismatch visible without attempting to run the tool.

```json
{
  "environment": ["JIRA_API_TOKEN", "JIRA_BASE_URL"],
  "network": true,
  "timeoutSeconds": 120
}
```

`environment` lists variables that must already be set in the environment used to start `ok-workbench`; only that tool receives those named values. `network` defaults to `false`. Setting it to `true` permits that tool outbound network access on Linux and macOS. `timeoutSeconds` defaults to `30` and accepts whole seconds from `1` through `600`. This is deliberately a per-tool grant, but it currently permits general outbound access rather than a host allowlist. Keep credentials in the launching environment, not in the workspace or manifest.

The `okf-workbench` CLI name, `OKF_*` variables, its config directory, `AGENTS_BROWSER_STATE_DIR`, old CSRF headers, `/agents/`, and `AGENTS_BUNDLE_ROOT` are one-release compatibility paths. Use `ok-workbench migrate-state --yes` only after reviewing the paths: it copies legacy state only if the destination does not exist and never deletes old data. Browser `localStorage` preferences may need to be set again when the route, origin, or port changes.

## Security model

The server binds loopback. Workspace paths, worker operations, and served assets reject traversal and symlink escapes. File-changing model tools fail closed without the platform sandbox: Bubblewrap on Linux or Seatbelt through `sandbox-exec` on macOS. Both workers receive a cleared environment, no network, a private temporary directory, the served workspace, and a read-only packaged OKF template. The agent can create a discoverable top-level project only through the template-backed `create_project` tool; the workspace is initialized as a Git worktree before that operation. Git review actions use project-scoped pathspecs. See the full [threat model](docs/THREAT-MODEL.md), [macOS sandbox guide](docs/MACOS-SANDBOX.md), and [security policy](docs/SECURITY.md).

## Development and release

```sh
npm ci
npm run build
npm test
OK_WORKBENCH_INTEGRATION=1 npm test
npm run pack
```

`src/` is authored source. `dist/` is generated by a clean build and is the CLI distribution; `seed/` is the reviewed starter bundle. CI builds, tests, audits distributable contents, installs the generated tarball, initializes a workspace, runs npm audit, and generates an SBOM.

Read the [product overview](docs/index.md), [contribution guide](docs/CONTRIBUTING.md), [support policy](docs/SUPPORT.md), [code of conduct](docs/CODE_OF_CONDUCT.md), [release process](docs/RELEASING.md), [public release audit](docs/PUBLIC-RELEASE-AUDIT.md), and [changelog](docs/CHANGELOG.md). The project is Apache-2.0 licensed.

`ok-workbench` is the approved product identity. Complete trademark/domain review before publishing.
