---
type: Brief
title: OK Workbench product brief
description: Product intent, audience, principles, boundaries, and measurable outcomes.
tags: [product, brief, strategy]
status: stable
---

# Product brief

## Product promise

Give people a durable, local project memory that an assistant can maintain
without hiding the result in an opaque database. A user should be able to ask
“where was I?”, inspect the Markdown answer, review the Git diff, and continue
working with one obvious next action.

## Primary users

- Solo builders coordinating several technical or research projects.
- Researchers who need source material, interpretations, and decisions linked.
- Privacy-conscious users who want AI help without surrendering ownership of their notes.
- Teams evaluating an AI-maintained knowledge workflow before adopting shared hosting.

## Product principles

1. **Files are the source of truth.** Project knowledge stays portable and readable without the application.
2. **Discoverability prevents drift.** Every project and directory has an index; substantive work refreshes status and log together.
3. **Review precedes trust.** Git-backed diffs make assistant edits inspectable and reversible.
4. **Writes fail closed.** Missing platform isolation disables mutation rather than silently reducing protection.
5. **Extensibility is explicit.** Custom tools declare the environment, network access, and time budget they need.
6. **Current state stays small.** Status answers what to do now; the log preserves the longer story.

## Measures for the next milestone

- A returning user can locate the next action for any project in under 30 seconds.
- Project creation always produces indexed core files or reports a specific validation failure.
- A stalled or interrupted chat turn presents a recoverable state without duplicating a conversation.
- Supported document types either return useful text or a bounded, actionable error.
- Every file-changing path is covered by an available OS sandbox or is visibly disabled.

## Explicit non-goals

- Hosted multi-user collaboration and server-side tenancy.
- Autonomous background execution without a user-visible review step.
- Secret storage inside the workspace.
- Full-fidelity office-document rendering, OCR, or layout reconstruction.
- Replacing Git with a proprietary change-history system.
