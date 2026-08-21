---
type: Decision Register
title: OK Workbench decision register
description: Cross-project product and architecture decisions preserved with consequences.
tags: [portfolio, decisions, architecture]
status: stable
---

# Decision register

## D-001 — Markdown and Git remain authoritative

**Date:** 2026-08-17
**Decision:** Store durable knowledge in user-owned Markdown and use Git for
review rather than introducing an application database for project content.
**Consequence:** Index quality and coordinated status/log updates are product
correctness concerns, not merely documentation style.

## D-002 — Mutating tools fail closed

**Date:** 2026-08-17
**Decision:** Disable file-changing assistant tools when the platform sandbox
cannot be verified. Browsing and read-only chat may remain available.
**Consequence:** Doctor output and platform-specific installation guidance must
make unavailable capabilities understandable.

## D-003 — Project creation is template-backed

**Date:** 2026-08-17
**Decision:** Create top-level projects only through a verified workflow that
starts from the supplied project template.
**Consequence:** New projects begin with `index.md`, `status.md`, `log.md`, task
state, review structure, and local instructions rather than accumulating repair work.

## D-004 — Tool capability is granted per script

**Date:** 2026-08-20
**Decision:** Discover executable Python/Node scripts and read capability from
adjacent policy JSON: selected environment names, a network flag, and timeout.
**Consequence:** Secrets remain outside content, malformed policy must be
diagnosed, and network permission is a deliberate broad grant until host-level
allowlisting exists.

## D-005 — Concurrent chat needs explicit liveness

**Date:** 2026-08-21
**Decision:** Allow parallel turns, but distinguish queued, thinking, tool,
completed, interrupted, and recoverable states in the UI.
**Consequence:** Correctness includes recovery after reload/disconnect and
preventing duplicate empty conversations, not just rendering the final answer.

## D-006 — Extraction is text-first

**Date:** 2026-08-21
**Decision:** Extract useful text from common office formats without promising
OCR, layout fidelity, formulas, or visual interpretation.
**Consequence:** The UI and docs must describe extraction as an aid to indexing
and summarisation, and preserve the original file as evidence.
