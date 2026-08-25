---
okf_version: "0.2"
type: Workspace
title: OK Workbench product planning
description: A multi-project planning workspace tracing the first public release and its major feature streams.
tags: [ok-workbench, portfolio, planning]
status: active
---

# OK Workbench product planning

OK Workbench is a local-first, AI-assisted knowledge base where plain Markdown
remains the source of truth. This workspace turns the implementation history
from 17–21 August 2026 into an inspectable product narrative: what was being
solved, what changed, how it was checked, and what should happen next.

## Portfolio

* [Portfolio status](status.md) — the single next action and current programme state.
* [Activity log](log.md) — day-by-day history across all feature streams.
* [Product brief](product-brief.md) — audience, principles, boundaries, and success measures.
* [Delivery roadmap](roadmap.md) — milestones and dependencies beyond the first release.
* [Decision register](decisions.md) — cross-project choices that shape the product.

## Projects

* [Release readiness](release-readiness/index.md) — package, documentation, workspace seed, and public-release checks. **Complete.**
* [Platform sandboxing](platform-sandboxing/index.md) — fail-closed file writes on Linux and macOS, plus authentication portability. **Hardening.**
* [Tool runtime](tool-runtime/index.md) — custom scripts, policy manifests, timeouts, and document extraction. **Validation.**
* [Workspace experience](workspace-experience/index.md) — navigation, project creation, file operations, diffs, and visual polish. **Active.**
* [Chat reliability](chat-reliability/index.md) — parallel turns, visible progress, recovery, and notifications. **Active.**

## Current release picture

| Stream | Outcome represented in source history | Current planning posture |
| --- | --- | --- |
| Release | Installable 1.0.0 source release with seeded OKF workspace | Close-out complete; preserve regression checks |
| Platforms | Linux Bubblewrap and macOS Seatbelt isolation | Document edge cases and broaden manual coverage |
| Tools | Policy-controlled Python/Node tools and common document extraction | Validate formats, diagnostics, and timeout behaviour |
| Workspace | Richer sidebar, CRUD flows, change monitoring, and Git review | Complete accessibility and destructive-action review |
| Chat | Concurrent turns with liveness, recovery, and transient thinking | Run a focused soak test and capture failure modes |
