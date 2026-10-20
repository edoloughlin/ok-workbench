# OK Workbench Code Review

Date: 2026-10-01

Repository: `https://github.com/edoloughlin/ok-workbench`

This review covers the current public `main` branch as a general code review rather than a security audit.

The focus is:

- correctness;
- data integrity;
- concurrency;
- architecture;
- maintainability;
- error handling;
- API boundaries;
- tests;
- places where recent security work may have made the code harder to reason about.

One limitation applies to this review: GitHub's public retrieval was inconsistent for `src/pi-harness.mjs`. The source page available during review appeared older than the current `test/pi-harness.test.mjs`, which explicitly tests the newer capability implementation (`createTurnCapabilities`, no model-facing `workspace` scope). The stale harness source was therefore not treated as authoritative current code.

## Findings

| ID | Priority | Finding |
|---|---|---|
| CR-01 | High | `apply_project_update` is neither atomic nor concurrency-safe |
| CR-02 | Medium | `correction` is an escape hatch around the OKF consistency rules |
| CR-03 | Medium | `search_files` silently searches only the first 200 files |
| CR-04 | Medium | Tool approval/secret state has lost-update races |
| CR-05 | Medium | Workspace configuration errors are silently ignored |
| CR-06 | Medium | The workspace-review context gate uses an unsafe token approximation |
| CR-07 | Medium | A substantial part of the test suite tests source text rather than behaviour |
| CR-08 | Low/Medium | Tool-manifest policy is implemented twice |
| CR-09 | Low | State directory handling does not honour `XDG_STATE_HOME` |
| CR-10 | Structural | `server.js` and `app.js` have crossed the point where decomposition would materially reduce defect risk |

# CR-01 — `apply_project_update` is not actually a batch

Priority: **High**

This is the most important non-security issue found.

## Problem

`applyProjectUpdate()` performs substantial preflight validation:

- validates paths;
- loads existing content;
- determines changed files;
- enforces `status.md`/`index.md` requirements;
- prepares log changes.

It then applies changes one by one.

Conceptually:

```js
const written = [];

for (const [safe, content] of prepared) {
    written.push(await applyPatch({
        path: safe,
        content
    }));
}
```

Each `applyPatch()` performs an independent filesystem write.

This means an intended multi-file update can fail part-way through.

Example:

```text
page.md       written
status.md     written
index.md      written
log.md        ENOSPC
other.md      never attempted
```

The operation reports failure, but the first three changes remain.

This defeats the purpose of a coordinated project update whose purpose is to keep content, `status.md`, `index.md` and `log.md` mutually consistent.

## Concurrency problem

There is also no optimistic concurrency control over the complete transaction.

The implementation reads existing files during preflight, then later writes them.

An external editor can therefore modify a file between:

```text
read current file
        |
        | external edit
        v
write prepared result
```

and the external change can be overwritten.

The single-file `edit_file` path already uses a content-hash guard. The batch operation should provide equivalent protection across the whole set.

## `log.md` history issue

For substantive updates, the automatic log append can use a model-supplied `log.md` as the basis for the append rather than the actual current log.

This allows an update to accidentally replace or remove existing log history.

## Required behaviour

Treat a project update as a transaction.

A suitable flow is:

```text
read canonical current state
        |
        v
record expected hashes/revisions
        |
        v
validate complete proposed update
        |
        v
prepare every output in private temp files
        |
        v
revalidate expected revisions
        |
        v
commit atomically where possible
        |
        v
rollback/recover on commit failure
```

For `log.md`, substantive updates should append to the actual current log rather than allowing model-provided replacement history in the same operation.

## Tests

Add tests for:

```text
five-file update where write 4 fails
    -> no partial update remains

external edit after preflight
    -> update fails rather than overwriting

substantive update with model-supplied log.md
    -> existing log history cannot be discarded
```

# CR-02 — `correction` bypasses the consistency contract

Priority: **Medium**

## Problem

`applyProjectUpdate()` permits both:

```text
correction
substantive
```

