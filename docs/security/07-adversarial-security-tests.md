# Adversarial Security Test Plan

This file turns the review findings into regression tests.

The exact test framework should match the existing repository. Prefer integration tests for security boundaries even if unit tests also exist.

---

# Test principles

Each high-severity finding needs at least one test that:

1. reproduces the unsafe condition against the old design;
2. fails before the fix;
3. passes after the fix;
4. checks a security invariant rather than an incidental implementation detail.

Do not mock away the boundary being tested.

---

# A. HTTP authority / DNS rebinding

## Invariant

```text
A non-local Host can access no Workbench content or API.
```

## Cases

For each information-bearing endpoint:

```text
Host: attacker.invalid
Host: attacker.invalid:<port>
```

Expected:

```text
request rejected before route-specific processing
```

Test at least:

```text
/
static asset
/api/project
/api/document
/asset/workspace/...
/workspace/...
/api/chat/session
mutation endpoint
```

Positive cases:

```text
localhost:<port>
127.0.0.1:<port>
[::1]:<port>
```

Reject malformed forms.

If Fetch Metadata is also enforced, test:

```text
Sec-Fetch-Site: cross-site
```

without making that the only protection.

---

# B. Active SVG / browser origin

Create a workspace SVG that attempts to:

1. run JavaScript;
2. fetch `/api/chat/session`;
3. write a marker or exfiltrate the response.

Acceptance criterion:

```text
The SVG cannot execute with the Workbench application origin.
```

Test:

- preview;
- clicking/opening;
- direct asset URL;
- MIME confusion;
- renamed SVG.

If a separate untrusted asset origin is introduced, verify it has no privileged API.

---

# C. Project capability isolation

Set up:

```text
workspace/
  project-a/
    public.md
  project-b/
    private.md
```

Selected project: `project-a`.

Negative cases:

```text
read project-b/private.md
read ../project-b/private.md
write project-b/private.md
move into project-b
apply update to project-b
invent workspace scope
invent grant ID
```

Expected:

```text
rejected
```

Create a symlink in A that resolves into B.

Expected:

```text
rejected after canonical resolution
```

Positive case:

- user explicitly grants B/private.md read access;
- exact read succeeds;
- write remains rejected.

Test grant expiry according to the chosen lifetime.

---

# D. Hidden/secret file policy

Within selected project create:

```text
.npmrc
.netrc
.pypirc
.env
secrets.json
normal.md
```

Default behaviour:

```text
normal.md -> readable
hidden files -> denied unless explicitly granted
.git/** -> always denied to the model
```

If `.gitignore` contributes to policy, test ignored and tracked files separately.

---

# E. Workspace-tool self-authorisation

Create a hostile tool manifest that requests:

```text
provider API key
network access
whole workspace
```

No external approval exists.

Expected:

```text
tool cannot obtain any requested privilege
```

Verify there is no fallback to normal `process.env`.

---

# F. Provider-key isolation

Configure a provider credential in Workbench.

Run a normal project tool that:

- prints environment keys;
- requests `OPENAI_API_KEY`;
- requests `ANTHROPIC_API_KEY`;
- reads state paths if guessed.

Expected:

```text
provider values never visible
provider environment names not grantable through generic tool requirements
state path inaccessible
```

---

# G. Tool approval hash binding

1. Create tool + manifest.
2. Approve it.
3. Verify execution receives only approved capability.
4. Change one byte in executable.
5. Re-run.

Expected:

```text
approval invalid
```

Repeat by changing only the manifest.

Repeat by renaming the tool.

---

# H. Network egress

For a tool approved only for:

```text
jira.example.com:443
```

verify:

```text
jira.example.com:443 -> permitted
attacker.example:443 -> denied
127.0.0.1:<port> -> denied
::1 -> denied
192.168.x.x -> denied by default
10.x.x.x -> denied by default
172.16/12 -> denied by default
169.254.169.254 -> denied
```

Use a controlled test server rather than the public Internet where possible.

---

# I. Resource exhaustion

Create separate abusive tools:

## CPU

```text
infinite loop
```

Expected:

```text
CPU/wall limit terminates process tree
```

## Memory

Allocate until limit.

Expected:

```text
sandbox/tool dies
Workbench process remains healthy
```

## Fork/process count

Spawn children repeatedly.

Expected:

```text
pids/RLIMIT prevents host exhaustion
```

## File descriptors

Open many files/sockets if networking is available.

Expected:

```text
limit reached without host-wide degradation
```

## File output

Write a file larger than the configured output/project policy.

Expected:

```text
operation limited/rejected according to policy
```

## Timeout child survival

Parent spawns a long-lived child and waits.

After timeout:

```text
parent gone
child gone
no orphan remains
```

---

# J. State-directory containment

Test default and custom paths.

Cases:

```text
workspace=/srv/work
state=/srv/work/.state
    -> reject

workspace=/srv/work
state=/srv
    -> reject

workspace=/srv/work
state=/home/user/.local/state/ok-workbench
    -> allow
```

Repeat through symlinks:

```text
state symlink -> inside workspace
workspace symlink -> inside state
```

Expected:

```text
canonical overlap detected
```

---

# K. Large-file handling

Create files well above each preview threshold.

Test:

```text
large Markdown
large code
large binary
large PDF/media
```

Acceptance:

- server does not call whole-file read before enforcing preview limit;
- assets are streamed;
- memory remains bounded under concurrent requests;
- truncated previews are explicitly indicated;
- byte-range support works if implemented.

---

# L. CSRF/session handling after browser-origin changes

Retain existing mutation protection.

Verify:

```text
missing CSRF -> rejected
invalid CSRF -> rejected
valid same-origin request -> accepted
```

Do not remove CSRF merely because Host validation is now global. They address different attack classes.

---

# M. Tool sandbox mount inspection

On Linux with Bubblewrap installed, run a diagnostic tool that attempts to list/read:

```text
selected project
other project
Workbench state
home directory
/tmp
/usr
/proc
```

Expected target:

```text
selected project -> according to granted RW policy
explicit external grants -> RO
other projects -> absent
state -> absent
runtime paths -> RO as required
/tmp -> private
network -> absent unless approved
```

---

# N. CI security tests

Add static checks where practical.

Examples:

```text
fail if workflow action uses mutable tag rather than full SHA
fail if CI workflow lacks explicit permissions
fail if model filesystem schema contains "scope: workspace"
fail if provider-key names appear in generic tool secret-resolution code
```

These are useful guardrails even when integration tests provide the real boundary assurance.

---

# Required release invariants

Before a security-sensitive release, all of these statements must be mechanically tested or explicitly verified:

```text
1. Host attacker.invalid can read nothing.

2. Project A cannot read or modify Project B without a server-issued capability.

3. A model cannot enlarge its own filesystem scope.

4. A project cannot grant itself access to any Workbench provider credential.

5. A project cannot grant itself unrestricted network access.

6. Changing an approved tool or manifest invalidates approval.

7. Workspace SVG/HTML cannot execute with privileged API authority.

8. Application state can never be nested in or contain the active workspace.

9. Sandbox timeout kills all descendant processes.

10. Large workspace files cannot cause unbounded server memory allocation.
```
