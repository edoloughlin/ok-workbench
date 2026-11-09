# Navigation context menu and native file-manager integration

Add a context menu to files and directories in the left navigation panel. Use this specification as an implementation handoff for GPT-6.1-Terra, Luna, or another coding agent; the requirements do not depend on model-specific behavior.

**Status:** Implementation present. Automated tests cover the core interaction, request boundaries, launcher arguments, concurrent creation, and deletion recovery; the full acceptance matrix has not been individually verified. Live desktop verification is not evaluated.

## Before you begin

- Use the repository's supported Node.js version and install dependencies with `npm ci`.
- Read `src/public/app.js`, `src/public/app.css`, `src/server.js`, and the existing editor, navigation, security, and external-link tests.
- Inspect `src/public/index.html` (or the current HTML entry point) before adding menu or dialog markup. Modify source files, not generated `dist/` files.
- Preserve existing project-entry naming, Markdown metadata, authentication, origin checks, and external-link approval behavior.
- Test desktop launch behavior with mocks in CI. You do not need desktop access to implement or run automated tests.

## Scope and design decisions

Implement a single-item context menu, safe project-entry operations, and a native reveal endpoint. Do not add multi-select, drag-and-drop, clipboard file operations, arbitrary file creation, project deletion, or automatic rewriting of all Markdown references.

| Decision | Required behavior | Reason |
| --- | --- | --- |
| File operations | Apply rename/delete to ordinary project Markdown pages and indexed directories | Matches the existing content model; do not silently broaden it to arbitrary files |
| Delete semantics | Permanent deletion with an explicit confirmation dialog | Keeps the first version portable without implying an unavailable trash/undo service |
| Native integration | Server-side launcher with capability reporting | Browser JavaScript cannot reveal arbitrary local files |
| Linux baseline | Open the containing directory for files; open the directory itself for folders, using `xdg-open` | Predictable baseline without requiring D-Bus libraries |
| Linux enhancement | FileManager1 selection support is optional and not a release gate | Desktop environments differ |
| External links | No mutation or native reveal for symlinks or external-link entries in this version | Avoid bypassing existing approval boundaries |
| Existing interaction | Ordinary clicks navigate; remove active-row click-to-rename | Make rename deliberate and consistent |

**Deletion warning:** The dialog must say that deletion is permanent and that directories include all contents. Never label this operation **Move to trash**. Native trash and undo are deferred, not silently approximated with permanent deletion.

## Architecture

```text
Navigation row
  | contextmenu / Shift+F10 / ContextMenu key / more-actions button
  v
Accessible menu (immutable project + target path)
  +--> Copy relative / absolute path -------------> Browser clipboard
  +--> Rename / New ------------------------------> Existing entry API
  +--> Delete confirmation -----------------------> New delete API
  +--> Reveal ------------------------------------> New reveal API
                                                      |
                                           Request + path validation
                                                      |
                                           Native launcher adapter
                                                      |
                                           Finder / xdg-open / Explorer

Successful mutation --> refresh tree + Git state + reconcile active route
Failure -------------> preserve editor state + show actionable error
```

Keep the native launcher separate from HTTP routing. Inject the process runner and platform information for deterministic tests. Reuse entry validation helpers rather than maintaining different security rules for each route.

### Existing implementation anchors

| File | Existing behavior to reuse or revise |
| --- | --- |
| `src/public/app.js` | `createProjectEntry`, `beginEntryRename`, `commitEntryRename`, `pendingEntryRename`, delegated `nav` listeners, `chatApi`, `loadPage`, `refreshGitStatus` |
| `src/public/app.css` | `.tree-inline-rename` and navigation styling |
| `src/server.js` | `projectEntryParent`, `createProjectEntry`, `renameProjectEntry`, `safePath`, `bundlePath`, `publicPath`, `assertChatRequest`, `/api/projects/:project/entries` routes |
| `test/server.test.mjs` | Existing entry-operation coverage; inspect before extending |
| `test/http-security.test.mjs` | Request-boundary regression patterns |
| `test/markdown-editor.test.mjs`, `test/e2e/` | Editor/navigation behavior and browser-test patterns |

The current rename operation retitles the page or directory `index.md`, renames its filesystem path, and updates a matching link in the parent index. It rejects project roots and standalone `index.md` renames. Keep those protections and naming semantics.

## Implement the interaction

