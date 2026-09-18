# OK Workbench: OKF Conformance and Project-Bundle Profile

Status: Proposed  
Target: OK Workbench after version 1.0.0  
OKF baseline: Open Knowledge Format 0.2

## 1. Purpose

This specification defines how OK Workbench will use Open Knowledge Format
(OKF) 0.2 while preserving the product's project-oriented workspace model.

The implementation must:

- treat each project as a logically standalone OKF bundle;
- treat the top-level workspace as an OK Workbench container, not as one OKF
  bundle containing every project and application resource;
- retain project metadata in each project-root `index.md` as an intentional OK
  Workbench profile extension;
- validate ordinary project knowledge documents against OKF 0.2;
- distinguish durable project knowledge from human-supplied background input;
- permit rare cross-project links without making them the default;
- make deviations from strict OKF explicit and machine-detectable; and
- preserve the existing local-first, Markdown-first and Git-reviewable model.

This specification uses **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and
**MAY** as normative requirement terms.

## 2. Context and decision

OKF defines the representation of knowledge documents. OK Workbench adds:

- an umbrella workspace containing several projects;
- project discovery and navigation;
- project-level instructions, status, tasks and logs;
- coordinated assistant updates;
- background-document extraction;
- Git-backed review; and
- application-owned workflow and template resources.

The project directory, rather than the workspace directory, is the logical OKF
bundle boundary.

The implementation will therefore support two related validation modes:

1. **OK Workbench profile validation** validates a complete project directory,
   including the project-root extension and known auxiliary directories.
2. **Strict OKF document validation** validates the OKF knowledge projection of
   that project. It excludes declared auxiliary inputs and applies the upstream
   OKF 0.2 document rules.

OK Workbench MUST describe project directories as **OKF 0.2 bundles using the
OK Workbench project profile**. It MUST NOT claim that an entire workspace is a
single conformant OKF bundle.

## 3. Terms

### 3.1 Workspace

The user-facing umbrella directory served by OK Workbench. It contains project
directories and may also contain application resources such as templates,
workflow documents, shared tools and workspace instructions.

The workspace is not itself an OKF bundle.

### 3.2 Project

An independently navigable unit of durable knowledge. Each project directory is
the root of one logical OKF bundle and one OK Workbench project profile.

### 3.3 Knowledge document

A Markdown document that forms part of the project's durable knowledge graph.
Except for OKF reserved files, it has YAML frontmatter containing at least a
non-empty `type`.

### 3.4 Auxiliary input

A file retained to supply context for ingestion but not itself treated as
curated project knowledge. Files under `background/` are auxiliary inputs.

### 3.5 Derived concept

A knowledge document created or updated after digesting one or more auxiliary
inputs. A derived concept records its provenance but does not inherit the
authority or trust of its inputs automatically.

### 3.6 Project-local link

A Markdown link whose target is inside the same project bundle.

### 3.7 Cross-project link

A Markdown link whose target is inside another project in the same workspace.
It is an OK Workbench extension and may not resolve when the source project is
distributed independently.

## 4. Target directory model

```text
workspace/
  AGENTS.md                         # Workspace instructions; not an OKF concept
  index.md                          # Workspace navigation; not an OKF bundle index
  bundle-manifest.json              # Application seed and format metadata
  workflow/                         # Application resources; outside project validation
  templates/                        # Application resources; outside project validation
  tools/                            # Shared executable tools
  project-a/                        # Project bundle boundary
    index.md                        # Project-root OKF index plus profile extension
    AGENTS.md                       # Project knowledge/instruction concept
    status.md                       # Project knowledge concept
    log.md                          # Reserved OKF log
    todo.md                         # Project knowledge concept
    background/                     # Auxiliary input; excluded from OKF concept validation
      report.pdf
      notes.md
    concepts/
      index.md                      # Ordinary nested OKF index; no frontmatter
      domain-model.md               # Project knowledge concept
    references/                     # Curated references used by concepts
      index.md
      decision-source.md
  project-b/
    ...
```

The names `concepts/` and `references/` are examples. Projects MAY use a
domain-specific hierarchy. `background/` has the special meaning defined in
section 8.

## 5. Workspace rules

### 5.1 Workspace boundary

The workspace validator MUST NOT recursively validate the complete workspace as
one OKF bundle.

The following workspace-owned paths are outside project-bundle conformance:

- `/AGENTS.md`;
- `/index.md`;
- `/bundle-manifest.json`;
- `/workflow/`;
- `/templates/`; and
- `/tools/`.

Their existing formats MAY remain application-specific.

### 5.2 Project discovery