but the important consistency rules are applied only for `substantive`.

A `correction` can therefore avoid requirements such as:

- updating `status.md`;
- updating `index.md`;
- automatic log handling.

If a correction can contain many files or structural changes, the distinction becomes mostly model-enforced rather than mechanically enforced.

Example:

```text
kind = correction

changes:
  many Markdown files
  new directories
  structural files
```

This can bypass the semantic safeguards that exist for substantive work.

## Recommendation

Make `correction` mechanically constrained.

For example:

```text
correction:
    small number of existing files only
    no new directories
    no broad structural changes
    no project-wide metadata changes unless explicitly allowed
```

The exact restrictions are a product decision.

The important point is that the code, not the model, should enforce the distinction between a correction and a substantive project update.

# CR-03 — `search_files` silently searches only the first 200 files

Priority: **Medium**

## Problem

`listFiles()` stops once it reaches approximately:

```text
MAX_RESULTS = 200
```

`searchFiles()` then searches the output of `listFiles()`.

The result is that a project containing more than 200 files is not fully searched.

The search universe becomes:

```text
the first 200 files returned by traversal
```

rather than:

```text
the project
```

A match in file 450 will never be found.

Filesystem enumeration order is also not an appropriate completeness boundary.

## Secondary issue

Unreadable files, large files and other read failures may be silently skipped.

The caller can therefore receive:

```text
no matches
```

without knowing whether:

- the whole project was searched;
- some files were skipped;
- the traversal was truncated.

That is particularly problematic for an LLM because it can reasonably interpret an empty result as evidence that the information does not exist.

## Recommendation

Make `search_files` traverse independently of `list_files`.

Bound the search with explicit limits such as:

```text
maximum files scanned
maximum bytes scanned
maximum matches returned
```

Return completeness metadata.

Example:

```json
{
  "matches": [],
  "filesScanned": 1437,
  "filesSkipped": 12,
  "truncated": false
}
```

If a limit is reached:

```json
{
  "truncated": true
}
```

This tells the model that absence is not proof of non-existence.

## Tests

Add:

```text
500-file project
match only in file 450
    -> match found

search bound reached
    -> truncated=true

unreadable files
    -> filesSkipped reported
```

# CR-04 — Approval and secret state can lose concurrent updates

Priority: **Medium**

## Problem

The approval and secret stores appear to use a safe filesystem replacement pattern:

```text
write temp file
rename into place
```

This prevents torn JSON.

It does not prevent lost updates.

The logical pattern remains:

```text
read JSON
modify in memory
write JSON
```

Two concurrent requests can therefore do:

```text
request A          request B
---------          ---------
read version 10    read version 10
add approval A     add approval B
write version 11A
                   write version 11B
```

Approval A disappears.

The same class of issue applies to mutable secret state.

## Recommendation

Introduce one shared state-store abstraction.

Possible approaches:

### In-process serialization

Use a per-state-file mutex/queue:

```text
mutate state
    |
    v
exclusive queue
    |
    v
read latest
modify
write
```

### Revision/CAS semantics

Persist a revision number and reject updates based on stale revisions.

The workspace-review subsystem already appears to use revision concepts, so this pattern would be consistent with existing design.

## Tests

Add concurrent tests showing:

```text
two approval additions
    -> both survive

two secret updates
    -> both survive

stale revision
    -> rejected or retried
```

# CR-05 — Invalid configuration can silently select another workspace

Priority: **Medium**

## Problem

Workspace configuration loading catches all failures and then attempts fallback locations.

Conceptually:

```js
try {
    const config = JSON.parse(await fs.readFile(...));

    if (typeof config.workspaceRoot === 'string') {
        return config.workspaceRoot;
    }
} catch {
    // try another location
}
```

This means these are treated similarly:

```text
file does not exist
invalid JSON
permission denied
I/O error
```

That produces a dangerous operational failure mode.

Example:

```text
~/.config/ok-workbench/config.json
        |
        v
malformed JSON
        |
        v
silently ignored
        |
        v
fallback workspace selected
```