1. Add explicit row metadata for project, public path, kind, and action availability. Use the row's target, not the currently displayed document, when dispatching actions.
2. Add one shared menu and delegated handlers. Do not install a listener for every row on each render.
3. Route **Rename** into the existing inline editor and route creation into the existing creation API with the clicked directory as `parentPath`.
4. Add delete confirmation and the delete API.
5. Add native capability reporting and the reveal adapter/API.
6. Reconcile active routes, editor state, navigation expansion, and focus after successful operations.
7. Add the automated tests and record desktop verification results.

### Menu contents

Preserve this grouping and order; omit actions that do not apply.

| Action | Ordinary page | Indexed directory | Project root |
| --- | --- | --- | --- |
| **New page** | No | Yes | Yes |
| **New folder** | No | Yes | Yes |
| **Rename** | Yes | Yes | No |
| **Copy relative path** | Yes | Yes | Yes |
| **Copy absolute path** | Yes | Yes | Yes |
| Native reveal/open | If available | If available | If available |
| **Delete…** | Yes | Yes | No |

- For protected `index.md` files and non-Markdown files, allow copy and native reveal only. A directory row represents the directory, not its `index.md`.
- For virtual workspace/category rows, retain the normal browser menu unless the row maps unambiguously to a supported target.
- For external-link and symlink rows, allow copying the logical project-relative path only. Keep their existing approval interaction intact.
- For unsupported native integration, show the platform-appropriate action disabled with an accessible reason.
- **Copy relative path** copies the normalized project-relative path, using `/` separators; use `.` for a project root. **Copy absolute path** copies the validated native filesystem path on the server machine, using that platform's path conventions. Neither action copies a browser URL. Report clipboard denial rather than claiming success.
- Fetch the absolute path only when the user selects the action. Explain in accessible help text that it refers to the computer running ok-workbench and may reveal its filesystem layout. Do not expose absolute paths for external-link or symlink rows.
- Right-click must not navigate, expand/collapse the directory, or start editing. Capture the target before any asynchronous operation.
- Close the menu on action, outside click, Escape, navigation, scroll, resize, or tree replacement. Clamp it within the viewport.
- Add an accessible more-actions button per eligible row for touch and keyboard access. Do not make it a nested interactive element inside a link.
- Use `role="menu"`, `role="menuitem"`, `aria-disabled`, and an accessible menu name. Support arrow keys, Home/End, Enter/Space, Escape, Shift+F10, and the ContextMenu key. Tab closes the menu and follows normal focus order. Skip disabled actions during arrow navigation.
- On dismissal, restore focus to the invoking control when it still exists. After deletion, focus the nearest surviving parent row. Use visible focus styles and the existing visual language.

### Editor and navigation consistency

Before any action that reloads or replaces editor content, use the existing unsaved-change guard, or add one if none exists. Offer **Save**, **Discard**, and **Cancel**. If save fails, stop the action. **Cancel** must send no mutation request. Copy and native reveal must not reload or discard the editor.

If deletion would discard edits in the target subtree, the delete dialog must explicitly mention those edits; cancel preserves them. Do not save edits into a path after it has been deleted or renamed. Resolve any in-flight save before mutation.

After a rename, update the active route if it equals the old path or lies below the renamed directory. Use path-segment matching, not a plain string prefix. Preserve the descendant suffix. After deletion of the active page or an ancestor, navigate to the nearest surviving parent index. If an unrelated item changes, keep the active document and unsaved buffer intact.

Refresh navigation and Git status after success. Keep unaffected expanded directories expanded. Do not update the UI optimistically before the server confirms success. Do not claim that arbitrary inbound Markdown links were repaired: parent navigation references are in scope; repository-wide link repair is not.

## API contract

These are proposed additions. Keep the existing create and rename request/response shapes compatible.

| Method and route | Purpose | Success |
| --- | --- | --- |
| `GET /api/native-file-manager` | Report server-side native integration capability | `200` capability object |
| `POST /api/projects/:project/entries/reveal` | Reveal/open a validated project entry | `200` launch result |
| `POST /api/projects/:project/entries/absolute-path` | Return a validated entry's native absolute path for explicit copying | `200` path result |
| `DELETE /api/projects/:project/entries` | Permanently delete an eligible entry | `200` deletion result |

Apply `assertChatRequest` to all three endpoints, including capability reporting. Use `chatApi` on the client. Match the exact reveal route independently of the existing entries route.

