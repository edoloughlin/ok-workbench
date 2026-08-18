# OK Workbench

OK Workbench is a local, LLM-assisted project workspace. It serves a portable `workspace/` bundle of durable project knowledge: OKF-structured indexes, project status, logs, a supplied workflow, templates, and assistant instructions. Browsing works with no provider credentials; chat is optional and remains project-scoped.

## Status and scope

This is an early, Linux-focused release. It is designed for local project knowledge and reviewable LLM-assisted edits, not hosted multi-user collaboration, a cloud credential manager, an autonomous background agent, or a replacement for Git review. The bundled starter workflow is original minimal material, not a redistribution of any private workflow.

## Requirements

- Node.js 22.19.0 or newer.
- Linux and Bubblewrap with unprivileged user namespaces for file-changing chat tools. Browsing and read-only chat remain available without Bubblewrap.
- Git for the change-review controls.

Run `ok-workbench doctor` to check the effective root, Git, Bubblewrap, state location, and provider configuration without printing secrets.

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

The `okf-workbench` CLI name, `OKF_*` variables, its config directory, `AGENTS_BROWSER_STATE_DIR`, old CSRF headers, `/agents/`, and `AGENTS_BUNDLE_ROOT` are one-release compatibility paths. Use `ok-workbench migrate-state --yes` only after reviewing the paths: it copies legacy state only if the destination does not exist and never deletes old data. Browser `localStorage` preferences may need to be set again when the route, origin, or port changes.

## Security model

The server binds loopback. Workspace paths, worker operations, and served assets reject traversal and symlink escapes. File-changing model tools fail closed without Bubblewrap; when available, the worker receives a cleared environment, no network, a temporary root, the served workspace, and a read-only packaged OKF template. The agent can create a discoverable top-level project only through the template-backed `create_project` tool; the workspace is initialized as a Git worktree before that operation. Git review actions use project-scoped pathspecs. See the full [threat model](docs/THREAT-MODEL.md) and [security policy](docs/SECURITY.md).

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
