---
type: Agent Instructions
title: OK Workbench planning workspace instructions
description: Local conventions for maintaining the product planning portfolio.
tags: [okf, planning, workspace]
status: stable
---

# Planning workspace instructions

This workspace is a demo-quality but internally consistent planning record for
OK Workbench. It follows OKF v0.2 conventions and uses the implementation Git
history as its evidence base.

Before changing a project, read its `index.md`, `status.md`, and newest
`log.md` entry. For substantive work, update those three files together. Keep
exactly one item under **Next action**, preserve ISO dates, and use commit
hashes where an implementation claim can be checked against the source tree.

Project documents describe product intent, decisions, acceptance criteria,
and follow-up work. They must not contain credentials, private URLs, chat
state, or invented customer claims. Planned work should be clearly distinct
from shipped implementation.
