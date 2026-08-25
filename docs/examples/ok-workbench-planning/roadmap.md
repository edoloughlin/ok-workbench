---
type: Roadmap
title: OK Workbench delivery roadmap
description: Milestones, dependencies, and exit criteria following the first public release.
tags: [portfolio, roadmap]
status: active
---

# Delivery roadmap

## M0 — Public source release (complete, 2026-08-17)

Exit criteria met: buildable Node package, local server, OKF seed, project chat,
Git review, Linux sandbox path, CI, security posture, and source-install docs.

## M1 — Platform parity (substantially complete, 2026-08-18)

Delivered macOS Seatbelt support, device-flow authentication, platform-aware
doctor output, and clearer operating documentation. Remaining exit evidence is
a clean-host macOS validation record covering no-credential browsing, sign-in,
read-only chat, sandboxed writes, and denied network access.

## M2 — Extensible local workflows (validation, 2026-08-20 to 2026-08-21)

Delivered Python/Node tool discovery, adjacent policy manifests, bounded
timeouts, selective environment forwarding, optional network access, and text
extraction from common document formats. Exit requires a format/fixture matrix,
clear malformed-policy diagnostics, and timeout tests at both limits.

## M3 — Confident daily use (active, 2026-08-21 onward)

The browser now supports project/page/directory management, richer navigation,
external change monitoring, parallel chats, notifications, progress states,
and recovery. Exit requires keyboard review, destructive-action copy review,
multi-turn soak testing, and screenshot-ready sample content.

## Candidate M4 — 1.1 quality milestone

- Guided first-run checklist generated from doctor output.
- Accessibility pass for sidebar, popovers, dialogs, and live status updates.
- Better extraction diagnostics with file type, elapsed time, and truncation state.
- Saved validation recipes for releases and platform smoke tests.
- A concise migration note for every compatibility path scheduled for removal.

## Dependency chain

Reliable sandboxing enables safe writes; safe writes enable browser file
management; dependable change monitoring makes those edits trustworthy; clear
turn state and recovery make the complete workflow comfortable for daily use.
