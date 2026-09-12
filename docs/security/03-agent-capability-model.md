# Agent Capability Model

Covers:

- SEC-03 — project isolation is advisory rather than enforced;
- part of SEC-08 — hidden/secret files are reachable through path knowledge.

Primary code areas: `src/pi-harness.mjs`, `src/tool-worker.js`, server-side turn/context construction.

---

# Problem statement

The intended interaction model is project-scoped, with explicit cross-project context.

The reviewed tool interface exposes a model-controlled scope similar to:

```text
scope = "project"
scope = "workspace"
```

The LLM therefore decides whether a filesystem operation stays inside the selected project or addresses the whole workspace.

That means project isolation is a prompt convention.

A prompt injection can ask the model to perform an operation equivalent to:

```json
{
  "path": "other-project/private.md",
  "scope": "workspace"
}
```

The same issue applies to writes.

This is not acceptable as an authority boundary.

---

# Security invariant

> The model cannot enlarge its filesystem authority by changing tool arguments.

The server determines authority before the tool is called.

The model only selects operations and paths within already granted capabilities.

---

# Target model

For each turn, construct something equivalent to:

```ts
interface TurnCapabilities {
  selectedProject: {
    root: string;
    read: true;
    write: true;
  };

  extraReadGrants: Array<{
    id: string;
    canonicalPath: string;
  }>;

  extraWriteGrants?: Array<{
    id: string;
    canonicalPath: string;
  }>;
}
```

Cross-project grants should normally be read-only.

An explicit user action creates each grant.

Examples:

```text
selected project A
    -> normal project A read/write

user explicitly attaches project B/reference.md
    -> read grant for exactly B/reference.md

user attaches project B/docs/
    -> optionally a recursive read grant for that subtree

no grant
    -> project B is inaccessible
```

---

# Remove model-selectable workspace scope

Do not expose:

```json
{
  "scope": "workspace"
}
```

in filesystem tool schemas.

Preferred tool shapes:

```json
read_file({
  "path": "docs/status.md"
})
```

where paths are resolved relative to the selected project.

For explicitly granted external content, use capability identifiers rather than broader paths where practical:

```json
read_granted_file({
  "grantId": "grant-2"
})
```

or:

```json
read_file({
  "path": "@grant/grant-2"
})
```

The important property is that the model cannot manufacture a grant ID and obtain authority. The server must validate it against the current turn/session capability set.

---

# Workspace-wide operations

If workspace-wide access is a real product requirement, implement it as a distinct user-selected mode.

Example:

```text
Project mode
    selected project RW
    explicit external grants only

Workspace mode
    workspace authority deliberately granted by user
    visibly indicated in UI
```

Do not let the model switch modes.

Consider requiring a new user gesture before switching from project mode to workspace mode.

---

# Filesystem resolution

All tool paths should use a single trusted resolver.

The resolver should:

1. start from the capability root;
2. normalise the requested relative path;
3. reject absolute paths;
4. reject traversal;
5. resolve canonical parents;
6. reject symlink escapes;
7. apply hidden/secret-file policy;
8. check read/write authority;
9. return the final canonical path.

Conceptually:

```ts
resolveCapabilityPath({
  capability,
  relativePath,
  operation: "read" | "write"
})
```

Avoid having several tools reimplement path checks independently.

---

# Hidden and secret files

The previous implementation uses a useful but incomplete filename blocklist.

A stronger default is:

```text
normal project capability
    -> non-hidden project files
    -> files not denied by security policy
```

Hidden files should require explicit additional authority.

Potential policy:

```text
.git/**                 deny
.env*                   deny
*.pem                   deny
*.key                   deny
*.p12                   deny
*.pfx                   deny
.npmrc                  deny
.netrc                   deny
.pypirc                  deny
credentials*            deny
secrets*                deny unless explicitly granted
```

But do not treat an expanded blocklist as the final design.

Recommended rule:

> Hidden files are excluded from normal model capabilities.

Then add explicit user-controlled grants where needed.

Consider also respecting `.gitignore` for model visibility, but do not make `.gitignore` the only security policy because projects may intentionally track sensitive-looking configuration files.

A separate Workbench deny file may be useful, for example:

```text
.ok-workbench-deny
```

Its contents must not be model-modifiable unless the user explicitly chooses to change policy.

---

# Cross-project context

The existing explicit cross-project attachment mechanism should become a real security primitive.

When the user attaches another file:

1. resolve and canonicalise the file;
2. create a server-side read grant;
3. attach the content or grant reference to the turn;
4. expire the grant according to a defined lifetime.

Recommended lifetime:

```text
one turn
```

unless there is a deliberate UI action for a longer-lived grant.

Do not silently promote a one-turn reference into a session-wide workspace capability.

---

# Workspace tool discovery

The reviewed implementation discovers tools more broadly than the selected project.

Change discovery rules to align with capabilities.

Recommended default:

```text
selected project tools only
```

Optionally include workspace-global tools from a dedicated trusted Workbench tool directory that is distinct from project content.

Do not discover arbitrary tools from unrelated projects merely because they exist in the workspace.

---

# Sandbox mount policy

The sandbox should reflect the capability model.

Current conceptual state:

```text
entire workspace -> mounted RW
```

Target:

```text
selected project -> mounted RW

explicit external read grant(s)
    -> mounted RO at synthetic paths

application state / credentials
    -> not mounted
```

This means even a bug in higher-level tool path resolution is less likely to expose unrelated projects.

If the sandbox technology makes many individual bind mounts expensive, mount only the minimal common read-only parent required for grants, but keep writes limited to the selected project.

---

# Suggested implementation sequence

1. Create a central capability data structure.
2. Modify turn/session creation to populate it.
3. Remove `scope` from model-facing tool schemas.
4. Change filesystem tools to resolve paths through capabilities.
5. Change cross-project attachments to create explicit grants.
6. Restrict tool discovery to authorised tool roots.
7. Change Bubblewrap/Seatbelt mounts to match capabilities.
8. Add hidden-file rules.
9. Delete obsolete prompt text that tells the model when to use `"workspace"` scope.

Do not keep the old broader path as a hidden fallback.

---

# Tests

Required negative tests:

```text
Project A read "B/private.md" -> rejected.
Project A read "../B/private.md" -> rejected.
Project A symlink to B/private.md -> rejected.
Project A operation with invented grant ID -> rejected.
Project A write to explicitly read-only granted B file -> rejected.
Prompt text asking for workspace scope -> cannot change technical authority.
Hidden file ".npmrc" -> rejected by default.
Hidden file explicitly granted by user -> behaviour matches grant policy.
```

Required positive tests:

```text
Project A normal read/write -> works.
Explicit read grant to B/reference.md -> works.
Grant expires when intended -> later access rejected.
Workspace mode, if implemented -> only available after explicit user action.
```

---

# Completion criteria

This work is complete when there is no model-facing argument that can expand the filesystem trust boundary.

The implementation must make this statement true:

> A compromised or prompt-injected model can misuse the capabilities already granted to the current turn, but cannot acquire access to another project or hidden file by choosing a different scope or path.