### Request fields

All three entry action endpoints accept a JSON body; reject arrays, null, unknown fields, missing values, and wrong types.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Existing public workspace path, in the same representation used by the rename API; not an absolute OS path or URL |
| `confirmPermanent` | boolean | Delete only | Must equal `true`; does not replace request authentication or path validation |

Example deletion request:

```json
{"path":"/example/notes/draft.md","confirmPermanent":true}
```

Use actual paths produced by `publicPath()` in integration tests rather than assuming this illustrative prefix matches every fixture.

### Response fields

| Response | Required fields |
| --- | --- |
| Capability | `platform` (`darwin`, `linux`, `win32`, or `other`), `available` (boolean), `reason` (string or null), `fileLabel` (string), `directoryLabel` (string) |
| Reveal | `path` (public path), `mode` (`reveal` or `open-directory`), `launched` (`true`) |
| Absolute path | `absolutePath` (native absolute filesystem path for the validated entry) |
| Delete | `deletedPath` (public path), `parentLocation` (public path for the surviving parent directory) |

A successful reveal response means the OS launcher accepted the request, not that a human saw the window. Do not return raw command output or environment variables. Only the explicit absolute-path endpoint returns an absolute filesystem path.

## Validate entry operations

The server is authoritative. Client-side disabled actions are not security controls.

- Validate the project ID and require an existing real project; reject the virtual `workspace` project for these operations.
- Resolve targets under that project's canonical root with separator-aware containment checks. Reject traversal, malformed encoding, NULs, absolute filesystem paths, URL schemes, and cross-project paths.
- Reject symlinks in any component beneath the canonical project root, including the target itself, even when a link points back into the project. Approved external links remain unsupported here.
- Protect project roots, standalone `index.md`, repository internals such as `.git`, and application metadata from rename/delete. Permit directory deletion to include its own `index.md`.
- Reject unsupported file types and directories without the required project index for rename/delete. Never follow symlink descendants during directory deletion; remove the link entry only, without touching its target.
- Revalidate immediately before effects. Serialize conflicting in-process entry mutations per project and coordinate parent-index writes with document saves so one operation cannot overwrite another's changes. Document the residual race against external filesystem writers; do not claim portable Node APIs eliminate it.
- Keep collision detection and existing title/slug validation. Do not overwrite another entry.

### Delete behavior and failure recovery

The confirmation dialog identifies the item by name and relative path, warns that deletion is permanent, and explains that a folder includes all contents. Default focus is **Cancel**. Disable repeated submission while the request is pending.

Remove parent-index navigation list items whose direct relative link resolves exactly to the deleted page or directory. Preserve unrelated Markdown, links, whitespace where practical, and links to similarly prefixed names. Use a tested Markdown-aware approach; do not delete arbitrary lines merely because they contain the path. If a matching link occurs in prose rather than a standalone navigation list item, leave it unchanged. Do not require a parent link to exist.

Do not recursively remove the live target before you have a recovery strategy for the parent-index update. Stage the target with a same-filesystem rename into an excluded, server-managed recovery area, update the parent index, then remove the staged target. Store enough metadata to identify the original location. Exclude recovery content from navigation and project evidence collection.

If the index update fails, restore the target and report failure. If rollback fails, retain the staged content and metadata, log recovery instructions, and report `RECOVERY_REQUIRED`. If final cleanup fails after the index update commits, treat logical deletion as committed, retain the recovery record, and log the cleanup failure; do not claim the original target still exists. Never silently remove retained recovery content at startup. Document manual recovery and cleanup in the implementation notes. Test each failure boundary with injected filesystem errors.

## Launch the native file manager

Determine the platform from the server, not the browser user agent. Use fixed executables and argument arrays with `spawn` or `execFile`; never use a shell, interpolated command strings, `eval`, or client-supplied executable names.

| Platform | File action | Directory action | Adapter |
| --- | --- | --- | --- |
| macOS | **Show in Finder** | **Open in Finder** | `/usr/bin/open` with `-R` and the absolute file path; plain `open` for the directory |
| Linux | **Open containing folder** | **Open in file manager** | `xdg-open` with the containing directory or selected directory |
| Windows | **Show in File Explorer** | **Open in File Explorer** | `explorer.exe` with platform-correct selection arguments or directory argument |
| Other | **Open in file manager** (disabled) | Same | Unsupported |

