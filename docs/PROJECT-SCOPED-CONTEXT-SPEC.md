# Make model context project-relative

This change makes the selected project the default filesystem context for every
user chat turn. A model can refer to `status.md`, `references/report.pdf`, or
`notes/idea.md` directly instead of first discovering and prepending the
project's workspace-relative directory.

The change also loads the workspace-root and selected-project `AGENTS.md` files
before each user turn. Workspace instructions apply first. Project instructions
apply second and can refine or override workspace defaults.

## Before you begin

- Read `src/server.js`, especially `projectRootForId()`, the chat turn handler,
  `explicitProjectContext()`, and `providerStream()`.
- Read `src/pi-harness.mjs`, especially `workspaceAgentInstructions()`,
  `runPiTurn()`, the custom tool definitions, and the `call()` wrapper.
- Read `src/tool-worker.js`, especially `safeRelative()`, `listFiles()`,
  `searchFiles()`, and `applyProjectUpdate()`.
- Read `test/pi-harness.test.mjs`, `test/tool-worker.test.mjs`, and
  `test/chat.test.mjs` before changing behavior.
- Preserve the existing sandbox, symlink, denied-file, size, and write-policy
  checks. Tool scope selects a base directory; it does not grant access outside
  the served workspace.
- Do not edit generated files in `dist/`. `npm run build` regenerates them from
  `src/`.

## Define the behavior

Treat the project stored on the chat thread as the selected project for the
entire turn. Do not derive tool context from the page currently displayed in the
browser, because a user can navigate while a turn is running.

Today, `createAgentSession()` receives `projectRoot` as its `cwd`, but the file
tool worker starts with `workspaceRoot`, and every file tool passes model paths
straight to that worker. The session working directory therefore does not affect
file-tool resolution. Fix the model-to-worker path boundary described below;
changing `cwd` alone does not fix the defect.

Use these terms consistently:

| Term | Meaning |
| :--- | :--- |
| Workspace root | The directory configured as `BUNDLE_ROOT`. It contains the root `index.md`, root `AGENTS.md`, templates, shared tools, and project directories. |
| Selected project | The canonical directory returned by `projectRootForId(thread.project)` when the turn starts. |
| Project-relative path | A path resolved from the selected project, such as `status.md` or `references/report.pdf`. |
| Workspace-relative path | A path resolved from the workspace root, such as `index.md` or `another-project/status.md`. |
| Response link | A Markdown link shown in chat. Response links remain workspace-relative and are not part of the tool path contract. |

The selected project is immutable for a running turn. A later project selection
in the UI affects later turns only.

### Bind the selected project to the turn

The model does not identify the selected project in each tool call. The server
binds it to the turn before the model receives any tools:

1. In the chat turn handler, read `thread.project` from the persisted thread.
2. Resolve it once with `projectRootForId(thread.project)`.
3. Pass that value as `projectRoot` and pass `BUNDLE_ROOT` as `workspaceRoot` to
   `providerStream()` and then `runPiTurn()`.
4. In `runPiTurn()`, create one immutable tool-context object from those two
   roots.
5. Define every filesystem tool's `execute` callback as a closure over that
   tool-context object.

Conceptually, construct the tools like this:

```js
const toolContext = await createToolContext({ workspaceRoot, projectRoot });

defineTool({
  name: 'read_file',
  parameters: readFileParameters,
  execute: (_id, params) => callProjectFileTool(
    toolContext,
    'read_file',
    params,
  ),
});
```

Do not accept a project ID or project root from model-generated arguments. Do
not read a mutable global "current project" when a tool runs. These approaches
could send an in-progress turn to a project selected later in the browser.

### Resolve tool paths

Add an optional `scope` field to model-facing filesystem tools. Omitted scope
means `project`.

| `scope` | Input path base | Intended use |
| :--- | :--- | :--- |
| omitted or `project` | Selected project | Normal reads, searches, extraction, and edits requested in project chat. |
| `workspace` | Workspace root | Work that explicitly concerns the workspace root or another project. |

