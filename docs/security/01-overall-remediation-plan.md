# Overall Security Remediation Plan

## Implementation status (2026-09-12)

- **Phase 1 — complete.** The HTTP authority, untrusted-asset origin, and
  bounded-file-read work landed in commits `e6392bd` and `7c89fc0`.
- **Phase 2 — implementation complete; independent review pending.** The
  current worktree replaces model-selectable workspace scope with
  server-created selected-project capabilities and staged, per-turn read
  grants.
- **Phase 3 — implementation complete; independent review pending.** The
  current worktree makes tool manifests declarative, adds hash-bound
  state-directory approvals and separately managed tool secrets, denies
  network pending a host-filtering broker, and applies Linux resource limits.
- **Phases 4–6 — not started.** Do not begin them until the required Phase 2
  and Phase 3 reviews have been completed and their findings addressed.

The plan originally required a stop and review between Phases 2 and 3. Since
the current worktree contains both implementation phases, review them as two
separate boundary assessments from the same diff: first project capability
isolation, then workspace-tool authority. Do not treat the presence of tests
as a substitute for those independent reviews.

## Objective

Change OK Workbench from a system where several security boundaries are enforced by conventions and model instructions into one where authority is enforced by application code and sandbox configuration.

The highest-priority changes concern four boundaries:

1. browser -> local HTTP server;
2. untrusted workspace content -> privileged application origin;
3. model -> filesystem/project authority;
4. workspace tool -> secrets/network/process authority.

## How to execute this plan

Work on one phase at a time.

Do not continue automatically from one phase to the next.

At the end of every phase:

1. stop making changes;
2. report what changed;
3. report tests and command results;
4. report remaining risks or unresolved questions;
5. identify the next required action;
6. tell the user which model and reasoning effort should perform that action.

Use:

```text
GPT-5.6 Terra / high
```

as the default implementation model.

Use:

```text
GPT-5.6 Sol / high or xhigh
```

for architectural review of Phase 2 and Phase 3 and for the final repository-wide security review.

GPT-5.6 Luna may be used only for mechanical low-risk work in Phase 5 or similarly deterministic tasks.

Do not use GPT-6 Astra by default. It is optional for a final independent review if the user wants additional assurance and has sufficient token allowance.

### Required end-of-phase response

At the end of each phase, produce:

```text
Phase complete: <phase name>

Implemented:
- ...

Verification:
- ...

Remaining issues:
- ...

STOPPED before starting the next phase.

Next step:
- ...

Recommended model:
- ...
- reasoning effort: ...
```

For phases that require independent review, the review is the next step. Do not skip directly to the next implementation phase.

---

## Phase 1 — Close remotely reachable browser/server issues

### Model

Implementation:

```text
GPT-5.6 Terra
reasoning effort: high
```

Independent Sol review is not normally required.

### Findings

- SEC-01: DNS rebinding permits workspace reads.
- SEC-04: same-origin SVG can execute with application API authority.
- SEC-07: document and asset routes can consume excessive memory.
- SEC-10: IPv6 Host parsing is incorrect.

### Required outcome

Every request to the local HTTP server must be rejected unless its authority/Host resolves to an allowed loopback host.

Untrusted workspace content must not execute as active content in the privileged Workbench origin.

Large files must not be read fully into memory merely to determine whether they should be previewed.

### Completion gate

Do not start major new agent features until Phase 1 is complete.

Required tests:

```text
Host attacker.invalid can read nothing.
Host attacker.invalid cannot obtain session or CSRF state.
Top-level navigation to a workspace SVG cannot execute application-origin JavaScript.
Large Markdown/code/assets are bounded or streamed.
IPv4 and IPv6 loopback Host forms are accepted correctly.
```

See `02-http-and-browser-security.md`.

### Stop condition

After implementation and tests pass:

- stop;
- do not start Phase 2;
- tell the user that Phase 2 is the next step;
- recommend `GPT-5.6 Terra / high` for Phase 2 implementation.

---

## Phase 2 — Make project isolation a real capability boundary

### Model

Implementation:

```text
GPT-5.6 Terra
reasoning effort: high
```

Mandatory independent review:

```text
GPT-5.6 Sol
reasoning effort: xhigh
```

Use `high` instead of `xhigh` only if token budget is tight.

### Findings

- SEC-03: the LLM can choose `scope: "workspace"`.
- SEC-08: model-readable hidden/secret files are protected mostly by a filename blocklist.

### Required outcome

The model cannot widen its own filesystem authority.

A turn receives a server-created capability set consisting of:

- the selected project's normal read/write authority;
- explicit additional read grants, created by a user action such as attaching or referencing another project file;
- no general workspace authority unless the user deliberately enters a separate workspace-wide mode.

The filesystem tool API must not expose a model-selectable `"workspace"` scope.

### Completion gate

A prompt-injected model operating in Project A must be technically unable to read or write Project B unless a corresponding server-issued capability exists.

See `03-agent-capability-model.md`.

### Stop condition after Terra implementation

After implementation and tests pass:

- stop;
- do not start Phase 3;
- tell the user that the next step is an independent security review of the Phase 2 diff;
- recommend `GPT-5.6 Sol / xhigh`.

The Sol review should:

1. inspect the complete Phase 2 diff;
2. inspect all touched filesystem/tool/sandbox paths;
3. attempt to find alternate routes to Project B;
4. verify that the sandbox mounts match the logical capability model;
5. verify that no model-facing argument can expand authority;
6. produce findings first, without changing code during the first review pass.

### Stop condition after Sol review

After the review:

- stop;
- do not start Phase 3;
- if findings exist, tell the user to switch back to `GPT-5.6 Terra / high` to implement them;
- if there are no findings, tell the user Phase 3 is ready to begin with `GPT-5.6 Terra / high`.

---

## Phase 3 — Rebuild workspace-tool permissions

### Model

Implementation:

```text
GPT-5.6 Terra
reasoning effort: high
```

Mandatory independent review:

```text
GPT-5.6 Sol
reasoning effort: xhigh
```

Use `high` instead of `xhigh` if token budget is tight.

### Findings

- SEC-02: a workspace-controlled manifest can request environment secrets and network access.
- SEC-06: tool processes lack strong CPU/memory/process/disk containment.

### Required outcome

A tool manifest describes **requirements**, not permissions.

Privilege comes from a Workbench-controlled approval record stored outside the workspace.

A tool must not be able to grant itself:

- provider API keys;
- arbitrary server environment variables;
- unrestricted network access;
- access to unrelated projects.

Approvals must become invalid when the tool or its manifest changes.

Normal workspace tools should receive resource controls comparable to the dedicated Python runner.

### Completion gate

A newly imported project containing a malicious tool and manifest must be harmless until the user explicitly grants the required capabilities.

See `04-workspace-tool-security.md`.

### Stop condition after Terra implementation

After implementation and tests pass:

- stop;
- do not start Phase 4;
- tell the user the next step is an independent Phase 3 security review;
- recommend `GPT-5.6 Sol / xhigh`.

The Sol review should specifically attempt to bypass:

```text
tool approval
provider-secret isolation
network restrictions
tool hash binding
filesystem mount restrictions
process-tree/resource containment
```

It must verify actual enforcement, not merely metadata or prompt instructions.

### Stop condition after Sol review

After the review:

- stop;
- if findings exist, recommend `GPT-5.6 Terra / high` to implement them;
- if there are no findings, recommend `GPT-5.6 Terra / high` for Phase 4.

---

## Phase 4 — Fix state and secret handling

### Model

Implementation:

```text
GPT-5.6 Terra
reasoning effort: high
```

Independent Sol review is not normally required.

### Findings

- SEC-05: state containment is checked against `~/workspace`, not the resolved workspace.
- SEC-08: secret access is blocklist-based.
- SEC-11: API-key prefixes are disclosed unnecessarily.

### Required outcome

Application state and provider credentials can never be placed inside or above the active workspace.

Hidden files and files ignored for security reasons should not automatically become model-readable merely because the model knows their path.

Provider-key status should reveal only whether a key is configured.

See `05-state-secrets-and-storage.md`.

### Stop condition

After implementation and tests pass:

- stop;
- do not start Phase 5;
- tell the user that Phase 5 is next;
- recommend `GPT-5.6 Terra / medium`.

If the Phase 5 work is limited to mechanical workflow pinning and documentation edits, `GPT-5.6 Luna` is acceptable.

---

## Phase 5 — CI and documentation hardening

### Model

Preferred:

```text
GPT-5.6 Terra
reasoning effort: medium
```

Acceptable for mechanical changes:

```text
GPT-5.6 Luna
```

Do not use Luna if current CI or security documentation has materially diverged from the remediation specification and requires security reasoning.

### Findings

- SEC-09: actions are pinned to mutable major tags and CI lacks a minimal top-level permission declaration.
- SEC-12: the security documentation describes platform isolation inconsistently.

### Required outcome

CI uses least privilege and immutable action references.

Security documentation accurately states:

- what Bubblewrap protects;
- what macOS Seatbelt protects;
- what remains outside the threat model;
- what workspace/project content is treated as untrusted;
- what user approval means for tool privileges.

See `06-ci-dependencies-and-docs.md`.

### Stop condition

After implementation and CI/tests pass:

- stop;
- do not start Phase 6;
- tell the user that adversarial regression testing is next;
- recommend `GPT-5.6 Terra / high`.

---

## Phase 6 — Turn the threat model into executable tests

### Model

Implementation:

```text
GPT-5.6 Terra
reasoning effort: high
```

After the suite is complete, use:

```text
GPT-5.6 Sol
reasoning effort: high
```

to look for missing adversarial cases before final review.

### Required work

Add tests for security invariants instead of only tests for ordinary behaviour.

Priority invariants:

```text
Host attacker.invalid can read nothing.

Project A cannot read Project B without a server-issued grant.

The model cannot enlarge its own filesystem scope.

A project cannot grant its own tool access to provider credentials.

A project cannot grant its own tool unrestricted network access.

Changing an approved tool invalidates its approval.

Untrusted SVG/HTML cannot execute with application API authority.

State can never be nested under BUNDLE_ROOT.

A sandbox timeout terminates the entire descendant process tree.

Large files cannot cause unbounded application memory use.
```