An immediate child directory of the workspace is a project when:

- it contains `index.md`; and
- its root index declares the OK Workbench project profile described in section
  6.

Compatibility discovery MAY continue to recognise legacy project directories
that contain `index.md`, `status.md` and `log.md`. The UI SHOULD identify these
as needing migration rather than silently treating them as current-profile
projects.

Project discovery MUST NOT infer projects from arbitrary nested `index.md`
files.

### 5.3 Workspace metadata

`bundle-manifest.json` MUST continue to version these concerns independently:

- upstream OKF version;
- OK Workbench project-profile version;
- workflow version; and
- seed version.

The existing `okf_version` field MAY remain for compatibility, but new code
SHOULD interpret it as the OKF version targeted by generated project bundles,
not as a declaration that the workspace itself is an OKF bundle.

## 6. Project-root profile

### 6.1 Intentional extension

Upstream OKF 0.2 permits a bundle-root `index.md` to declare `okf_version`, but
does not define the additional project metadata required by OK Workbench.

OK Workbench will retain additional frontmatter in a project's root `index.md`.
This is an intentional profile extension. It MUST be identified explicitly so
that consumers can distinguish it from strict upstream OKF.

The target project-root frontmatter is:

```yaml
---
okf_version: "0.2"
ok_workbench:
  profile_version: "1.0"
  project_state: active
  auxiliary_paths:
    - background/
type: Project
title: Example project
description: One-line description of this project and its durable knowledge.
tags: [project]
status: stable
---
```

Rules:

- `okf_version` MUST be `"0.2"` while this specification is current.
- `ok_workbench.profile_version` MUST identify the implemented profile.
- `ok_workbench.project_state` MAY use application states such as `active`,
  `paused`, `completed` or `archived`.
- `status` remains the OKF lifecycle field and MUST use only `draft`, `stable`
  or `deprecated`.
- `type` MUST be `Project`.
- `title` and `description` MUST be non-empty strings.
- `auxiliary_paths` MUST contain project-relative directory paths and MUST NOT
  escape the project.
- Unknown profile keys MUST be preserved when a document is round-tripped.

The application MUST NOT use `status: active`. Project activity belongs in
`ok_workbench.project_state`.

### 6.2 Nested indexes

Every `index.md` below the project root is an ordinary OKF index.

It MUST NOT contain frontmatter. It SHOULD contain a heading followed by links
and short descriptions suitable for progressive disclosure.

### 6.3 Reserved log

`log.md` is an OKF reserved file, not a typed concept document.

Project `log.md` files MUST:

- omit YAML frontmatter;
- contain a descriptive heading;
- group entries under ISO `YYYY-MM-DD` headings;
- place the newest date group first; and
- use ordinary Markdown links for referenced project concepts.

The update operation MUST preserve this structure when it appends or inserts an
entry.

## 7. Project knowledge-document rules

Every `.md` file in the project knowledge projection, other than `index.md` and
`log.md`, MUST:

- be UTF-8;
- start with parseable YAML frontmatter;
- contain a non-empty `type`; and
- contain a Markdown body after the frontmatter.

The profile SHOULD also require `title` and `description`, although upstream
OKF requires only `type`.

### 7.1 Lifecycle fields

When present:

- `status` MUST be `draft`, `stable` or `deprecated`;
- `stale_after` MUST be an absolute ISO 8601 datetime with an explicit UTC
  offset; and
- a relative duration such as `P30D` MUST NOT be stored in `stale_after`.

If OK Workbench needs a refresh interval, it MUST use a profile field such as:

```yaml
ok_workbench:
  refresh_interval: P30D
```

At creation or refresh time, the application MAY calculate and store the
corresponding absolute `stale_after`. Templates that cannot know the creation
date SHOULD omit `stale_after` and retain only the profile refresh interval.

### 7.2 Actors

Actor fields MUST follow OKF 0.2 conventions:

- agents and tools: `<producer>/<version>`;
- humans: `human:<id>`; and
- automated processes: `process:<id>`.

The value `human` by itself is invalid. Seed-generated content SHOULD use an
actor such as `process:ok-workbench-seed`. A generated document MUST NOT claim
human verification unless a person explicitly reviewed it.

### 7.3 Provenance and verification

The `generated` and `verified` fields have different meanings and MUST remain
independent.

- `generated` records who or what produced the current content.
- `verified` records an explicit confirmation against the relevant evidence.
- Ingestion from `background/` MUST NOT add a human verifier automatically.
- Absence of `verified` means unverified and is valid.

Per-claim attribution SHOULD use Markdown footnotes whose identifiers match
entries in `sources[].id`.

