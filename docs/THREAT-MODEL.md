# Threat model

## Assets and trust boundaries

The workspace bundle is user content. Application code comes from the installed package. Chat transcripts and provider credentials are application state outside the workspace. A remote model provider receives only the conversation and any context deliberately supplied to it.

The local HTTP server binds loopback only. Its chat mutation endpoints require an in-page CSRF token and a loopback origin. The browser is not an authority boundary against another local process running as the same user.

## Controls

- Workspace paths are lexically contained and resolved through `realpath`; served files and worker operations reject symlink escapes.
- The worker rejects Git metadata, dotenv-style files, common private-key names, binary reads, traversal, and symbolic-link writes.
- Mutating model tools require Bubblewrap. The sandbox has no network, a cleared environment, a temporary root, and only the selected project mounted as user data.
- Git status, diff, revert, and unstage operations use a project pathspec inside the selected worktree.
- State directories are outside the bundle and are created with owner-only permissions for chat records.

## Known limits

Bubblewrap/user namespaces are Linux controls and may be unavailable or restricted by host policy; the application fails closed for model file tools in that case. The current worker has no cgroup resource supervision. Direct API providers and OAuth remain third-party trust boundaries. A malicious same-user local process can read local files and is outside this application’s protection model. Seed updates are inspection-only in 1.0.0; automatic three-way merging is not yet implemented.

Report security issues as described in [SECURITY.md](SECURITY.md).
