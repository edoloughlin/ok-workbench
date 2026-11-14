# Browse approved external directories in project navigation

Render an approved external directory symlink as a browsable, read-only subtree in the left project navigation. Users can expand linked directories and open their descendants through the existing project-relative alias instead of relying only on the directory listing in the document pane.

**Status:** Implementation contract for 6.1-luna. Implement only the behavior in this document. If an implementation choice would broaden filesystem authority, change approval semantics, or require a new product capability, stop and report the conflict instead of inventing scope.

## Before you begin

- Use the Node.js version in `package.json` and modify authored files under `src/` and `test/`, not generated files under `dist/`.
- Read `docs/EXTERNAL-SYMLINKS-SPEC.md`, `docs/THREAT-MODEL.md`, `src/external-links.js`, `src/server.js`, `src/public/app.js`, and `src/public/app.css`.
- Read `test/external-links.test.mjs`, the external-link case in `test/http-security.test.mjs`, and the navigation browser tests under `test/e2e/`.
- Preserve the current external-link approval registry, project binding, alias URLs, denied-name policy, nested-symlink rejection, read-only enforcement, and per-turn model snapshots.
- Treat the server as authoritative. Hiding mutation controls in the browser does not replace server-side rejection.

## Keep the scope fixed

This change affects only the browser's left project navigation for an already approved external directory link.

| In scope | Required behavior |
| :--- | :--- |
| Approved external directory root | Render it as an expandable navigation directory. |
| Eligible descendant directories | Render them as expandable read-only navigation directories. |
| Eligible descendant files | Render them as read-only navigation file links. |
| Navigation and direct URLs | Keep using `/workspace/<project>/<alias>/...` paths. |
| Current-location behavior | Open ancestors, mark the active entry, and preserve project breadcrumbs. |
| Main document pane | Keep the existing directory page and file rendering behavior. |
| Security and limits | Reuse the existing external-link binding, filtering, depth, entry, and containment policies. |
| Tests | Add HTTP and browser coverage for expansion, navigation, filtering, and read-only behavior. |

The following work is explicitly out of scope:

- Do not add external writes, rename, delete, create, move, drag-and-drop, upload, artifact promotion, or native file-manager reveal.
- Do not add approval for nested symlinks or follow any descendant symlink, including one that points inside the approved target.
- Do not change model access, snapshots, chat capabilities, workspace-mode behavior, cross-project grants, or instruction loading.
- Do not add a new approval flow, permission level, settings page, API endpoint, database, dependency, UI framework, or background watcher.
- Do not make external links projects, include external files in project statistics, Git state, workspace review evidence, definitions, search indexes, or project discovery.
- Do not expose canonical host paths, link targets, grant IDs, or filesystem errors in navigation payloads, browser URLs, DOM attributes, or visible labels.
- Do not redesign ordinary navigation or change internal symlink behavior.
- Do not implement lazy loading in this version. Build the bounded external subtree as part of the existing `GET /api/project` response.
- Do not use the linked directory's `index.md` to rename the external directory, mark it indexed, enable creation controls, or treat it as project metadata.

If a requirement in this document conflicts with `docs/EXTERNAL-SYMLINKS-SPEC.md`, preserve the stricter security boundary. Stop and document the conflict if preserving it prevents an acceptance criterion.

## Preserve the access boundary

```text
Approved project alias
/workspace/alpha/builder-workflow
              |
              v
+-------------------------------+
| Server validates saved grant  |
| and current symlink binding   |
+---------------+---------------+
                |
                v
+-------------------------------+
| Bounded external tree reader  |
| - canonical target containment|
| - denied-name filtering       |
| - no descendant symlinks      |
| - depth and entry limits      |
+---------------+---------------+
                |
                v
+-------------------------------+
| /api/project navigation tree  |
| alias paths only              |
+---------------+---------------+
                |
                v
+-------------------------------+
| Read-only expandable sidebar  |
+-------------------------------+
```

The navigation tree describes content that the existing browser reader can already open. It does not create a second access path and must not weaken `readableWorkspacePath()` or `externalBrowserPath()`.

## Extend the existing navigation payload

Keep the existing `GET /api/project?path=...` route and existing navigation item shapes compatible. Extend only approved external directory entries.

An approved external directory root retains `type: "external-link"` so existing approval and status handling remains compatible. Add `children`, `readOnly`, and `navigationState`:

```json
{
  "type": "external-link",
  "label": "builder-workflow",
  "path": "/workspace/alpha/builder-workflow",
  "linkPath": "builder-workflow",
  "status": "approved",
  "kind": "directory",
  "readOnly": true,
  "navigationState": "complete",
  "children": [
    {
      "type": "directory",
      "label": "docs",
      "path": "/workspace/alpha/builder-workflow/docs",
      "external": true,
      "readOnly": true,
      "children": []
    },
    {
      "type": "file",
      "label": "README.md",
      "path": "/workspace/alpha/builder-workflow/README.md",
      "external": true,
      "readOnly": true
    }
  ]
}
```

### Navigation fields

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `children` | array | Approved directory root and external descendant directory | Eligible direct children in deterministic display order. |
| `external` | boolean | Descendants | Must be `true`; the approved root remains identifiable by `type: "external-link"`. |
| `readOnly` | boolean | Root and descendants | Must be `true`. The client uses it for presentation only; the server remains authoritative. |
| `navigationState` | enum | Approved directory root | `complete`, `unavailable`, or `limit_exceeded`. |

Do not add `children` to unapproved, changed, or missing links. Approved external file links remain leaf entries and retain their current behavior.

### Build the external subtree

Add one shared server-side helper for filtered external directory enumeration. Reuse it from navigation rather than duplicating ad hoc `fs` traversal in `navigationTree()`.

For each approved external directory grant:

1. Revalidate the stored grant against the current workspace, project, alias, link text, canonical target, and target kind.
2. Traverse from the stored canonical target, not by following the workspace symlink.
3. Produce browser paths from the lexical workspace alias.
4. For each candidate, apply the same protected-name, containment, file-type, hard-link, and descendant-symlink checks used by external browser reads.
5. Include only regular files and real directories that `readableWorkspacePath()` can open through the same alias.
6. Sort directories before files, then sort each group by `label.localeCompare()`, matching the existing external directory page.
7. Count depth from the approved target as depth `0`. Enforce the existing maximum depth of `12` and the existing examined-entry limit of `10,000` across all approved external directory subtrees in one project-navigation response.
8. Do not read file bodies, parse external Markdown, inspect headings, calculate definitions, or execute external content while building navigation.

The tree and direct browser access must agree. Include a navigation item only when the existing external browser resolver accepts the corresponding alias URL.

### Handle traversal outcomes

Use these exact outcomes; do not invent fallback traversal behavior.

| Condition | Root result | Descendant result |
| :--- | :--- | :--- |
| Grant remains valid and traversal completes | `navigationState: "complete"` with complete children | Include eligible entries. |
| The user or another process retargets or removes the root link, or changes its kind | Existing `changed` or `missing` status; no `children` | Include nothing. |
| Descendant is a symlink, hidden/protected, special file, hard-linked file, or skipped directory | Keep root `complete` | Omit that entry completely. |
| Descendant disappears between enumeration and validation | Keep root `complete` | Omit that entry; do not expose an error or host path. |
| A permission or filesystem error prevents a complete traversal | `navigationState: "unavailable"`, `children: []` | Publish no partial subtree. |
| Traversal exceeds the depth or examined-entry limit | `navigationState: "limit_exceeded"`, `children: []` | Publish no partial subtree. |

A failure in one external grant must not remove ordinary project navigation or another valid external grant. Do not return a partially accumulated subtree for the failed grant.

## Render the read-only subtree

Render an approved external directory with the same disclosure pattern as an ordinary directory: a `<details>` element, a summary row, a navigable directory link, and nested children.

```text
Project pages
  > builder-workflow                 External - read only
      > docs
          architecture.md
      > scripts
          build.mjs
      > templates
      adopt.sh
      README.md
```

Apply these interaction rules:

- Selecting the directory name opens its existing directory page in the document pane.
- Selecting the disclosure control expands or collapses children without changing the current document.
- Selecting a descendant file opens it with the existing renderer.
- Selecting a descendant directory opens its existing directory page and keeps its navigation ancestors expanded.
- On direct navigation or browser Back/Forward, open every external directory ancestor of the active route.
- Preserve expanded external directories across `loadPage()` and `refreshEntryTree()` using the same public-path mechanism used for ordinary directories.
- Mark only the exact current entry active. Use path-segment comparisons for ancestor detection; `docs-old` is not a descendant of `docs`.
- Keep the root subtitle **External · read only**. Do not repeat that full subtitle on every descendant. Give descendant rows an accessible read-only name or description.
- Use existing file icons by extension. Use the existing directory icon and disclosure styling for external directories.
- If `navigationState` is `unavailable`, show one noninteractive child label: **Content unavailable**.
- If `navigationState` is `limit_exceeded`, show one noninteractive child label: **Too large to show in navigation**.
- Keep the root directory link usable for both non-complete states so the existing document-pane request can report its current result.