For filenames containing spaces, Unicode, commas, quotes, and shell metacharacters, preserve literal path identity. Test Windows argument handling explicitly; Node does not use POSIX argument escaping on Windows.

Capability checks must not launch windows. On Linux, require a usable launcher and a desktop-session indicator such as `DISPLAY` or `WAYLAND_DISPLAY`; these checks are advisory, so handle launch failures too. Add `OK_WORKBENCH_NATIVE_FILE_MANAGER=0` as an explicit server-side disable switch and document it. Headless macOS/Windows environments can use this switch when automatic detection is inconclusive.

Bound launcher execution and handle spawn errors, timeouts, and exit behavior appropriate to each platform. Do not let a lingering desktop process hang the HTTP request. Mock platform-specific completion behavior, and distinguish launch acceptance from successful window display.

The action runs on the server machine. Include accessible help text: “Opens on the computer running ok-workbench.” A remote browser cannot make the server open the browser machine's file manager; do not imply otherwise. Network deployments should disable this feature explicitly. Do not trust forwarded headers or a browser-platform match as proof of locality.

## Error handling

Return `{ "error": "Human-readable message", "code": "STABLE_CODE" }` for the new entry routes. Preserve existing global request-security responses where applicable. Display errors without discarding editor state; do not expose stack traces or raw launcher stderr.

| HTTP | Code | Cause and client behavior |
| --- | --- | --- |
| `400` | `INVALID_REQUEST` | Invalid body/path syntax; show validation feedback |
| `403` | `ENTRY_FORBIDDEN` | Protected, cross-project, or symlink target; explain the restriction |
| `404` | `ENTRY_NOT_FOUND` | Stale menu target; refresh the tree without replacing an unsaved editor |
| `409` | `ENTRY_CONFLICT` | Conflicting mutation or rename collision; preserve input and offer retry |
| `409` | `RECOVERY_REQUIRED` | Rollback failed; explain that recovery is required and retain content |
| `503` | `NATIVE_UNAVAILABLE` | Disabled, unsupported, or unavailable desktop integration |
| `502` | `NATIVE_LAUNCH_FAILED` | Launcher rejected the operation or timed out |
| `500` | `ENTRY_OPERATION_FAILED` | Filesystem failure; preserve state and show a recoverable error |

## Acceptance criteria

You must satisfy every required criterion. Optional Linux item selection does not block completion.