The application may therefore serve a different workspace than the user expected.

For a knowledge-management tool, silently selecting the wrong dataset is worse than failing to start.

## Recommendation

Only `ENOENT` should normally mean:

```text
try the next configuration source
```

Other failures should be explicit startup errors.

Examples:

```text
invalid JSON
    -> fail startup and name config file

permission denied
    -> fail startup

unexpected I/O error
    -> fail startup
```

Use the same principle elsewhere:

```text
absence -> fallback may be valid
corruption -> fail loudly
```

# CR-06 — Workspace-review context gate uses an unsafe token approximation

Priority: **Medium**

## Problem

The review subsystem uses an approximation equivalent to:

```text
4 bytes per token
```

for a non-overridable context-fit gate.

That is a useful average for some English prose.

It is not a safe upper bound for:

- Markdown;
- source code;
- JSON;
- Unicode;
- multilingual text;
- unusual tokenisation patterns.

If the gate is intended to prove:

```text
this request fits inside the model context
```

then an average-case estimate is not sufficient.

## Recommendation

Use one of these, in order of preference:

1. provider/model tokenizer;
2. Pi's own token accounting if available;
3. deliberately conservative approximation.

For a hard safety gate, conservative overestimation is preferable to average-case precision.

## Tests

Use payloads near the configured limit containing:

```text
ordinary English
JSON
source code
Unicode-heavy text
multilingual text
```

Verify that the gate never underestimates enough to permit a request that exceeds the actual model context.

# CR-07 — Too many tests assert source text rather than behaviour

Priority: **Medium**

## Problem

A significant part of the test suite uses assertions similar to:

```js
const script = await readFile(...);
assert.match(script, /implementation-specific-regexp/);
```

These tests are useful for a small number of static security invariants.

They are weak as primary behavioural tests.

Two failure modes follow.

### Correct refactor

```text
behaviour remains correct
implementation changes
test fails
```

### Broken behaviour

```text
expected source string remains
runtime behaviour breaks
test passes
```

## Recommendation

Keep static source assertions only where static structure is the actual invariant.

Good examples:

```text
model-facing schema must not contain workspace scope
forbidden unsafe API must not appear
```

Move normal UI/server behaviour tests towards:

- API integration tests;
- DOM tests;
- Playwright end-to-end tests;
- direct function-level tests for pure modules.

The project already has Playwright and a separate `test:e2e` command, so the infrastructure exists.

## Migration approach

Do not replace everything at once.

As each subsystem is modified:

```text
existing source-regex test
        |
        v
add behavioural test
        |
        v
remove source-regex test if redundant
```

# CR-08 — Tool-manifest policy is implemented twice

Priority: **Low/Medium**

## Problem

Manifest policy appears in both:

```text
tool-approvals.js
tool-worker.js
```

Both understand concepts such as:

- runtime;
- timeout;
- secret names;
- network hosts;
- ports;
- manifest location;
- policy fields.

These are security-sensitive semantics.

Duplicating them creates a risk that approval and execution interpret the same manifest differently.

Example:

```text
approval layer accepts policy A
execution layer interprets policy B
```

Even if they match today, future changes need to remain synchronized.

## Recommendation

Extract one dependency-light module such as:

```text
src/tools/manifest.js
```

It should own:

```text
schema
parsing
normalisation
validation
canonical hashing representation
```

Then:

```text
approval layer
    -> imports manifest parser

execution layer
    -> imports same parser
```

Keep approval and execution enforcement separate, but share policy interpretation.

# CR-09 — `XDG_STATE_HOME` is not honoured

Priority: **Low**

## Problem

Configuration honours `XDG_CONFIG_HOME`, but the default state directory is effectively fixed to:

```text
~/.local/state/ok-workbench/chat
```

rather than using `XDG_STATE_HOME`.

A user with:

```sh
XDG_STATE_HOME=/somewhere/state
```

will not get the expected XDG location unless they also configure `OK_WORKBENCH_STATE_DIR`.

## Recommendation