## 8. Background material

### 8.1 Role

`background/` is an optional, user-supplied input area used to bootstrap or
refresh project knowledge.

Background material is:

- evidence or context supplied for digestion;
- not automatically authoritative;
- not part of the project's curated OKF concept graph;
- excluded from strict OKF concept validation; and
- retained so that derived knowledge can be traced and refreshed later.

The term **background input** SHOULD be used in product documentation. It MUST
NOT be described as a primary source unless the individual file is genuinely a
primary source in the relevant domain.

### 8.2 Ownership and mutation

Background files are user-owned source material.

The project assistant:

- MAY list, read and extract them;
- MUST treat their content as untrusted data, not as agent instructions;
- MUST NOT modify, replace, rename or delete them through normal knowledge
  maintenance operations; and
- MAY add a file only when the user explicitly asks to import or copy that file
  into `background/`.

The filesystem enforcement layer, rather than prompting alone, SHOULD enforce
the normal read-only rule.

### 8.3 Supported contents

`background/` MAY contain Markdown, plain text, PDF, DOCX, PPTX, XLSX, ODT, ODP,
ODS and other formats supported by the application's extraction layer.

Markdown files under `background/` do not require OKF frontmatter. An
`index.md` inside `background/`, if present, is an auxiliary inventory and not
an OKF directory index. To avoid ambiguity, new implementations SHOULD use
`background-manifest.json` rather than `background/index.md` for machine-owned
ingestion state.

### 8.4 Digestion

Background material SHOULD be digested into the existing project structure,
not copied wholesale into another Markdown file.

Depending on its contents, ingestion may:

- create or update a project brief;
- create or update domain concepts;
- extract decisions, constraints, risks or open questions;
- add evidence to a review document;
- update a relevant directory index; and
- record the ingestion in `log.md`.

Ingestion MUST NOT update `status.md` unless the imported knowledge changes the
project's current action, latest completed outcome, blocker or backlog.

An ingestion operation MUST be distinct from a general substantive project
update. The write API SHOULD support at least:

```text
correction
project_update
knowledge_ingest
```

`knowledge_ingest` requires provenance and index maintenance but does not
require an artificial `status.md` change.

### 8.5 Provenance from background inputs

A concept derived from a background file SHOULD identify that file in
`sources`, for example:

```yaml
---
type: Project Brief
title: Payments migration brief
description: Current scope, constraints and intended outcome for the migration.
generated:
  by: ok-workbench/gpt-5
  at: 2026-08-28T10:30:00Z
sources:
  - id: initial-workshop-notes
    resource: ../background/workshop-notes.docx
    title: Initial workshop notes
    author: human:project-owner
    last_modified: 2026-08-25T14:00:00Z
status: draft
---
```

`sources` records derivation. It does not assert that the source is correct.
Derived claims remain unverified unless an explicit verification event is
recorded.

### 8.6 Refresh after source changes

OK Workbench SHOULD record enough ingestion state to detect whether a
background file changed after it was last digested. The recommended state is a
project-local `background-manifest.json` containing, for each ingested file:

- project-relative path;
- content digest;
- size;
- last observed modification time;
- last ingestion time;
- ingestion actor; and
- paths of concepts created or updated from it.

This manifest is application metadata and is excluded from OKF validation.

When an ingested background file changes, OK Workbench MUST:

1. identify the affected derived concepts;
2. report the change to the user;
3. offer a reviewable re-ingestion operation;
4. preserve unsupported or contradictory existing claims until they are
   explicitly reconciled; and
5. present the resulting Git diff before the user accepts it.

The application MUST NOT silently regenerate project knowledge merely because a
background file changed.

## 9. Links

### 9.1 Project-local links

Project-local links are the default. They SHOULD use standard relative Markdown
links or OKF bundle-relative links.

The project validator SHOULD verify local targets and report broken links. In
accordance with OKF, a broken link is a diagnostic and does not by itself make
the bundle structurally invalid.

### 9.2 Cross-project links

Cross-project links are permitted but SHOULD be rare.

They MUST:

- use ordinary relative Markdown paths from the source document to the target;
- resolve through the workspace without escaping the configured workspace
  root;
- be classified as cross-project by the validator; and
- remain distinguishable from project-local bundle relationships.

Example from `project-a/decision.md` to `project-b/architecture.md`:

```markdown
See Project B architecture at ../project-b/architecture.md.
```

A workspace-aware validator SHOULD verify the target when both projects are
present. A project-only validator MUST report an external-project dependency as
informational or warning-level output, not as a structural conformance error.