| ID | Given / when | Required result | Verification |
| --- | --- | --- | --- |
| AC-01 | Right-click an inactive file or directory | Menu targets that item; current route, expansion, and editor remain unchanged | Browser test |
| AC-02 | Open the menu at each viewport edge | Menu remains visible, does not overflow the viewport, and dismisses on outside click, scroll, resize, and Escape | Browser test |
| AC-03 | Use keyboard or more-actions button | All supported actions are reachable; focus and disabled-item behavior match the accessibility contract | Browser test |
| AC-04 | Open menus on page, folder, root, index, non-Markdown, virtual, and external-link rows | Actions follow the capability matrix; protected operations are also rejected by the server | Browser + HTTP tests |
| AC-05 | Rename an existing page or directory | Existing inline editor appears; title, filesystem name, and parent reference update; collision cannot overwrite another entry | HTTP + browser tests |
| AC-06 | Rename the active page or an ancestor directory | Route maps to the new location and preserves any descendant suffix; similarly prefixed sibling paths remain unchanged | Browser test |
| AC-07 | Create from a directory menu | New page/folder appears in the clicked directory, including when another document is active; inline naming works | Browser test |
| AC-08 | Copy a relative or absolute path, or deny clipboard permission | Clipboard receives the documented path for the selected row, or the UI reports failure; the absolute path is fetched only on request and the editor is untouched | Browser + HTTP tests |
| AC-09 | Select Delete and then Cancel | Dialog warns about permanence and descendants; no mutation request occurs and content remains intact | Browser test |
| AC-10 | Confirm deletion of a page or nonempty directory | Only the selected entry/subtree and matching parent navigation items disappear; external symlink targets and unrelated prose remain intact | Filesystem + HTTP tests |
| AC-11 | Delete the active page or an ancestor | UI navigates to the nearest surviving parent and restores sensible focus; Git status and tree refresh | Browser test |
| AC-12 | Mutate an unrelated entry with unsaved editor content | Unsaved content survives; save/discard/cancel guards work for any operation that would replace it | Browser test |
| AC-13 | Mutation overlaps an in-flight save or another mutation | No stale-path save, lost parent-index update, duplicate submission, or silent overwrite occurs | Controlled concurrency tests |
| AC-14 | Inject staging, index-write, rollback, or cleanup failure | Behavior matches the recovery contract; retained content is identifiable and excluded from browsing/evidence | Filesystem tests |
| AC-15 | Send traversal, cross-project, absolute-path, symlink, or protected-target requests | Server rejects them before mutation, process launch, or absolute-path disclosure as applicable | HTTP security tests |
| AC-16 | Omit request protections or use a disallowed origin | New APIs reject the request; capability checks do not weaken existing security | HTTP security tests |
| AC-17 | Reveal valid files/folders on each supported platform | Adapter uses the correct fixed executable, literal arguments, target directory/selection mode, and response mode | Mocked adapter tests |
| AC-18 | Use filenames with spaces, Unicode, commas, quotes, or shell metacharacters | No command interpretation or path substitution occurs | Mocked adapter + path tests |
| AC-19 | Disable native integration, omit the launcher, or run headless Linux | Capability supplies a reason; menu is disabled; direct launch request returns an error without opening anything | Unit + HTTP + browser tests |
| AC-20 | Native launch errors, hangs, or accepts the request | Request completes within the adapter's documented bound and reports only the observed result | Mocked adapter tests |
| AC-21 | Menu target disappears or navigation changes while a request is pending | Stale results cannot mutate a new project's UI or discard its editor state | Browser test |
| AC-22 | Click an active navigation row normally | Navigation does not unexpectedly start rename; existing expansion, links, and approval flows still work | Browser regression test |
| AC-23 | Run repository verification | `npm test` and `npm run test:e2e` pass, or pre-existing/environmental failures are identified with evidence | Command output |

### Manual desktop verification

On macOS and a Linux desktop, verify both file and directory actions, disabled behavior, and a path with spaces. On Windows, verify Explorer selection when a Windows test machine is available. Record each platform as **Passed**, **Failed**, or **Not evaluated**; mocked tests do not establish live desktop compatibility. Do not claim live support was verified on an unavailable platform.

## Deliver implementation in reviewable steps

1. Implement shared entry validation and deterministic tests.
2. Implement the native adapter, capability/reveal routes, and mocked security tests.
3. Implement deletion, parent-index maintenance, and failure recovery tests.
4. Implement menu accessibility, existing create/rename integration, route reconciliation, and editor guards.
5. Add browser tests, run verification, and update this document with implementation notes and remaining limitations.

Keep the changes focused. Do not upgrade Pi, rewrite navigation wholesale, or add a UI framework as part of this feature. Add a dependency only when it materially reduces risk, and explain the choice in the implementation notes.

## Implementation and verification notes

The implementation uses `src/entry-deletion.js` for staged deletion and `src/native-file-manager.js` for native launch. The server serializes project-entry mutations with Markdown saves in the same project. Portable Node filesystem operations do not eliminate races with external writers; the server revalidates paths and checks the parent index immediately before replacing it. A staged move can fail across filesystem boundaries without deleting the original item. Recovery and the disable switch are documented in `README.md`.

The integration tests inject stage, index-update, rollback, and cleanup failures. The browser test covers keyboard menu opening, path copying, rename, cancellation, deletion, preservation of unrelated unsaved edits, and renaming an active ancestor. Mocked tests cover native command arguments and launcher failures. `npm test`, the opt-in server integration test, and `npm run test:e2e` passed in the implementation environment. Not every case in the acceptance matrix has a dedicated test; in particular, desktop launch behavior is not established by the mocks.

| Desktop verification | Result |
| --- | --- |
| macOS Finder | Not evaluated |
| Linux desktop file manager | Not evaluated |
| Windows File Explorer | Not evaluated |

## What's next

- Use this document as the coding-agent task: “Implement `docs/NAVIGATION-CONTEXT-MENU-SPEC.md`, satisfy its acceptance criteria, and report tests and unverified platforms.”
- After implementation, document the disable switch, permanent deletion behavior, and recovery procedure in the user-facing documentation.
- Consider native trash/undo and Linux FileManager1 selection as separate follow-up changes.