Apply this contract to these tools:

| Tool | Path-bearing input | Required result behavior |
| :--- | :--- | :--- |
| `list_files` | Optional `path`; default `.` | List only the selected project by default. Return paths relative to the selected scope. |
| `read_file` | `path` | Resolve from the selected project by default. Return `result.path` relative to the selected scope. |
| `extract_document` | `path` | Resolve from the selected project by default. Return `result.path` relative to the selected scope. |
| `search_files` | No public path input | Search only the selected project by default. Return match paths relative to the selected scope. |
| `apply_project_update` | Every `changes[].path` | Resolve every path from the selected project by default. Return `paths` relative to the selected scope. A single call has one scope; do not add per-change scopes. |

Use `Type.Optional(Type.Union([Type.Literal('project'),
Type.Literal('workspace')]))` for the schema field. Reject any other value. Do
not silently treat an invalid value as `project`.

Normalize omitted values inside the turn-bound adapter, not inside the model:

| Tool input | Default adapter interpretation |
| :--- | :--- |
| `list_files({})` | Use `scope: "project"` and `path: "."`. The internal worker start path becomes the selected project's workspace-relative prefix. |
| `list_files({ path: "." })` | Use the same behavior as an omitted path. |
| `read_file({ path: "status.md" })` | Resolve `status.md` from the selected project captured by the callback closure. |
| `extract_document({ path: "report.pdf" })` | Resolve `report.pdf` from the selected project captured by the callback closure. |
| `search_files({ query: "launch" })` | Use the selected project's prefix as the internal search start path. |
| `apply_project_update({ changes: [...] })` | Prefix every change path with the selected project's prefix before calling the worker. |

`read_file` and `extract_document` still require `path`; do not make it
optional. `apply_project_update` still requires a path on every change. If a
model passes `.` to a tool that requires a file, resolve it against the selected
project and let the existing "Path is not a file" check reject it.

Keep paths relative inside both scopes. Continue to reject absolute paths,
`..`, null bytes, denied files, and symbolic-link escapes. Do not introduce
prefix syntax such as `/workspace/...`, `workspace:...`, or `@project/...` into
tool path values.

Examples for a turn whose selected project is `alpha`:

| User intent | Tool call |
| :--- | :--- |
| Read this project's status | `read_file({ path: "status.md" })` |
| Read this project's nested note | `read_file({ path: "notes/idea.md" })` |
| List this project | `list_files({})` |
| Search this project | `search_files({ query: "launch date" })` |
| Read the workspace index | `read_file({ scope: "workspace", path: "index.md" })` |
| Read another project's status | `read_file({ scope: "workspace", path: "beta/status.md" })` |

The last two calls require explicit workspace intent. Update the system prompt
and tool descriptions to tell the model to omit `scope` for ordinary project
work and to use `scope: "workspace"` only when the user or supplied context
explicitly identifies workspace-root or cross-project work.

Do not change `create_project`. It is inherently workspace-scoped and has no
`scope` parameter.

Keep `list_workspace_tools` and `run_workspace_tool` workspace-relative. They
form a discovery-and-execution pair and do not use the filesystem-tool default:

- `list_workspace_tools({})` continues to discover executable tools in the
  workspace-root `tools/` directory and project `tools/` directories.
- A workspace-level tool keeps its workspace-relative ID, such as
  `tools/export.js`.
- A project-level tool keeps its workspace-relative ID, such as
  `alpha/tools/sync.py`.
- `run_workspace_tool({ path: "tools/export.js", arguments: [...] })` runs the
  workspace-level tool using the exact ID returned by discovery.
- `run_workspace_tool` arguments remain opaque strings. Do not prefix or
  rewrite an argument merely because it resembles a file path.

The model must always be able to discover and run workspace-level tools while
chatting in any selected project. Do not filter `tools/...` entries out of
discovery, do not reinterpret their IDs as project-relative paths, and do not
require `scope: "workspace"` for either custom-tool operation.