### Keep all mutation controls unavailable

For the approved external root and every descendant:

- Do not render **Create page**, **Create directory**, **Rename**, **Delete**, **Copy absolute path**, or native reveal actions.
- Keep the existing restricted context-menu behavior: **Copy relative path** may use the logical project-relative alias only.
- Mark context-menu rows as restricted so a later generic menu change cannot infer ordinary directory capabilities.
- Do not set `data-entry-type`, `data-menu-directory`, or other mutation-enabling metadata unless the menu code explicitly treats `external` and `readOnly` as a denial that takes precedence.
- Do not allow an external `index.md` to enable creation actions.

Direct requests to existing mutation endpoints must continue to reject the root and all descendants before any filesystem change.

## Preserve page and breadcrumb behavior

Keep the existing main-pane representation for an external directory:

```text
builder-workflow / builder-workflow
builder-workflow

External directory · read-only

    docs/
    scripts/
    templates/
    adopt.sh
    ADOPTING.md
    README.md
```

This specification adds sidebar browsing; it does not replace that page.

For nested routes:

- Keep breadcrumbs rooted at the owning project and composed from alias path segments.
- Never use the canonical target basename as a breadcrumb unless it is also the alias basename.
- Keep browser history and copied URLs on the workspace alias.
- Keep `document.title`, the project picker, chat project binding, and selected project unchanged.
- Keep project statistics based on ordinary project entries only. External descendants do not increase document, folder, or indexed counts.

## Update implementation files

| File | Required change |
| :--- | :--- |
| `src/server.js` | Build bounded children for approved external directory navigation entries and return the specified payload. |
| `src/external-links.js` | Add or expose a reusable filtered traversal helper if needed; preserve approval and snapshot contracts. |
| `src/public/app.js` | Render approved external directories and descendants as read-only tree nodes; preserve expansion and active-route behavior. |
| `src/public/app.css` | Add only the minimal read-only/status styling needed for the existing tree design. |
| `test/external-links.test.mjs` | Cover filtered deterministic traversal and limit/error outcomes at module level when helper logic lives there. |
| `test/http-security.test.mjs` | Verify the navigation payload, aliases, filtering, status changes, and absence of host paths. |
| `test/e2e/` | Verify disclosure, nested navigation, active state, browser history, accessibility, and absent mutation actions. |

Do not modify the Pi runtime, chat provider integration, workspace review, Git operations, sandbox profiles, or external snapshot format for this feature.

## Handle errors

Keep existing structured external-link errors for direct reads and approvals. The navigation response uses `navigationState` for bounded subtree failures so one external directory cannot make the whole project navigation unusable.

| State or error | Cause | Required behavior |
| :--- | :--- | :--- |
| `changed` | Approved alias no longer matches its stored binding | Show the existing changed-link leaf and require reapproval. |
| `missing` | Alias or destination is unavailable | Show the existing missing-link leaf. |
| `navigationState: "unavailable"` | Complete filtered enumeration failed | Show no partial children and the fixed unavailable label. Log only safe diagnostic details server-side. |
| `navigationState: "limit_exceeded"` | Traversal exceeded a depth or entry bound | Show no partial children and the fixed size label. Do not raise the existing limits. |
| `EXTERNAL_NESTED_LINK` | A user directly requests a descendant symlink | Preserve the existing rejection; never add it to navigation. |
| `EXTERNAL_READ_ONLY` or existing entry-forbidden response | A mutation targets external content | Preserve server rejection and make no filesystem change. |

Do not place canonical paths, raw `fs` messages, stack traces, or link text in client-visible errors.

## Verify acceptance criteria

Satisfy every criterion before declaring the feature complete. Use temporary workspace, external, and state directories; never use real home or credential paths.

