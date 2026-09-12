# State, Secrets and Storage Security

Covers:

- SEC-05 — incorrect state-directory containment;
- SEC-08 — incomplete secret-file policy;
- SEC-11 — provider-key prefix disclosure.

Primary code area: `src/server.js`, plus common filesystem policy code.

---

# SEC-05 — Validate state location against the actual workspace

## Problem

The reviewed state-directory validation compares the configured state path with a hard-coded path based on:

```text
~/workspace
```

instead of the actual resolved workspace root.

With a custom workspace root, it is therefore possible to configure application state inside the active workspace.

That state includes sensitive data such as:

- provider credentials;
- chat/session history.

## Required invariant

> Application state and active workspace paths must never contain one another.

At startup, after both paths are fully resolved:

```text
state != workspace
state not descendant of workspace
workspace not descendant of state
```

The third rule prevents unusual parent/child configurations where the workspace is inside state.

## Implementation

Resolve in this order:

1. determine requested workspace root;
2. canonicalise/resolve it;
3. determine requested state root;
4. canonicalise/resolve it as safely as possible;
5. compare the real paths;
6. fail startup on unsafe overlap.

Avoid validating `CHAT_STATE_DIR` before the final `BUNDLE_ROOT` is known.

## Failure behaviour

If the user explicitly supplied an unsafe state path, fail with a clear error.

Do not silently move the state directory elsewhere. Silent fallback can cause the user to believe data is stored in one place while it is actually stored in another.

## Tests

```text
workspace=/srv/work
state=/srv/work/.state
    -> startup rejected

workspace=/srv/work
state=/srv
    -> startup rejected if workspace is nested inside state

workspace=/srv/work
state=/home/user/.local/state/ok-workbench
    -> accepted
```

Include symlink/canonical-path variants.

---

# SEC-08 — Replace filename-only secret protection with policy

## Problem

The current tool worker rejects several sensitive names/extensions, which is useful, but many common secret-bearing files do not match the blocklist.

Examples:

```text
.npmrc
.netrc
.pypirc
secrets.json
token.txt
.config/...
```

A model that knows an exact path may be able to request it even if navigation hides dotfiles.

## Required invariant

> Files excluded from the model's normal visibility cannot become readable merely because the model guesses their pathname.

## Recommended policy

Normal model/project access:

```text
non-hidden regular project files
+
files permitted by Workbench policy
```

Default-deny hidden files.

Keep explicit hard denials for internal control paths such as:

```text
.git/**
```

and application state.

Optionally exclude `.gitignore`-ignored files from normal model visibility.

If users need model access to a hidden file, require an explicit user grant.

## Workbench policy file

If a project-level deny file is added, for example:

```text
.ok-workbench-deny
```

ensure the agent cannot silently edit it to expand its own authority.

Treat it as policy state, not ordinary project content.

---

# SEC-11 — Do not expose API-key prefixes

## Problem

Provider-key status currently reveals an initial prefix.

There is no meaningful security benefit to doing this.

## Required behaviour

Return only a state such as:

```json
{
  "configured": true
}
```

or UI text:

```text
Configured
```

If key identification becomes necessary, prefer a very small non-secret identifier generated when the key is stored rather than characters from the secret itself.

---

# Secret storage rules

Provider keys should:

- remain outside the workspace;
- use owner-only filesystem permissions;
- never be included in generic tool environment construction;
- never appear in logs;
- never be returned by API endpoints;
- never be embedded in chat history;
- never be exposed to project code.

Consider zeroing/overwriting buffers only if it can be done reliably; in a garbage-collected JavaScript process this should not be presented as a strong guarantee.

---

# Logging

Audit logging paths for accidental secret inclusion.

Do not log:

- Authorization headers;
- provider API keys;
- tool-secret values;
- full environment dumps;
- complete request bodies that may contain secrets.

For tool execution, log capability identities, not values:

```text
secret granted: jira-token
network host granted: jira.example.com
```

not the secret contents.

---

# File permissions

Retain restrictive permissions for secret/state files.

On Unix:

```text
state directory: 0700
secret files:     0600
```

Validate existing permissions if files already exist.

On platforms where POSIX modes are not a reliable boundary, document the platform-specific behaviour.

---

# Completion criteria

This work is complete when:

- state/workspace overlap is impossible for default and custom paths;
- symlink variants cannot bypass the overlap check;
- hidden files are excluded from ordinary model capabilities;
- secret-file access requires explicit authority rather than pathname knowledge;
- provider-key API/UI status exposes no secret prefix;
- provider keys are not present in generic tool environments;
- logs do not contain secret values.