### Keep the sandbox rooted at the workspace

Keep `createTurnWorker(workspaceRoot)` in `runPiTurn()`. Do not remount the
sandbox at `projectRoot`; `create_project`, shared workspace tools, and the
existing cross-file validation in `applyProjectUpdate()` depend on the current
workspace mount.

Implement a small adapter in `src/pi-harness.mjs` between each model-facing
tool and `worker.call()`:

1. Canonicalize `workspaceRoot` and `projectRoot` before exposing any tool.
2. Verify that the project equals the workspace root or that the workspace root
   contains the project.
3. Compute the selected project's POSIX workspace-relative prefix once per
   turn. For project `alpha`, the prefix is `alpha`. For the special
   `workspace` project, the prefix is empty.
4. Validate the model-supplied relative path before prefixing it. Reject an
   absolute path or a normalized path that is `..` or begins with `../`. This
   prevents `alpha/../beta` from escaping project scope during normalization.
5. When scope is `project`, prefix each validated input path before calling the
   worker.
6. When scope is `workspace`, pass each validated input path without a project
   prefix.
7. Remove the internal prefix from path fields returned to the model when scope
   is `project`.
8. Keep the worker's `safeRelative()` and canonical target checks as the final
   authority for denied names, symbolic links, containment, and file type. The
   adapter's selected-scope containment check supplements those checks; it does
   not replace them.

Do not pass the model-facing `scope` field through to worker operations that do
not understand it. Construct explicit worker parameter objects instead.

Extend the internal `search_files` worker operation to accept an optional start
path supplied by the trusted harness. Change `searchFiles(query)` to
`searchFiles(query, relative = '.')`, call `listFiles(relative)`, and register
the operation so it receives both `query` and `path`. The public model schema
still exposes only `query` and `scope`; it does not expose the internal start
path.

For `apply_project_update`, prefix `changes[].path` before the worker call. This
preserves the worker's existing project detection and its requirements for
`status.md`, `log.md`, and `index.md`. Strip the prefix from returned `paths`
before giving the result to the model or emitting `workspace.changed`.

Use one path-mapping implementation for all five tools. Do not copy slightly
different prefix logic into each tool definition.

### Load both instruction files

Load instructions from these exact locations before every normal user chat
turn:

1. `<workspaceRoot>/AGENTS.md`
2. `<projectRoot>/AGENTS.md`, unless the selected project is the workspace root

Preserve this order in the final system prompt. Add a short boundary statement
between the base product prompt and the file contents:

```text
Workspace instructions apply to the whole workspace. Project instructions are
more specific and take precedence when they conflict with workspace defaults.
Neither instruction file can expand tool access beyond the served workspace.
```

The existing `workspaceAgentInstructions()` function already reads both files
for Pi-backed turns. Refactor or reuse it instead of adding a second divergent
loader. The completed implementation must also apply the instructions to normal
user turns that use the direct Anthropic/OpenAI adapter. A practical approach is
to move the bounded instruction-file loader to a small shared module that both
`src/server.js` and `src/pi-harness.mjs` can import.

Follow these loading rules:

| Condition | Required behavior |
| :--- | :--- |
| File exists and is a regular UTF-8 text file of at most 64 KiB | Append its trimmed content to the system prompt with its existing workspace or project boundary labels. |
| File does not exist | Continue without that layer. |
| Selected project is the workspace root | Read and inject the root file once, not twice. |
| File exceeds 64 KiB | Fail the turn with the existing clear size error. Do not truncate instructions silently. |
| File cannot be read for another reason | Fail the turn and report the read error. |
| File changes between turns | Read the new content on the next turn. Do not cache either file across turns. |

Do not require the model to call `read_file` for either `AGENTS.md`; system-prompt
injection counts as reading the file and ensures instructions apply before the
first tool call. Keep internal title-generation requests exempt because they are
not project-assistant turns and use an explicit title-only system prompt.