Consumers of a project copied out of its workspace must expect cross-project
links not to resolve. Export tooling MAY rewrite them to configured canonical
URLs, but automatic content duplication is out of scope.

Cross-project links MUST NOT grant the assistant broader filesystem access.
Existing project-versus-workspace tool scopes remain authoritative.

### 9.3 Cross-project provenance

When a concept in another project is evidence rather than merely related
reading, it SHOULD also appear in `sources[].resource`. This preserves the
difference between an ordinary relationship and derivation.

## 10. Validation

### 10.1 Project-profile validator

Add a validator that accepts a project root and returns structured diagnostics.
Each diagnostic MUST include:

- severity: `error`, `warning` or `info`;
- rule identifier;
- project-relative path;
- concise message; and
- remediation where it is deterministic.

The validator MUST check:

- project-root profile declaration;
- supported OKF and profile versions;
- project-root metadata;
- nested `index.md` structure;
- reserved `log.md` structure;
- frontmatter and required `type` on knowledge documents;
- lifecycle values;
- timestamp forms;
- actor forms;
- containment of auxiliary paths;
- local link targets;
- classification of cross-project links; and
- exclusion of auxiliary input files from concept validation.

### 10.2 Strict OKF projection

The strict projection consists of:

- the project-root `index.md`, normalised to the upstream OKF root-index form;
- nested OKF indexes;
- reserved OKF logs; and
- conformant project knowledge documents.

It excludes:

- `background/` and other declared auxiliary paths;
- `background-manifest.json`;
- project-local executable tools and their policy files; and
- OK Workbench-only root-index metadata when producing a strict export.

For validation without export, the validator MAY inspect the project-root
extension in place and report it as a recognised profile extension rather than
an error.

### 10.3 Validation commands

The CLI SHOULD expose:

```text
ok-workbench validate [--root workspace] [--project project-id]
ok-workbench validate --strict [--project project-id]
```

Default validation uses the OK Workbench project profile. `--strict` validates
the upstream-compatible projection and reports profile-only content separately.

Validation MUST be read-only.

## 11. Migration from the 1.0.0 seed

Migration MUST be explicit, reviewable and non-destructive. It MUST NOT rewrite
user projects automatically during `serve` or `seed update`.

### 11.1 Seed changes

Update the supplied seed and project template as follows:

1. Stop describing the complete workspace as an OKF bundle.
2. Add `okf_version: "0.2"` and the `ok_workbench` profile mapping to every
   generated project-root `index.md`.
3. Retain project metadata in project-root `index.md` as the documented profile
   extension.
4. Remove frontmatter from project `log.md` files.
5. Remove frontmatter from nested `index.md` files.
6. Replace `status: active` with a valid OKF lifecycle value. Put project
   activity in `ok_workbench.project_state` where applicable.
7. Replace `stale_after: P30D` with `ok_workbench.refresh_interval: P30D` in
   templates, or calculate an absolute `stale_after` during instantiation.
8. Replace invalid actor values such as `generated.by: human`.
9. Leave workspace-owned workflow and template Markdown outside project
   conformance rather than adding artificial concept frontmatter to every file.

### 11.2 Existing project migration

Provide a dry-run migration that reports proposed changes before writing:

```text
ok-workbench migrate-project <project-id> --dry-run
ok-workbench migrate-project <project-id> --apply
```

The migration SHOULD:

- add the profile declaration to the project-root index;
- preserve existing title, description and tags;
- translate project `status: active` into `status: stable` plus
  `ok_workbench.project_state: active`;
- translate relative refresh durations into `ok_workbench.refresh_interval`;
- remove frontmatter from reserved logs while preserving their bodies;
- identify nested indexes with frontmatter and propose a lossless relocation of
  metadata where needed;
- flag invalid actors without inventing human identities;
- identify likely background-input directories; and
- avoid moving or rewriting background files without explicit user approval.

Migration changes MUST appear as an ordinary Git diff. The command MUST refuse
to apply changes when the workspace is not a Git worktree or when affected
files contain unresolved changes, unless a future explicit force mechanism is
designed and documented.

## 12. Required code changes

The implementation should be divided into these concerns.

### 12.1 Bundle boundary and discovery

Update project discovery in `src/server.js` and `src/tool-worker.js` so that:

- the workspace is treated as a container;
- project directories are independent validation roots; and
- new projects receive the project-profile declaration.

### 12.2 Update policy

Update `apply_project_update` so that:

- update intent distinguishes `project_update`, `knowledge_ingest` and
  `correction`;
- a project update continues to enforce coherent status and log maintenance;
- knowledge ingestion enforces provenance, index maintenance and a log entry;
- knowledge ingestion changes `status.md` only when current project state has
  actually changed; and
