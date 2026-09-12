# OK Workbench Security Remediation Pack

Date: 2026-09-05

This pack turns the static security review of `edoloughlin/ok-workbench` into an implementation-oriented set of tasks for a local coding LLM.

The review was source-based. It did not include a live penetration test, fuzzing, a local `npm audit`, or an attempted Bubblewrap/Seatbelt escape. Before changing code, verify the referenced implementation details against the current checkout.

## Security findings

| ID | Severity | Finding | Primary implementation file |
|---|---|---|---|
| SEC-01 | High | DNS rebinding permits remote websites to read workspace content | `02-http-and-browser-security.md` |
| SEC-02 | High | Workspace tool manifests can self-authorise secrets and unrestricted network access | `04-workspace-tool-security.md` |
| SEC-03 | High | Project-scoped filesystem isolation is advisory, not enforced | `03-agent-capability-model.md` |
| SEC-04 | High | Workspace SVG files can execute JavaScript with application-origin authority | `02-http-and-browser-security.md` |
| SEC-05 | Medium | State-directory containment uses the wrong workspace root | `05-state-secrets-and-storage.md` |
| SEC-06 | Medium | Workspace tools have weak CPU/memory/process/disk containment | `04-workspace-tool-security.md` |
| SEC-07 | Medium | Browser-facing document/asset handlers read whole files before applying limits | `02-http-and-browser-security.md` |
| SEC-08 | Medium/Low | Secret-file protection is a blocklist with significant gaps | `03-agent-capability-model.md`, `05-state-secrets-and-storage.md` |
| SEC-09 | Low | GitHub Actions supply-chain controls should be hardened | `06-ci-dependencies-and-docs.md` |
| SEC-10 | Low | IPv6 localhost `Host` parsing is broken | `02-http-and-browser-security.md` |
| SEC-11 | Low | Provider-key prefix disclosure is unnecessary | `05-state-secrets-and-storage.md` |
| SEC-12 | Low | Security documentation contradicts the actual macOS design | `06-ci-dependencies-and-docs.md` |

## Model strategy

Use the least expensive model that is appropriate for the security reasoning required by the current phase.

### Default model

Use:

```text
GPT-5.6 Terra
reasoning effort: high
```

for implementation unless a phase below explicitly says otherwise.

The remediation documents already provide the security invariants, target architecture, negative cases, positive cases, and completion criteria. Terra should therefore implement most phases reliably without requiring the more expensive models to rediscover the design.

### Use GPT-5.6 Sol for architectural review

Use:

```text
GPT-5.6 Sol
reasoning effort: high or xhigh
```

for independent review of:

- `03-agent-capability-model.md`;
- `04-workspace-tool-security.md`;
- the final whole-repository security review.

For those two architectural phases, the preferred workflow is:

```text
Terra/high
    |
    +-- inspect
    +-- implement
    +-- test
    |
    v
STOP
    |
    v
Sol/high or xhigh
    |
    +-- review the completed diff
    +-- attempt to violate the stated security invariants
    +-- identify missing enforcement paths
    |
    v
STOP
    |
    v
Terra/high
    |
    +-- implement review findings
    +-- rerun tests
```

Do not use Sol to perform routine implementation unless Terra encounters a genuine design ambiguity or repeatedly fails to satisfy an invariant.

### Optional lower-cost model

GPT-5.6 Luna may be used for mechanical work only, such as:

- pinning GitHub Actions after the required SHAs are known;
- straightforward documentation edits;
- repetitive test scaffolding after the test design is already specified;
- simple lint or formatting corrections.

Do not use Luna for:

- the agent capability redesign;
- workspace-tool privilege design;
- sandbox/network policy;
- secret-authorisation logic;
- final security review.

### GPT-6 Astra

GPT-6 Astra is not required for this remediation plan.

If available and token allowance permits, it may be used for an optional final independent security review after all phases and Sol review are complete. It should not be the default implementation model.

## Phase/model matrix

| Phase | Work | Implementation model | Independent review |
|---|---|---|---|
| 1 | HTTP, Host validation, SVG, file streaming | Terra/high | Terra/high |
| 2 | Agent filesystem capability model | Terra/high | **Sol/high or xhigh** |
| 3 | Workspace-tool privilege model and resource isolation | Terra/high | **Sol/high or xhigh** |
| 4 | State, hidden files, secret handling | Terra/high | Terra/high |
| 5 | CI and documentation | Terra/medium or Luna | None normally required |
| 6 | Adversarial security regression tests | Terra/high | Sol/high for coverage gaps |
| Final | Whole-repository security assessment | — | **Sol/xhigh** |