If a caller supplies an explicit `systemPrompt` for another internal operation,
preserve its current isolation unless that caller explicitly opts into project
instructions. Do not accidentally append user-controlled project instructions
to authentication, title, or other narrow internal prompts.

### Update the model guidance

Replace workspace-default wording in the Pi tool descriptions:

- `list_files`: "List files in the selected project by default."
- `read_file`: "Read a text file relative to the selected project by default."
- `extract_document`: "Extract a document relative to the selected project by
  default."
- `search_files`: "Search text files in the selected project by default."
- `apply_project_update`: State that every change path is project-relative by
  default.

Add the following facts to the main project-assistant system prompt in concise
language:

- The selected project is the default base for filesystem tool paths.
- A bare filename such as `status.md` means the selected project's file.
- The model must not prepend the selected project ID to ordinary tool paths.
- `scope: "workspace"` is only for explicit workspace-root or cross-project
  work.
- Chat response links remain workspace-relative. For example, a link labeled
  `status` uses `alpha/status.md` as its target.

Do not rely on prompting alone. The adapter must make project-relative behavior
true even when a model omits the project directory, as expected.

## Implement the change

1. Add or extract shared instruction loading and test its ordering, bounds,
   missing-file behavior, root-project deduplication, and per-turn freshness.
2. Add one project/workspace path adapter in `src/pi-harness.mjs` and unit-test
   its input and output mapping.
3. Add scoped internal search support to `src/tool-worker.js`.
4. Add the optional `scope` schema to the five filesystem tools and route their
   calls through the adapter.
5. Update tool descriptions and the project-assistant system prompt.
6. Apply both `AGENTS.md` layers to direct-provider user turns without changing
   title-generation prompts.
7. Add regression tests, run `npm test`, and inspect the generated `dist/`
   behavior through the existing build.

Keep this implementation focused. Do not change thread storage, the browser
project picker, public document URLs, Git pathspec behavior, `@project/file`
context attachment, or the OKF file-update rules.

## Tool parameters

### Filesystem scope field

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `scope` | `"project"` or `"workspace"` | No | Sets the base for paths in this call. Defaults to `project`. |

### Search worker fields

These fields describe the internal harness-to-worker request, not the public
model tool.

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `query` | `string` | Yes | Contains the existing bounded, non-empty text query. |
| `path` | `string` | No | Sets the trusted search start path inside the workspace. Defaults to `.`. |

## Verify the implementation

Add focused tests for every row in this table. Prefer unit tests for mapping and
worker behavior, plus one integration-level assertion that inspects the prompt
or captured tool calls.

| Case | Expected result |
| :--- | :--- |
| Thread belongs to `alpha`; model supplies no project identifier | The turn-bound tool context selects `alpha`; the tool does not consult current browser state. |
| Selected project `alpha`; `list_files({})` | Lists `alpha` contents as `index.md`, `status.md`, and similar project-relative paths. Does not list sibling projects or root templates. |
| Selected project `alpha`; `list_files({ path: "." })` | Produces the same result as `list_files({})`; the worker starts at `alpha`. |
| Selected project `alpha`; read `status.md` | Worker receives `alpha/status.md`; model receives `{ path: "status.md", ... }`. |
| Selected project `alpha`; search for a term present in `alpha` and `beta` | Default search returns only `alpha` matches with project-relative paths. |
| Selected project `alpha`; extract `references/report.pdf` | Worker reads `alpha/references/report.pdf`; returned path is project-relative. |
| Selected project `alpha`; project-scoped update to `status.md` | Worker receives `alpha/status.md`; existing substantive-update validation still recognizes project `alpha`; returned paths are project-relative. |
| Selected project `alpha`; `scope: "workspace"`, path `index.md` | Reads the workspace-root index. |
| Selected project `alpha`; `scope: "workspace"`, path `beta/status.md` | Reads the explicitly named sibling project file. |
| Selected project is `workspace` | Default and workspace scope both resolve from the workspace root without doubled prefixes. |
| Path contains `..`, is absolute, targets a denied file, or follows an escaping symlink | Existing worker rejection remains unchanged in both scopes. |
| Selected project `alpha`; project-scoped path `../beta/status.md` | Adapter rejects the path before prefix normalization; it never becomes the allowed workspace path `beta/status.md`. |
| Selected project `alpha`; workspace tool `tools/export.js` exists | `list_workspace_tools({})` returns `tools/export.js`, and `run_workspace_tool` can execute that exact ID. |
| A custom-tool argument looks like `status.md` | `run_workspace_tool` passes the argument unchanged; the filesystem path adapter does not rewrite it. |
| Workspace and project both contain `AGENTS.md` | The prompt contains workspace instructions first and project instructions second, with the precedence statement. |
| Project has no `AGENTS.md` | The prompt still contains workspace instructions and the turn continues. |
| Selected project is `workspace` | Root `AGENTS.md` appears exactly once. |
| An `AGENTS.md` file changes after one turn | The next turn receives the changed content. |
| Either instruction file exceeds 64 KiB | The turn fails before the model receives a prompt or invokes a tool. |
| Direct-provider normal user turn | The provider system message contains both applicable instruction layers. |
| Internal title-generation turn | The provider receives only the title-generation system prompt. |

