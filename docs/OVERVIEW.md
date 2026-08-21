# What is OK Workbench?

OK Workbench is a **multi-project knowledge base and wiki where an AI does the
filing**. Instead of hand-editing a tangle of notes, you talk to an assistant
that reads, writes, and cross-links your project documents for you — keeping
statuses current, logging what happened, and making sure related files don't
drift apart. Everything lives in plain Markdown on your own machine, so the
result is always yours: readable in any editor, versioned in Git, and useful
with or without an AI in the loop.

## The core idea: AI-managed knowledge, human-owned files

Most note systems fail in one of two ways. Either you maintain everything
yourself and the structure decays as soon as life gets busy, or an AI
"remembers" things in an opaque store you can't inspect or trust. OK Workbench
takes another path:

- **The AI is the primary editor.** You describe what happened or what you
  want; the assistant updates the right documents. You review the changes as
  ordinary Git diffs before accepting them.
- **The files are the source of truth.** The workspace is a portable folder of
  Markdown, avoiding databases or other opaque state.
- **Structure keeps the AI honest.** The workspace follows OKF (Open Knowledge
  Format), a lightweight convention of `index.md` files, YAML frontmatter, and
  standard Markdown links. This gives the assistant a reliable map of the
  workspace, so it can *discover* related documents and update them together
  instead of leaving stale copies behind.

That last point is the fundamental design goal: **aid
discoverability so related files stay consistent and drift is minimised.**
Every directory has an index; every concept document declares its type and a
one-line description; every substantive change updates the project's index,
log, and status (things can drift, but the system monitors and can help getting
things back on track). The assistant is required by the tooling -
not just by prompting - to keep these in sync.

## A planning and coaching aid

OK Workbench's primary role is as a **planning partner or coach**. Each
project carries a small set of living documents that the assistant maintains
for you:

- **`status.md`** — one *next action*, the *last completed* outcome,
  current *blockers*, and a short ordered backlog. The goal is that you
  always know where you left off and what to do next.
- **`log.md`** — a durable, dated history of what actually happened, in ISO
  `YYYY-MM-DD` entries. The status stays terse; the log keeps the detail.
- **`todo.md`** — tasks with consistent markers: `[ ]` pending, `[!]` blocked
  (with the reason stated), `[x]` complete.

You can end a session by saying "log what we did and update the status," and
the assistant does the bookkeeping (or you can let them accumulate and click on
the '*Changes detected...*' reminder to put things back in order). Next session,
it orients itself from the same files. Because the state is explicit and reviewable,
the assistant is also required to *flag gaps rather than invent history* — if the log
and status disagree, you hear about it instead of getting a plausible fiction.

## A simple wiki and knowledge base

Under the planning layer, OK Workbench is a perfectly good general wiki:

- **Browse without any AI.** The local web UI serves your workspace as linked
  pages. No provider credentials are needed for browsing; chat is optional.
- **Multiple projects, one workspace.** Each top-level project is a
  self-contained directory with its own index, status, log, and optional
  per-project assistant instructions (`AGENTS.md`). New projects are created
  from a template so they start out well-formed.
- **Progressive disclosure.** Indexes link to concepts; concepts link to
  evidence in `references/` directories. You (or the assistant) can go from
  "what projects exist" to a specific captured log file in a few hops.

*(We don't have in-place editing - yet - but you can edit files in other tools 
and the system will detect this and help you get things consistent again.)*

## Working with non-Markdown sources

The workspace is Markdown-first, but real projects accumulate PDFs,
spreadsheets, and slide decks. OK Workbench can store these alongside your
notes and the assistant can **extract text from PDF, DOCX, PPTX, XLSX, ODT,
ODP, and ODS files** to fold their contents into your knowledge base — for
example, summarising a report into a concept document that links back to the
original. The extraction is deliberately simple (text out, no layout
understanding, no OCR), so treat it as a way to *reference and digest*
documents rather than a full document-processing pipeline.

## Reviewable by design

AI-managed files only work if you can check the AI's work. OK Workbench makes
review a first-class feature:

- **Batched, structured edits.** The assistant changes project files through a
  single update operation that must include the project's `index.md`,
  `log.md`, and `status.md` — so consistency is enforced mechanically.
- **Git-backed review.** The UI shows project-scoped diffs of unstaged,
  staged, and committed changes, and lets you revert or unstage a change you
  don't like.
- **Sandboxed writes.** File-changing tools run inside a platform sandbox
  (Bubblewrap on Linux, Seatbelt on macOS) with no network and a cleared
  environment. If the sandbox isn't available, writing is disabled rather
  than degraded.

## Extensible with your own tools

Drop an executable Python 3 or Node.js script into `tools/` (or a project's
`tools/`) and the assistant can discover and run it — with per-tool policy
files controlling which environment variables it receives, whether it may use
the network, and how long it may run. This is how you connect the workspace to
the outside world (issue trackers, exporters, fetchers) without ever putting
credentials in your content.

## Who it's for

- **Solo builders and researchers** juggling several long-running projects who
  want a coach that remembers where everything stands.
- **People who distrust opaque AI memory** but want AI leverage — everything
  the assistant knows about your projects is in files you can read.
- **Anyone who wants a local, durable wiki** that happens to have an unusually
  diligent librarian.
- **Neurodivergents** who start multiple projects and can never
  figure out how to finish them.

## Getting started

See the [README](README.md) for installation and the quick start. In short:
initialize a workspace with `ok-workbench init`, serve it with
`ok-workbench serve`, open the browser UI, and start a project-scoped chat.
The bundled [starter workflow](workflow/index.md) and templates give the
assistant (and you) a minimal working loop from day one.
