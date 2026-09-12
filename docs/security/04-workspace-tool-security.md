# Workspace Tool Security

Covers:

- SEC-02 — workspace manifests self-authorise secrets and network;
- SEC-06 — weak resource containment for workspace tools;
- additional supply-chain hardening for Python/tool execution.

Primary code areas: `src/pi-harness.mjs`, `src/tool-worker.js`, `src/python-runner.mjs`, tool manifest parsing and server configuration.

---

# 1. Redefine the manifest: requirements, not permission

## Problem

A project-controlled `.tool.json` can currently request capabilities such as:

```json
{
  "environment": ["JIRA_API_TOKEN"],
  "network": true,
  "timeoutSeconds": 120
}
```

The same project contains the executable.

If Workbench accepts those fields as authority, the untrusted object asking for privilege is also defining its own permission.

This is especially dangerous because the environment available to the harness includes normal process environment values and saved provider credentials.

## Required invariant

> A workspace-controlled manifest can state what a tool needs, but only Workbench-controlled state can grant those privileges.

---

# 2. Introduce an external approval store

Store approvals outside:

- the workspace;
- the selected project;
- paths mounted into agent/tool sandboxes.

Example approval:

```json
{
  "toolPath": "project-a/tools/jira-sync.js",
  "toolSha256": "…",
  "manifestSha256": "…",
  "approvedSecrets": ["jira-token"],
  "approvedNetworkHosts": ["jira.example.com"],
  "approvedFilesystemRoots": ["project-a"],
  "approvedAt": "2026-09-05T00:00:00Z"
}
```

## Approval identity

At minimum bind approval to:

```text
canonical tool path
SHA-256(tool contents)
SHA-256(manifest contents)
requested secret identities
requested network policy
filesystem scope
```

Changing either executable or manifest invalidates the approval.

A rename should normally invalidate or require explicit migration.

---

# 3. Separate provider credentials from tool secrets

## Problem

Provider API keys are application credentials. They should never be generic server environment values from the point of view of project tools.

## Required invariant

> Generic workspace tools cannot request OpenAI/Anthropic/other provider credentials by environment-variable name.

## Implementation

Keep at least two logical stores:

```text
Workbench provider credentials
    used only by model-provider integration

Workspace tool secrets
    individually named user-managed secrets
    independently approved per tool
```

Do not implement tool-secret access as:

```js
process.env[manifestRequestedName]
```

against the complete server environment.

Instead, resolve a logical secret name through a dedicated secret store:

```json
{
  "secrets": ["jira-token"]
}
```

Then inject only the explicitly approved value.

Do not expose names such as:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
...
```

as requestable tool secrets unless there is an exceptional, explicit product feature for that exact purpose.

---

# 4. Replace boolean network access with an egress policy

## Problem

`network: true` effectively removes the network namespace restriction.

That grants more than most tools need.

## Target manifest

Prefer:

```json
{
  "network": {
    "hosts": [
      "jira.example.com"
    ]
  }
}
```

Optional future fields:

```json
{
  "network": {
    "hosts": ["jira.example.com"],
    "ports": [443]
  }
}
```

## Required defaults

Block:

```text
127.0.0.0/8
::1
RFC1918 private networks
link-local networks
cloud metadata addresses
host-local services
```

unless explicitly approved for a well-defined use case.

If Bubblewrap alone cannot provide host-level egress filtering, add another mechanism such as:

- a controlled proxy;
- network namespace + firewall rules;
- a broker process that performs approved outbound requests;
- another OS-native policy layer.

A broker/proxy is often easier to reason about than granting general network access.

---

# 5. Tool approval UX

A tool requiring privilege should cause an explicit user-visible approval flow.

Example:

```text
Tool: jira-sync.js
Hash: <short fingerprint>

Requests:
  - read/write selected project
  - network: jira.example.com:443
  - secret: jira-token
  - timeout: 60 s