Use:

```js
const stateHome =
    process.env.XDG_STATE_HOME ||
    path.join(os.homedir(), '.local', 'state');
```

Then derive the Workbench state directory from that.

This should be fixed together with the state-directory security changes because that code already needs restructuring.

# CR-10 — `server.js` and `app.js` should now be decomposed

Priority: **Structural**

The main server file is now roughly 1,400+ lines.

The browser application is similarly around 1,500 lines.

Line count alone is not a reason to refactor.

The important issue is that the files now contain several domains with different state and consistency rules.

`server.js` currently owns concerns including:

```text
HTTP routing
workspace traversal
document classification
state paths
chat persistence
provider credentials
authentication
Git operations
dirty-state tracking
todo mutations
external links
workspace review orchestration
```

It also owns significant process-global mutable state.

Recent functionality has created enough real subsystem boundaries that continuing to add behaviour here increases the probability of:

- state races;
- partial updates;
- inconsistent error semantics;
- duplicated filesystem logic;
- difficult tests.

## Recommended target structure

A possible incremental target:

```text
src/
  server.js
      HTTP bootstrap/router

  workspace/
    paths.js
    catalogue.js
    documents.js
    mutations.js

  chat/
    threads.js
    turns.js

  providers/
    credentials.js
    auth.js

  tools/
    manifest.js
    approvals.js
    worker.js

  git/
    repository.js
    review.js

  review/
    coordinator.js
    store.js
    schema.js

  state/
    store.js
```

Do not do this as a big-bang rewrite.

The correctness fixes naturally create useful extraction points:

```text
CR-01 -> workspace/mutations.js
CR-04 -> state/store.js
CR-08 -> tools/manifest.js
```

Move code while fixing concrete defects.

# Test-quality assessment

The security-oriented test design is strong in several places.

The Pi harness tests reportedly check properties such as:

```text
capabilities are project-scoped
invented grants fail
workspace root requires explicit mode
model-facing workspace scope is absent
```

That is the right style of adversarial testing.

The general correctness tests should move toward the same invariant-driven approach.

## Highest-value new tests

| Test | Required result |
|---|---|
| 4th write fails in a 5-file project update | no partial mutation remains |
| external file edit during project update | update fails rather than overwriting |
| substantive update supplies `log.md` | previous log history preserved |
| 500-file project; match at file 450 | `search_files` finds it |
| bounded search reaches limit | caller sees `truncated=true` |
| concurrent approval writes | both survive |
| concurrent secret writes | both survive |
| corrupt active config | startup fails instead of selecting fallback workspace |
| JSON/Unicode-heavy review near context limit | context gate remains conservative |

# Recommended implementation order

Address the code-review findings in this order:

1. **CR-01 — make project updates transactional and concurrency-safe**
2. **CR-02 — mechanically constrain `correction`**
3. **CR-03 — fix incomplete search and report truncation**
4. **CR-04 — introduce serialized or revisioned state mutation**
5. **CR-05 — fail loudly on corrupt configuration**
6. Fix the two medium security findings from the updated security review if they are still open:
   - canonical state/workspace separation;
   - immutable staging of approved workspace tools.
7. **CR-06 — make context accounting conservative**
8. Improve behavioural tests while implementing the above
9. **CR-08 — consolidate manifest parsing**
10. Decompose `server.js` and `app.js` incrementally around the new abstractions
11. **CR-09 — honour `XDG_STATE_HOME`**, preferably while restructuring state-path handling

# Overall assessment

The project has improved substantially in security architecture, but ordinary correctness and maintainability are now becoming the larger engineering risk.

The two strongest themes from this code review are:

```text
1. Multi-file and multi-request state changes need stronger transactional semantics.

2. Several behaviours currently report success or fallback when the real result is incomplete,
   ambiguous, or partially failed.
```

The highest-value next step is therefore not a broad refactor. It is to introduce strong mutation primitives for project state and application state, then move existing code onto those primitives.

That will fix concrete bugs and create natural module boundaries at the same time.