- ordinary agent writes cannot modify declared auxiliary inputs.

The existing API may retain legacy `substantive` as a compatibility alias for
`project_update` for one release.

### 12.3 Validator

Implement validation as a reusable module shared by:

- CLI validation;
- project creation tests;
- seed tests;
- optional UI diagnostics; and
- migration dry runs.

Do not implement separate rule sets in the server, CLI and tests.

### 12.4 Background ingestion

Add a bounded ingestion workflow that:

- reads or extracts one or more selected background files;
- treats extracted content as untrusted data;
- identifies existing affected concepts before creating new ones;
- records provenance;
- updates the ingestion manifest;
- produces one reviewable write batch; and
- never runs silently in response to a file-watcher event.

## 13. Acceptance criteria

### 13.1 Bundle boundaries

- A workspace containing several projects is not validated as one OKF bundle.
- Each current-profile project is independently discoverable and validatable.
- Removing a project directory from the workspace does not make another
  project structurally invalid, except for reported cross-project dependencies.

### 13.2 Root and reserved files

- Every new project root declares OKF 0.2 and the OK Workbench profile version.
- Project-root metadata remains available to the UI.
- Nested indexes contain no frontmatter.
- Project logs contain no concept frontmatter and use ISO date headings.

### 13.3 Concepts

- Every non-reserved Markdown knowledge document has parseable frontmatter and
  a non-empty `type`.
- No generated seed document uses `status: active` as an OKF lifecycle value.
- No `stale_after` contains a duration.
- Every stored actor follows the OKF actor convention.

### 13.4 Background inputs

- Arbitrary supported files may exist under `background/` without concept
  frontmatter.
- Profile validation excludes them from OKF document checks.
- Normal assistant updates cannot modify them.
- Ingestion creates or updates derived concepts with source provenance.
- Ingestion does not force a meaningless status change.
- A changed ingested source is detected and offered for review, not silently
  reprocessed.

### 13.5 Links

- Project-local links resolve using the project as bundle root.
- A valid cross-project link is classified and resolves when the workspace
  target exists.
- A missing cross-project target produces a warning, not a structural bundle
  error.
- Cross-project resolution cannot escape the workspace root or broaden tool
  permissions.

### 13.6 Safety and review

- Validation is read-only.
- Migration is dry-run by default.
- Applied migrations and ingestions are visible as project-scoped Git diffs.
- Background content cannot inject agent instructions or override workspace or
  project `AGENTS.md` files.

## 14. Test cases

At minimum, add automated tests for:

1. a workspace with two independently valid project bundles;
2. a project-root index containing the recognised profile extension;
3. rejection of frontmatter in a nested index;
4. rejection of concept frontmatter in a reserved project log;
5. a concept missing `type`;
6. an unknown concept `type`, which remains valid;
7. `status: active`, which fails lifecycle validation;
8. `stale_after: P30D`, which fails timestamp validation;
9. `generated.by: human`, which fails actor validation;
10. a valid `human:<id>` verifier;
11. Markdown without frontmatter under `background/`, which is ignored by
    concept validation;
12. the same Markdown outside an auxiliary path, which fails validation;
13. blocked normal writes to `background/`;
14. explicit user-directed addition of a background file;
15. ingestion with provenance and without a forced status change;
16. detection of a modified previously ingested background file;
17. a valid project-local link;
18. a valid cross-project link;
19. a missing cross-project target reported as a warning; and
20. a cross-project path attempting to escape the workspace, which is rejected.

## 15. Non-goals

This change will not:

- turn the workspace into a single global knowledge graph;
- require every project to link to another project;
- make background material authoritative;
- replace Git with a separate approval store;
- introduce automatic background agents;
- define a universal ontology of project-document types;
- duplicate linked concepts across projects;
- require vector search or embeddings; or
- implement OKF attested computations unless a later product requirement needs
  them.

## 16. Documentation changes

Update user and contributor documentation to state:

- a workspace contains independent project bundles;
- each project follows OKF 0.2 plus the documented OK Workbench profile;
- project-root index metadata is a deliberate extension;
- `background/` contains user-owned inputs for digestion, not curated project
  knowledge;
- provenance records derivation rather than truth;
- cross-project links may reduce standalone portability; and
- profile validation and strict OKF projection are different checks.

The README should avoid the current implication that the complete `workspace/`
tree is one conformant OKF bundle.

## 17. References

- [Open Knowledge Format 0.2 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [OK Workbench repository](https://github.com/edoloughlin/ok-workbench)