| ID | Given / when | Required result | Verification |
| :--- | :--- | :--- | :--- |
| AC-01 | A project contains an approved external directory with nested files and directories | The root appears as an expandable read-only directory with the complete eligible subtree | HTTP + browser test |
| AC-02 | The user expands and collapses the approved root and nested directories | Disclosure changes without navigating; clicking a directory name navigates | Browser test |
| AC-03 | The user opens a nested file from the external subtree | The existing renderer opens the alias URL, marks the exact file active, and keeps ancestors expanded | Browser test |
| AC-04 | The user opens a nested external URL directly or uses Back/Forward | The correct project remains selected and all active-route ancestors open | Browser test |
| AC-05 | Navigation refreshes after page load or an unrelated project mutation | Expanded external directories remain expanded and the active route remains stable | Browser test |
| AC-06 | The external target contains hidden names, credentials, `.git`, `node_modules`, `__pycache__`, hard links, special files, and descendant symlinks | None appear in the navigation payload or DOM and direct reads remain rejected where applicable | Module + HTTP test |
| AC-07 | A descendant symlink points inside the approved target | It is still omitted and never followed | Module + HTTP test |
| AC-08 | Two names share a prefix, such as `docs` and `docs-old` | Expansion and active-state logic uses path boundaries and does not confuse them | Browser test |
| AC-09 | The user or another process retargets or removes the approved link, or changes it from directory to file | Children disappear; existing `changed` or `missing` UI and reapproval behavior remain intact | HTTP + browser test |
| AC-10 | Traversal exceeds depth or entry limits | The server publishes no partial subtree; the root shows **Too large to show in navigation**; the implementation does not raise limits | Module + HTTP + browser test |
| AC-11 | Traversal encounters a permission or injected filesystem failure | The server publishes no partial subtree; other navigation remains usable; the root shows **Content unavailable** | Controlled filesystem + browser test |
| AC-12 | Multiple approved external directories exist and one fails | The failure affects only that grant; valid grants and ordinary project navigation still render | HTTP test |
| AC-13 | The external root or any descendant opens a context menu | Only the logical relative-path action is available; mutation, absolute-path, and native reveal actions are absent | Browser test |
| AC-14 | A caller sends create, rename, save, move, delete, reveal, or absolute-path requests for an external descendant | The server rejects the request before changing files or disclosing a host path | HTTP security test |
| AC-15 | A test inspects the navigation response and rendered DOM | They contain alias paths only and no canonical target, link text, grant ID, or raw filesystem error | HTTP + browser test |
| AC-16 | The external directory contains `index.md` | It can open as a read-only file, but it does not rename the directory, enable creation controls, or change project metadata/statistics | HTTP + browser test |
| AC-17 | The approved external link targets one regular file instead of a directory | It remains a non-expandable approved external file entry | HTTP + browser regression test |
| AC-18 | A link has `unapproved`, `changed`, or `missing` status | It remains a leaf with the existing approval/status interaction and no descendant enumeration | HTTP + browser regression test |
| AC-19 | Ordinary internal directories and internal symlinks are present | Their current navigation, mutation, and security behavior remains unchanged | Regression tests |
| AC-20 | A user navigates by keyboard at a narrow viewport | Disclosure controls, links, active state, focus indication, and read-only labels remain operable and understandable | Browser accessibility test |
| AC-21 | Repository verification runs | `npm test`, the external-link integration test, `npm run test:e2e`, and `git diff --check` pass; otherwise, the implementation report identifies pre-existing or environmental failures with evidence | Command output |

Run at least:

```sh
npm test
OK_WORKBENCH_INTEGRATION=1 node --test test/http-security.test.mjs
npm run test:e2e
git diff --check
```

A skipped integration or browser test does not verify its acceptance criterion. Report skipped environments explicitly.

## Implement in reviewable steps

1. Add the shared bounded external-navigation traversal and module tests.
2. Extend `GET /api/project` and add HTTP security assertions for the exact payload.
3. Add read-only external tree rendering without changing ordinary tree nodes.
4. Add browser tests for expansion, direct routes, history, restricted actions, and accessibility.
5. Run the required checks and update implementation notes with only observed results.

Keep each step within this specification. Do not combine this work with dependency upgrades, navigation redesign, external-link permission changes, or unrelated refactoring.

## Stop when blocked

Stop implementation and report the evidence if any of these conditions occurs:

- Complete traversal cannot reuse the existing approval and browser-read boundary without exposing canonical paths.
- The existing mutation APIs accept an external descendant and fixing them would require a broader entry-security redesign.
- Enforcing the required bounds would change the approved external-link contract.
- A new endpoint, dependency, permission, or product interaction appears necessary.
- Tests reveal a conflict between this document and the stricter external-link security specification.

The report must identify the attempted path, relevant files and tests, the security or product conflict, and the smallest decision needed from the maintainer. Do not substitute a broader implementation.

## What's next

- Implement this document as a focused branch and report acceptance criteria by ID.
- Consider lazy navigation, descendant-symlink approval, or external mutations only in separate future specifications.
