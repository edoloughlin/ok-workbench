---
type: Log
title: OK Workbench portfolio log
description: Durable dated history of product work across the planning portfolio.
tags: [portfolio, log]
---

# Portfolio log

## 2026-08-21

- Reframed the final development push around three user-visible outcomes: projects can be created and managed without leaving the browser, long-running chats remain legible, and common office documents can contribute text to the knowledge base.
- Landed the new visual system and sidebar refinements (`4469c74`, `3bfaf77`), then simplified project file ordering (`7624140`) so core planning documents stay prominent.
- Added parallel chat turns and notifications (`4a474a4`), clarified message initiators (`38f31b8`), and followed with liveness, recovery, and transient thinking states (`669bb11`, `8115ccb`).
- Added creation and management flows for projects, pages, and directories (`23de80c`, `c9d7411`), including backend timestamps and inline naming cancellation.
- Added project change monitoring and surfaced process validation errors (`32b3134`) so externally edited files and rejected updates are visible rather than silently stale.
- Extended the tool runtime with text extraction for PDF, DOCX, PPTX, XLSX, ODT, ODP, and ODS (`6afd6a0`) and closed timeout-policy edge cases (`960c2db`, `c6ee8ea`).
- Finished the product narrative in `docs/OVERVIEW.md` (`d5f76cb`) and reconciled all five project records against the implementation history.

## 2026-08-20

- Improved chat provenance and reading quality: agent responses now expose model and effort, user input renders as Markdown, and file diffs use project-relative paths (`113213f`, `a787679`, `41bb7c0`).
- Expanded the content column and corrected padding to make dense project pages and diffs easier to scan (`5613104`).
- Introduced discoverable Python and Node.js workspace tools with adjacent policy manifests, explicit environment grants, network policy, and captured output (`5084848`).
- Split out a macOS network sandbox profile so DNS and certificate access can be granted deliberately without weakening the default write sandbox (`61c6e0e`).
- Agreed that extensibility remains opt-in and local: scripts live in the workspace, secrets stay in the launching environment, and malformed policy metadata becomes a visible diagnostic.

## 2026-08-19

- Corrected external-link behaviour so reference material opens in a new tab without losing the current workspace context (`46317f8`).
- Reviewed the first two days of work and separated remaining effort into chat reliability, workspace experience, and tool-runtime streams.
- Recorded a usability concern: progress was difficult to interpret when more than one conversation or tool call was active. This became the acceptance basis for the later liveness work.

## 2026-08-18

- Added macOS Seatbelt profiles and GitHub Copilot device-flow authentication, with CI and documentation updates (`69564fb`).
- Consolidated platform-specific workspace and sandbox handling (`1040b94`) and repaired the device-code merge path (`221c122`).
- Added an in-progress task treatment and the first todo popover, then exposed the selected model and corrected explanatory copy (`55a74b8`, `ce4e354`, `c584e9c`, `12b01dc`).
- Tightened Markdown rendering and rewrote the macOS guide around operational setup and threat boundaries (`6b87c31`, `bf207d6`).
- Decision: browsing may remain available when isolation is unavailable, but all file-changing tools must fail closed.

## 2026-08-17

- Published the initial source release (`749279a`) with the Node CLI, local server, project-scoped chat, Git review, starter workflow, templates, security documents, CI, and test coverage.
- Documented installation from a source checkout (`ee20b3b`) and fixed Bubblewrap environment failures plus doctor diagnostics (`1f4f17c`).
- Added verified template-backed project creation (`56f5c0f`) so new project folders start discoverable and valid.
- Enforced coordinated updates to project `index.md`, `log.md`, and `status.md` (`fe4d08f`) to keep AI-managed knowledge from drifting.
- Opened separate planning tracks for public-release close-out, platform parity, and the post-release interaction backlog.
