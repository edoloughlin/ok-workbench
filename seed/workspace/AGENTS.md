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
- Use `log.md` for durable dated history, with ISO `YYYY-MM-DD` headings.
- Use task markers consistently: `[ ]` pending, `[!]` blocked (state why),
  and `[x]` complete.

## Project state

Active projects normally have `index.md`, `status.md`, and `log.md`. Keep
`status.md` concise: one default next action, latest completed outcome,
blockers, and a short ordered later list. Update the log before refreshing
status at the end of substantive work. If expected project state is missing,
flag the gap rather than inventing history.

## Safety and collaboration

- Treat credentials, private URLs, personal data, and generated chat state as
  outside normal project content; do not copy them into this workspace.
- Do not overwrite user content during template or seed updates.
- Prefer small, reviewable edits and preserve uncertainty rather than claiming
  unsupported facts.
