# OK Workbench Security Review — Updated Analysis

Date: 2026-10-01

Repository: `https://github.com/edoloughlin/ok-workbench`

This review repeats the earlier static security assessment against the current `main` branch after several remediation changes and the addition of new functionality.

This is a static source review, not a penetration test. It does not include live exploitation, fuzzing, a full local dependency audit, or an attempted Bubblewrap/Seatbelt escape.

## Overall assessment

The security posture is materially better than in the first review.

The four original high-severity findings have largely been addressed. The current design now has:

- global Host validation;
- a separate asset origin for untrusted workspace content;
- server-enforced project capabilities;
- explicit external read grants;
- workspace-tool approval records;
- separation of provider credentials from tool secrets;
- fail-closed tool networking;
- stronger process/resource limits;
- process-group termination on timeout.

The most important architectural improvement is that filesystem and tool authority are now enforced in application code rather than mainly by model instructions.

I found no critical issue and no obvious remotely exploitable issue in the current design.

The remaining findings are:

| ID | Severity | Finding |
|---|---:|---|
| R2-01 | Medium | Application state can still be placed inside a custom workspace; canonicalisation is incomplete |
| R2-02 | Medium | Workspace-tool hash verification has a TOCTOU window before interpreter execution |
| R2-03 | Low | Provider-key prefixes are still returned to the UI |
| R2-04 | Low | CI still uses mutable GitHub Action tags and lacks explicit least-privilege permissions |
| R2-05 | Low | Security/threat-model documentation is materially behind the implementation |
| R2-06 | Design note | Future network egress implementation must validate resolved IPs, not only hostname syntax |

## Previous findings: current status

| Previous finding | Current status |
|---|---|
| SEC-01 DNS rebinding | Fixed |
| SEC-02 manifests self-authorise secrets/network | Fixed architecturally |
| SEC-03 model can select workspace filesystem scope | Fixed |
| SEC-04 same-origin active SVG | Fixed |
| SEC-05 state-directory containment | Still present |
| SEC-06 weak tool resource containment | Substantially fixed |
| SEC-07 unbounded file reads | Fixed |
| SEC-08 secret/hidden-file protection | Substantially fixed |
| SEC-09 CI hardening | Still present |
| SEC-10 IPv6 Host parsing | Fixed |
| SEC-11 API-key prefix disclosure | Still present |
| SEC-12 inaccurate security docs | Still present / now more stale |

# Improvements since the previous review

## HTTP / DNS-rebinding boundary

Host validation is now applied before normal route dispatch rather than only to chat or mutation endpoints.

The authority parser accepts only expected local forms such as:

```text
localhost
127.0.0.1
[::1]
```

with optional valid ports.

The asset server applies the same validation.

This closes the previous DNS-rebinding workspace-read path and fixes the earlier IPv6 parsing issue.

## SVG and untrusted browser content

Workspace assets are now served from a separate origin.

The asset server applies restrictive response headers including a CSP equivalent to:

```text
default-src 'none';
script-src 'none';
object-src 'none';
connect-src 'none';
frame-ancestors 'none';
sandbox
```

along with `nosniff` and a restrictive referrer policy.

Assets are streamed instead of fully buffered.

This is a stronger solution than rendering SVG as source because SVG image preview can be retained while active workspace content no longer executes in the privileged Workbench application origin.

## Project capability enforcement

The previous model-controlled:

```text
scope: "workspace"
```

escape path appears to have been removed.

The current design creates an application-side capability model for the selected project and any explicit read grants.

The worker operates against the selected project root rather than allowing the model to select arbitrary workspace scope.

This changes the trust boundary from:

```text
model instructions decide scope
```

to:

```text
application grants scope
model operates inside granted scope
```

That is the correct direction for prompt-injection resistance.

## Hidden and sensitive files

The worker now rejects hidden and security-sensitive path components rather than relying only on navigation hiding.

Examples include:

```text
.git
.env*
.npmrc
.netrc
.pypirc
private key files
credential-like files
secret-like files
```

Canonical symlink aliases into such paths are also checked.

This substantially improves the previous secret-file protection model.

## Workspace-tool approval model

Workspace-tool manifests now behave more like requirements than permissions.

Approvals bind to properties including:

```text
canonical project root
tool path
tool hash
manifest hash
requested requirements
selected-project write authority
```

A tool requires explicit approval before execution.

Provider-looking secret names are rejected, and logical tool secrets are mapped to dedicated Workbench tool-secret environment names instead of exposing arbitrary process environment variables.

This addresses the previous self-authorisation problem.

## Workspace-tool discovery

Tool discovery is now constrained to executable files in the selected project's tool area rather than broadly discovering tools across unrelated projects.

This aligns discovery more closely with the project capability boundary.

## Network policy

Workspace tools currently fail closed for network access instead of simply enabling the host network namespace.