See `07-adversarial-security-tests.md`.

### Stop condition after Terra implementation

After the adversarial suite passes:

- stop;
- tell the user that the next step is a coverage review;
- recommend `GPT-5.6 Sol / high`.

The Sol coverage review should identify:

- missing bypass paths;
- security properties tested only at unit level when integration coverage is needed;
- OS-specific assumptions not exercised by CI;
- tests that merely mirror the implementation instead of independently checking the invariant.

### Stop condition after coverage review

After the coverage review:

- stop;
- if gaps exist, recommend `GPT-5.6 Terra / high` to add the missing tests/fixes;
- if there are no material gaps, recommend the final whole-repository review with `GPT-5.6 Sol / xhigh`.

---

## Final whole-repository security review

### Model

Use:

```text
GPT-5.6 Sol
reasoning effort: xhigh
```

If token budget is constrained, `high` is acceptable.

GPT-6 Astra may be used instead for an optional additional independent review, but it is not required.

### Review instructions

Do not begin by modifying code.

First:

1. read the threat model;
2. inspect the full security remediation diff;
3. inspect the final current source, not only the diff;
4. attempt to violate each release invariant;
5. inspect boundary interactions between HTTP, model capabilities, tool approvals, secrets, sandbox mounts and process execution;
6. identify regressions or newly introduced authority paths.

Only after presenting review findings should implementation fixes be started, preferably in a new Terra/high run.

### Final stop condition

At the end of review:

- stop;
- report findings by severity;
- if findings exist, recommend `GPT-5.6 Terra / high` for implementation of the findings;
- if no material findings remain, state that the planned remediation is complete subject to any documented residual risks and platform-specific manual tests.

---

# Architecture decisions that should be explicit

## 1. Is a workspace trusted?

Recommended answer: **No.**

Opening a project should not imply trust in:

- its `AGENTS.md`;
- its tools;
- its tool manifests;
- SVG/HTML/PDF content;
- hidden files;
- cross-project references.

`AGENTS.md` can influence model behaviour, but it must not influence application authority.

## 2. Is a selected project trusted?

Recommended answer: trusted for normal project read/write operations initiated through the Workbench, but not trusted to grant execution, network or secret privileges.

## 3. Can the model ever operate workspace-wide?

If needed, provide a distinct user-selected mode.

Do not expose a tool parameter that lets the model decide whether the operation is project-scoped or workspace-scoped.

## 4. What is a workspace tool manifest?

Recommended answer: declarative requirements.

Example:

```json
{
  "runtime": "node",
  "network": {
    "hosts": ["jira.example.com"]
  },
  "secrets": ["jira-token"],
  "timeoutSeconds": 60
}
```

This does not mean the tool receives those capabilities. It means Workbench must compare the requirements with an external approval policy.

## 5. Where are approvals stored?

Outside the workspace and outside any path the agent can read or modify.

A suitable record should bind approval to the tool contents:

```json
{
  "toolPath": "project-a/tools/jira-sync.js",
  "toolSha256": "...",
  "manifestSha256": "...",
  "approvedSecrets": ["jira-token"],
  "approvedNetworkHosts": ["jira.example.com"],
  "approvedFilesystemRoots": ["project-a"],
  "approvedAt": "..."
}
```

Changing the executable or manifest must invalidate the approval.

---

# Context-efficiency guidance

Do not give every phase the entire remediation pack.

For a normal implementation run, load:

```text
00-README.md
01-overall-remediation-plan.md
the current phase document
the relevant sections of 07-adversarial-security-tests.md
```

If context budget is especially tight, `01-overall-remediation-plan.md` may be omitted after the model has been told the current phase and stop condition, because `00-README.md` contains the common operating rules.

For a Phase 2 or Phase 3 Sol review, load only:

```text
00-README.md
the relevant phase document
the relevant adversarial-test sections
the completed git diff
the touched source files
```

Use a fresh Codex session for each phase or review where practical.

This reduces:

- repeated context consumption;
- accidental work on later phases;
- long-session drift;
- confusion between implementation and review roles.

---

# Release criteria

Before considering the remediation complete:

- all existing tests pass;
- all tests in `07-adversarial-security-tests.md` pass;
- `npm audit --omit=dev` reports no unresolved high/critical production vulnerabilities, or each exception is documented;
- the application starts safely with default and custom workspace/state paths;
- Linux sandbox behaviour is tested on a system with Bubblewrap installed;
- macOS behaviour is tested separately and documented according to the actual guarantees;
- provider secrets cannot be exposed to generic workspace tools;
- untrusted active workspace content cannot run in the privileged web origin;
- Phase 2 received an independent Sol security review;
- Phase 3 received an independent Sol security review;
- the final repository received an independent Sol security review.

The final reviewer must make a clear distinction between:

```text
implemented and mechanically verified
```

and:

```text
residual risk / platform limitation / manual verification still required
```