[Approve this version] [Deny]
```

The model cannot approve this request.

Do not automatically approve because:

- the manifest exists;
- the project is under Git;
- `AGENTS.md` says the tool is trusted;
- the tool has run before if its hash changed.

---

# 6. Restrict filesystem mounts

Normal tool default:

```text
selected project -> RW
```

Optional explicit mounts:

```text
specific granted file/subtree -> RO
```

Do not mount the complete workspace RW unless the user has deliberately approved a workspace-wide tool.

Application state and credentials must never be mounted.

---

# 7. Resource containment

## Problem

The dedicated Python runner already uses stronger limits such as `prlimit`, but normal workspace tools mainly rely on a wall-clock timeout.

A malicious or buggy tool can attempt:

- memory exhaustion;
- CPU exhaustion;
- process/fork exhaustion;
- file descriptor exhaustion;
- large file generation;
- child processes surviving simple parent termination.

## Linux target

Where available, use cgroup v2 for the whole tool process tree.

Suggested controls:

```text
memory.max
pids.max
cpu.max
```

Also consider:

```text
RLIMIT_AS
RLIMIT_CPU
RLIMIT_FSIZE
RLIMIT_NOFILE
RLIMIT_NPROC
```

Cgroups are preferable for process-tree containment because limits follow descendants.

## Timeout termination

Launch each tool in its own process group/session.

On timeout:

1. send termination to the whole group;
2. wait briefly;
3. send `SIGKILL` to remaining descendants;
4. clean up sandbox state.

A timeout must not leave background descendants running.

## Writable disk

The writable project is itself a possible disk-exhaustion target.

Options:

- cgroup/io controls where appropriate;
- filesystem quota;
- limited scratch filesystem;
- output-size checks;
- reject huge promoted artifacts.

Document the remaining limitation if project disk quota is not practical.

---

# 8. Align normal tools with the Python runner

Retain the strong Python-runner properties:

- package-name allowlist;
- reject package URLs/local paths/pip flags;
- copy explicit inputs into sandbox;
- no implicit project visibility;
- dependency installation separated from execution;
- no network in execution sandbox;
- explicit artifact promotion;
- reject symlink inputs/outputs;
- never overwrite existing project files without an explicit controlled operation;
- CPU/memory/file limits.

Apply equivalent principles to Node/Python workspace tools where possible.

---

# 9. Python package reproducibility

The package allowlist prevents arbitrary package-name selection but unpinned versions can change over time.

For higher assurance, maintain an approved package set with fixed versions.

Example:

```json
{
  "numpy": "2.3.2",
  "pandas": "2.3.1"
}
```

Higher-assurance option:

- lock hashes;
- maintain an internal wheel cache;
- verify package hashes before install.

This is supply-chain hardening, not the first remediation priority.

---

# 10. Tool discovery

Default discovery should be limited to:

```text
selected project tools
+
optional trusted Workbench-global tools
```

Do not automatically discover executable tools in unrelated projects.

A trusted global tool directory should live outside normal project content so it cannot be replaced by a project import.

---

# Tests

## Self-authorisation

A project contains:

```json
{
  "secrets": ["provider-key"],
  "network": {
    "hosts": ["attacker.example"]
  }
}
```

Expected:

```text
No approval -> tool does not receive secret or network.
```

## Provider-key isolation

A manifest requests:

```text
OPENAI_API_KEY
```

Expected:

```text
Rejected as an invalid generic tool secret identity.
```

## Hash invalidation

1. approve tool version A;
2. run succeeds;
3. change one byte;
4. run again.

Expected:

```text
approval invalidated
explicit re-approval required
```

## Network

Approved host:

```text
jira.example.com:443 -> allowed
```

Unapproved:

```text
attacker.example -> blocked
127.0.0.1 -> blocked
169.254.169.254 -> blocked
private LAN target -> blocked by default
```

## Resources

Test a deliberately abusive tool:

- infinite loop;
- allocate memory repeatedly;
- fork children;
- create a large file;
- spawn a sleeping child and exceed timeout.

Expected:

```text
limits activate
whole process tree is terminated
Workbench remains responsive
```

---

# Completion criteria

This work is complete when:

- a project cannot grant itself any secret;
- a project cannot grant itself networking;
- provider credentials are inaccessible to generic tools;
- approvals are stored outside and inaccessible from the workspace;
- approvals are hash-bound and invalidated by changes;
- normal tools are project-scoped by default;
- network policy is narrower than a boolean `true`;
- CPU/memory/process/file limits exist;
- timeout kills all descendants.