## Recommended implementation order

Implement the work in the order below.

1. `02-http-and-browser-security.md`
   - globally validate `Host`;
   - stop serving active SVG on the privileged application origin;
   - fix Host parsing;
   - cap/stream file reads.

2. `03-agent-capability-model.md`
   - remove model-controlled workspace scope;
   - implement server-issued per-turn capabilities;
   - constrain cross-project reads and writes.

3. `04-workspace-tool-security.md`
   - change tool manifests from self-authorising permissions to declared requirements;
   - introduce an external approval store;
   - separate tool secrets from provider credentials;
   - improve network and resource isolation.

4. `05-state-secrets-and-storage.md`
   - fix state/workspace containment;
   - tighten hidden/secret-file access;
   - remove provider-key prefix disclosure.

5. `06-ci-dependencies-and-docs.md`
   - harden GitHub Actions;
   - align security documentation with the actual implementation and threat model.

6. `07-adversarial-security-tests.md`
   - encode the security invariants as regression tests.

## Mandatory stop-and-handoff rule

The coding model must work on **one phase only**.

After completing the current phase, it must stop. It must not begin the next phase in the same run unless the user explicitly asks it to do so.

At the end of each phase, the model must report:

1. what it changed;
2. which tests it added or changed;
3. which commands it ran and whether they passed;
4. any remaining risk or uncertainty;
5. any deviation from the remediation specification;
6. the exact next phase;
7. the model and reasoning effort recommended for that next step.

Use this format:

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
- <phase or review action>

Recommended model:
- <model>
- reasoning effort: <level>
```

For Phase 2 and Phase 3, the next step after Terra implementation is **not** the following implementation phase. It is an independent Sol review of the completed diff.

Example:

```text
Phase complete: Agent capability model

STOPPED before starting workspace-tool security.

Next step:
- Review the Phase 2 diff against every invariant in
  03-agent-capability-model.md and the corresponding adversarial tests.
- Do not modify code during the first review pass. Identify bypasses and missing
  enforcement paths first.

Recommended model:
- GPT-5.6 Sol
- reasoning effort: xhigh
```

After Sol review, stop again and tell the user to switch back to Terra/high to implement the review findings.

## Context-efficiency rule

Do not load the entire remediation pack for every phase.

For each implementation run, read:

```text
00-README.md
the current phase specification
the relevant sections of 07-adversarial-security-tests.md
```

Read `01-overall-remediation-plan.md` when deciding phase order, stop conditions, or model handoff.

For a Sol review, read:

```text
00-README.md
the completed phase specification
the relevant sections of 07-adversarial-security-tests.md
the git diff for that phase
the current source files touched by the diff
```

Do not spend context rereading unrelated phase documents.

## Core architectural rule

Do not use model instructions as an authority boundary.

The model may decide **how** to use capabilities that the application grants. It must not be able to enlarge those capabilities by choosing a broader tool parameter, selecting a different project, requesting an environment variable, or enabling unrestricted network access.

Target model:

```text
                       application state
                     credentials / approvals
                              |
                              | never mounted
                              v
+----------------------------------------------------+
|                    OK Workbench                    |
|                                                    |
| user-selected / server-issued capabilities         |
|          |                                         |
|          v                                         |
|  +----------------+       +---------------------+  |
|  | selected       |       | explicit read      |  |
|  | project        |       | grants             |  |
|  | RW             |       | RO by default      |  |
|  +-------+--------+       +----------+----------+  |
|          |                           |             |
+----------|---------------------------|-------------+
           |                           |
           v                           v
       agent sandbox               agent sandbox

tool requirements
      |
      v
external approval store
      |
      +---- secret X approved?
      +---- network host Y approved?
      +---- executable hash unchanged?
```

## Non-goals

Unless the project requirements change, this remediation pack does not attempt to defend against:

- a malicious process already running as the same Unix user;
- a compromised operating-system kernel;
- a Bubblewrap or Seatbelt kernel-level escape;
- malicious upstream package registries beyond the package-pinning and supply-chain controls described here.

## Working method for a coding LLM

For each file in this pack:

1. Inspect the current repository before changing anything.
2. Map the described code paths to the current implementation.
3. Make the smallest architectural change that enforces the required invariant.
4. Add tests before or with the implementation.
5. Run the existing test suite.
6. Run any relevant static analysis or audit commands.
7. Record deviations where the current checkout differs from this review.
8. Stop at the end of the current phase.
9. Tell the user exactly what should happen next and which model/reasoning effort should be used.

Do not weaken an existing security control to make a new test pass.
