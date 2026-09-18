# Threat model

## Assets and trust boundaries

The workspace bundle is user content. Application code comes from the installed package. Chat transcripts and provider credentials are application state outside the workspace. A remote model provider receives only the conversation and any context deliberately supplied to it. DuckDuckGo receives web-search queries but no workspace files or provider credentials.

The local HTTP server binds loopback only. Its chat mutation endpoints require an in-page CSRF token and a loopback origin. The browser is not an authority boundary against another local process running as the same user.

## Controls

- Workspace paths are lexically contained and resolved through `realpath`; served files and worker operations reject symlink escapes unless a project-specific external-link approval matches the alias and canonical target.
- External-link approvals are stored outside the workspace and bind the workspace, project, alias, link text, canonical destination, and destination kind. The application exposes only read-only browser access and fresh per-turn snapshots to the worker. It filters protected names, skips nested symlinks, bounds snapshot traversal, and never mounts the original external destination into a worker.
- The worker rejects Git metadata, dotenv-style files, common private-key names, binary reads, traversal, and symbolic-link writes.
- Mutating model tools require Bubblewrap on Linux or Seatbelt through `sandbox-exec` on macOS. The default worker has no network, a cleared environment, a private temporary directory, access only to the selected workspace, and read-only access to the packaged project template. Workspace manifests only declare requirements. A state-directory approval binds the canonical selected project, tool path, script hash, manifest hash, requested logical tool secrets, network requirement, and filesystem scope. Provider credentials and arbitrary server environment variables are never exposed. Each tool run is a separate sandbox with wall-clock, CPU, address-space, process-count, file-descriptor, and individual-file-size limits; timeout targets its complete process group.
- Git status, diff, revert, and unstage operations use a project pathspec inside the selected worktree.
- State directories are outside the bundle and are created with owner-only permissions for chat records.
- Web-search responses are size- and result-bounded, accept only HTTP(S) result URLs, and are explicitly identified to the model as untrusted third-party content.

## Known limits

Bubblewrap/user namespaces may be unavailable or restricted by Linux host policy. On macOS, `sandbox-exec` is an Apple-deprecated compatibility interface and does not provide Bubblewrap-style mount, PID, or network namespaces; Seatbelt nevertheless enforces the worker's explicit filesystem and no-network policy. The application fails closed for file tools when its platform backend cannot start, and custom workspace-tool execution currently fails closed outside Linux because it needs `prlimit` controls. Host-scoped network requirements are deliberately fail-closed until a broker or firewall implementation can enforce them; there is no unrestricted-network fallback. Limits are `prlimit`-style per-process/process-group limits, not cgroup-wide aggregate memory, CPU, or project-disk quotas. Direct API providers and OAuth remain third-party trust boundaries. A malicious same-user local process can read local files and is outside this application’s protection model. Seed updates are inspection-only in 1.0.0; automatic three-way merging is not yet implemented. See [MACOS-SANDBOX.md](MACOS-SANDBOX.md) for macOS-specific details.

Report security issues as described in [SECURITY.md](SECURITY.md).