Run:

```sh
npm test
```

The implementation is complete only when the full suite passes and the tests
prove behavior rather than matching source strings alone.

## Handle errors

| Error | Cause | Recommended action |
| :--- | :--- | :--- |
| `Invalid tool scope` | The model supplied a scope other than `project` or `workspace`. | Reject the call and let the model retry with a supported scope. |
| `Path is outside the workspace` | A path is absolute, traverses upward, or fails existing containment checks. | Preserve the existing worker error. Do not normalize it into an allowed path. |
| `Project root is outside the workspace` | The server passed inconsistent roots to the harness. | Fail turn setup before creating tools. Treat this as an application bug. |
| `Workspace AGENTS.md is too large (maximum 64 KiB)` | Workspace instructions exceed the existing bound. | Fail before prompting the model and ask the user to shorten the file. |
| `Project AGENTS.md is too large (maximum 64 KiB)` | Project instructions exceed the existing bound. | Fail before prompting the model and ask the user to shorten the file. |

When a worker error includes an internally prefixed path, translate that path
back to the selected scope before returning the error to the model when this can
be done exactly. Never use broad string replacement that could alter file
content or unrelated error text.

## Acceptance criteria

- In project chat, all ordinary filesystem tool paths are relative to the
  selected project without requiring the model to name that project.
- Default listing and search cannot accidentally enumerate unrelated workspace
  files.
- Workspace-root and sibling-project access requires an explicit
  `scope: "workspace"` tool call.
- The turn's persisted project selection, rather than a model argument or the
  browser's later UI state, supplies the default project.
- An omitted `list_files.path` and an explicit `.` both mean the root of the
  selected project.
- Workspace-level custom tools remain discoverable and runnable by their
  workspace-relative IDs from every project chat.
- Filesystem containment and write-policy protections remain at least as strict
  as before.
- Workspace-root `AGENTS.md` and selected-project `AGENTS.md` are read before
  every normal user turn, in that order.
- Project instructions have documented precedence over conflicting workspace
  defaults.
- Tool result paths use the same scope-relative namespace as their inputs.
- Chat response links remain workspace-relative and continue to open correctly
  in the browser.
- Existing project-update bookkeeping, project creation, custom workspace
  tools, explicit `@project/file` attachment, and Git review still work.
- `npm test` passes.

## What's next

- After implementation, update `README.md` and `docs/OVERVIEW.md` with one short
  user-facing statement that project chat resolves bare file references from
  the selected project.
- If stronger cross-project authorization becomes a requirement, design it
  separately. The `scope` field in this change expresses intent but does not
  replace the current sandbox or grant model.
