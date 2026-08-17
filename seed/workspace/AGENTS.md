---
type: Agent Instructions
title: Workspace bundle instructions
description: Default operating instructions for an OKF-structured project workspace.
tags: [okf, workflow, workspace]
status: stable
---

# Workspace instructions

This is an OKF v0.2 workspace bundle. It stores durable project knowledge in
UTF-8 Markdown, with standard Markdown links providing progressive disclosure.

## Orient before acting

1. Start at the closest `index.md`; it lists the concepts in that directory.
2. Read `status.md` when it exists for current action, completed work,
   blockers, and short backlog.
3. Read a project-local `AGENTS.md` before substantive work if present.
4. Confirm the user's requested outcome before changing durable project state.

## Knowledge conventions

- The root `index.md` declares the supported `okf_version`; nested indexes do
  not need frontmatter.
- Concept documents have YAML frontmatter with at least `type`, `title`,
  `description`, and `tags`. Use `generated`, `verified`, `sources`,
  `status`, and `stale_after` when useful.
- Keep raw logs, scripts, captures, and other non-concept evidence in a
  sibling `references/` directory and link to it from the concept that
  interprets it.
- Give every new concept a `type` and a one-line `description`; update the
  containing directory's `index.md` in the same change.
- Use `log.md` for durable dated history, with ISO `YYYY-MM-DD` headings.
- Use task markers consistently: `[ ]` pending, `[!]` blocked (state why),
  and `[x]` complete.

## Project state

Every project root has `index.md`, `status.md`, and `log.md`. Every directory
created beneath a project has an `index.md` at minimum. For substantive
project work, update the project root `index.md`, update `log.md` with the
dated durable history, then refresh `status.md`. Keep `status.md` concise:
one default next action, latest completed outcome, blockers, and a short
ordered later list. If expected project state is missing, flag the gap rather
than inventing history.

- Keep exactly one default item under **Next action**, and confirm it against
  the user's request before acting.
- Treat **Last completed** as summary rather than history; keep earlier
  detail in `log.md` and link to relevant evidence where useful.
- Use `[!]` under **Blockers** and state the condition needed to clear it.
- Before declaring substantive work complete, list the changed project files
  and confirm that `index.md`, `log.md`, and `status.md` were updated—or state
  why a durable update was not warranted.

## Process compliance

- At the start of a new chat session, check the project named in the request
  for its core documents, indexed status and log links, and obvious stale or
  conflicting status. If no project is named, defer the check until work enters
  one; do not scan unrelated projects.
- When entering a project for substantive work, check its local instructions,
  required status sections, concept frontmatter, current index entries, and
  log date headings. Flag gaps rather than inventing compliant-looking state.
- Do not make unrelated bulk compliance edits unless the user asks for them.

## Adding material

- Prefer an existing project directory over loose root files. Create a new
  top-level project only through the workspace project-creation workflow and
  add it to the root `index.md`.
- Put host-specific material in a host-specific directory; give it an
  `index.md` and add it to the root index.
- New directories inside a project require an `index.md`; new material in an
  active project also follows the project-state update sequence above.

## Safety and collaboration

- Treat credentials, private URLs, personal data, and generated chat state as
  outside normal project content; do not copy them into this workspace.
- Do not overwrite user content during template or seed updates.
- Prefer small, reviewable edits and preserve uncertainty rather than claiming
  unsupported facts.