This is a good interim design.

It is preferable to shipping a weak hostname allowlist that is not yet enforced correctly.

## Resource containment

Workspace tools now use process resource limits such as:

```text
address-space limit
CPU limit
process-count limit
file-descriptor limit
file-size limit
```

They also execute in their own process group.

On timeout, the process group is terminated rather than killing only the direct child.

This substantially fixes the earlier process/resource containment weakness.

## Python runner

The dedicated Python runner remains one of the stronger parts of the system.

Its security properties include:

- package allowlisting;
- explicit input handling;
- network separation between dependency installation and execution;
- no network during normal code execution;
- explicit output promotion;
- symlink rejection;
- resource limits;
- narrow sandbox mounts.

# R2-01 — State-directory isolation is still incomplete

Severity: **Medium**

This is the most important remaining finding.

## Problem

The configured application state directory is still validated against a hard-coded path based on:

```text
~/workspace
```

before the actual active workspace root is resolved.

This means a custom workspace can still contain the configured state directory.

Example:

```text
workspace = /srv/ok-workspace
state     = /srv/ok-workspace/state
```

This may pass the existing validation because `/srv/ok-workspace` is unrelated to the hard-coded default workspace path.

The state directory contains privileged application information such as:

- provider API keys;
- tool secrets;
- tool approvals;
- chat threads;
- external-link approvals;
- runtime settings;
- workspace-review state.

This makes state/workspace overlap a significant boundary error.

## Additional canonicalisation issue

External-link protection treats the state directory as a denied root, but path comparison appears to use a resolved lexical path rather than a canonical `realpath()` representation.

If the state directory itself is a symlink, a target referring to the canonical destination may not match the denied root.

## Required invariant

```text
state != workspace

state is not inside workspace

workspace is not inside state
```

The comparison must use canonical paths.

## Recommended implementation

Resolve paths in this order:

```text
requested workspace
    |
    v
canonical workspace
    |
    v
requested state
    |
    v
canonical state
    |
    +--> reject if equal
    +--> reject if state below workspace
    +--> reject if workspace below state
```

Store and reuse the canonical state root throughout the application.

Do not silently relocate an explicitly configured unsafe state directory. Fail startup with a clear error.

## Tests

Add tests for:

```text
custom workspace + nested state
workspace nested inside state
state symlink -> workspace
workspace symlink -> state
external link -> canonical state location
```

# R2-02 — Workspace-tool approval hash has a TOCTOU gap

Severity: **Medium**

## Problem

The approval model hashes and validates a tool before execution, but the interpreter later opens the tool again by its mutable workspace pathname.

Conceptually:

```text
hash tool
verify approval
     |
     | race window
     v
python/node opens workspace pathname
```

This creates a time-of-check/time-of-use gap.

## Why this matters

The threat model may exclude an arbitrary malicious process already running as the same Unix user, but Workbench itself can execute another approved tool that has write access to the same project.

Example:

```text
Tool A
  approved
  selected project RW
  no secrets

Tool B
  approved
  selected project RW
  secret: production-token
```

If A modifies B after B's hash check but before the interpreter opens B, attacker-controlled code may execute with B's approved secret environment.

That violates the intended per-tool capability boundary.

## Required invariant

The code executed by the interpreter must be the exact bytes that were hashed and approved.

## Recommended implementation

Use a verified immutable staging step:

```text
supervisor
    |
    +--> open tool safely
    +--> read exact bytes
    +--> hash exact bytes
    +--> compare approval
    |
    +--> write verified copy to private staging area
    +--> make staging copy read-only
    |
    v
sandbox
    |
    v
interpreter executes staged file
```

The same principle should apply to any manifest data used during execution.

Do not try to solve this with another `stat()` or final hash check on the original pathname. That only narrows the race rather than removing it.

## Tests

Create two approved tools with different capabilities.

Test concurrent modification of the higher-privilege tool between policy verification and execution.

Acceptance criterion:

```text
the interpreter always executes the verified immutable bytes
```

# R2-03 — Provider-key prefixes are still disclosed

Severity: **Low**

Provider configuration status still reveals an initial prefix of the stored API key.

Example pattern:

```text
abcd1234…
```

There is little operational value in exposing secret characters.

## Recommended behaviour

Return only:

```json
{
  "configured": true,
  "source": "stored"
}
```

If users need to distinguish multiple credentials, create a non-secret identifier instead of exposing characters from the credential.

# R2-04 — CI supply-chain hardening remains

Severity: **Low**

The CI workflow should still be hardened.

## Recommended changes

Set explicit least-privilege workflow permissions:

```yaml
permissions:
  contents: read
```

Grant additional permissions only where needed.

Pin GitHub Actions to full immutable commit SHAs rather than mutable major-version tags.

For example, prefer:

```yaml
uses: actions/checkout@<full-commit-sha>
```

over:

```yaml
uses: actions/checkout@v4
```

Retain:

```text
npm ci
npm audit --omit=dev
SBOM generation
```

Consider CodeQL or equivalent static analysis because this repository contains substantial filesystem, HTTP, sandbox and process-execution code.

# R2-05 — Security documentation is now behind the implementation

Severity: **Low operationally, but important architecturally**

The implementation has evolved substantially since the original threat model.

The current security architecture now includes:

- separate application and asset origins;
- per-turn project capabilities;
- explicit external-link grants;
- external snapshots;
- hash-bound workspace-tool approval;
- dedicated logical tool secrets;
- fail-closed tool networking;
- resource limits;
- process-group termination;
- Linux-specific workspace-tool execution behaviour.

The documentation should be updated to describe these boundaries explicitly.

## Recommended trust-boundary documentation

Document at least:

```text
browser -> application origin
browser -> untrusted asset origin
model -> selected project
model -> explicit external read grant
project -> external symlink
workspace tool -> selected project RW
workspace tool -> logical secret
workspace tool -> network
workspace review -> remote model provider
application -> privileged state directory
```

The threat model should explicitly state:

> A prompt-injected model may misuse capabilities already granted to the current turn, but must not be able to enlarge its own authority.

Application state should be documented as a separate privileged filesystem root, not merely as something that is "normally outside the workspace".

# R2-06 — Future network egress must validate resolved addresses

Severity: **Design note / not currently exploitable**

Workspace-tool networking currently fails closed, so this is not an active vulnerability.

However, before implementing the planned egress broker, hostname validation needs to be stronger than syntax checking.

A hostname such as:

```text
internal.attacker.example
```

can resolve to:

```text
127.0.0.1
::1
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.169.254
fc00::/7
```

A future network broker must therefore validate resolved A/AAAA addresses.

## Recommended architecture

The broker should:

1. resolve the approved hostname itself;
2. validate all returned addresses against policy;
3. establish the connection itself;
4. avoid allowing the sandbox to perform an independent DNS lookup;
5. re-check redirects and any subsequent target hostnames.

This prevents hostname-policy bypass and DNS-rebinding-style changes between policy evaluation and connection.

# External-link feature review

The external-link design is generally strong.

Positive properties include:

- direct project symlink requirement;
- explicit approval;
- canonical workspace/project/link/target binding;
- no nested symlink traversal;
- hidden/sensitive path filtering;
- size limits;
- file-count limits;
- depth limits;
- private per-turn snapshots;
- read-only model access;
- `O_NOFOLLOW`-style handling;
- hard-link rejection;
- post-copy metadata checks.

I did not identify a straightforward symlink breakout in this path.

The main issue affecting this feature is R2-01: the application state directory must be canonicalised correctly and treated as a protected root.

## Approval UI note

An explicitly approved directory symlink can still expose a broad external subtree.

That is a product/security decision rather than a vulnerability, but the approval UI should prominently show the canonical target.

For example:

```text
Requested link:
project/background/reference

Canonical target:
/home/user/Documents/client-material
```

Directory approval should be visibly distinct from approving one file.

# Workspace-review feature

I did not identify an obvious new filesystem authority escalation in the workspace-review feature.

The current design appears to avoid creating normal workspace-wide tool authority merely because a workspace-level summary is being generated.

That is the right separation.

The main security consideration is privacy:

```text
information from multiple projects
        |
        v
remote model provider
```

This should remain explicit in configuration and UI, especially if workspace review can run automatically.

# Priority order

I recommend addressing the remaining findings in this order:

1. **R2-01 — canonical state/workspace separation**
2. **R2-02 — immutable staging of approved workspace tools**
3. R2-03 — remove provider-key previews
4. R2-05 — update threat model/security documentation
5. R2-04 — pin CI actions and set explicit permissions
6. R2-06 — add network-broker requirements/tests before networking is enabled

# Security architecture conclusion

The most important improvement since the previous review is that authority is now encoded in the application rather than primarily in model instructions.

The earlier design effectively contained boundaries such as:

```text
the model should remain inside the selected project
```

The current design is much closer to:

```text
the application grants the selected project
the model cannot address anything outside that grant
```

Similarly, workspace tools are moving from:

```text
manifest requests privilege
therefore privilege is granted
```

towards:

```text
manifest declares requirements
external Workbench-controlled approval grants capability
```

Those are the correct architectural directions.

The two remaining medium findings are both boundary-integrity problems rather than broad architectural failures:

- R2-01 concerns canonical separation of privileged application state from workspace content;
- R2-02 concerns ensuring that the executable bytes receiving an approved capability are exactly the bytes that were approved.

Once those are fixed, the remaining identified work is mainly defence-in-depth, documentation and future-proofing.
