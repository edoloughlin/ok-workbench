# Critique: workspace overview for an ADHD-friendly portfolio

A critical review of [WORKSPACE-OVERVIEW-SPEC.md](WORKSPACE-OVERVIEW-SPEC.md) and its
[interactive mockup](mockups/workspace-overview.html), evaluated against a specific goal:
**can the LLM keep an ADHD brain focused and prioritised across multiple projects —
proactively keeping things on track, not just mopping up after focus is lost?**

Status: review complete; the recommendations below have been folded back into the
specification and mockup. Sections marked **Applied** identify where.

## Verdict in one paragraph

The original design was an unusually honest, well-engineered *review dashboard* — but a
pull system, and ADHD is fundamentally a *point-of-performance* problem. It mopped up
well and kept things on track only partially. The expectation is partially realistic:
an LLM review can externalize working memory, triage priorities honestly, lower
initiation cost, and escalate with evidence — but it cannot reach a user whose
Workbench is closed, and no spec change removes that limit.

## What the design already got right (preserved deliberately)

These map directly onto the ADHD literature and must not be regressed:

- **Max three attention items, one question, one recommended focus.** Working-memory
  and choice-overload constraints are real; a wall of flags produces avoidance.
- **No manufactured encouragement, fake health scores, or invented deadlines.** ADHD
  users are veteran consumers of nagware and abandon tools on the first detected lie.
  The honesty constraints build the one thing that keeps a tool out of the graveyard:
  trust.
- **Shame-free language.** "No recorded outcome since…" not "You have not worked on…".
  Rejection-sensitive dysphoria is near-universal in ADHD; accusatory copy triggers a
  shame → avoidance → more drift spiral where the user stops opening the page
  *because* the page makes them feel bad.
- **"Since the last review" verified wins.** Earned progress salience is dopaminergic.
- **Friction asymmetry** (initially accidental, now specified): **Revisit** is a
  top-level action while **Dismiss**/**Resolved elsewhere** sit inside the evidence
  disclosure. Deferring should be easier than dismissing for impulsive interaction.
- **Chat-draft handoff.** Reducing activation energy for task initiation is the single
  biggest lever (Barkley: ADHD is a disorder of performance, not knowledge).
- **Guilt-free parking** with no neglect nudges before the revisit condition.

## Findings and applied changes

### 1. Pull-only delivery misses the point of performance

The overview renders only at `/workspace`. Knowledge held elsewhere does not transfer
to the ADHD moment of action; a user hyperfocused inside one project never sees another
project's Friday deadline.

**Applied:** an in-project **cross-project attention strip** — one dismissible line
showing the single most urgent evidenced item from *another* project, honoring snoozes
and dismissals, linking to the overview. No external integrations required. This is
the highest-leverage change in the revision.

### 2. Time blindness was unaddressed

ADHD time perception is binary: *now* and *not now*. Dates rendered as prose
("Friday", "2026-09-25") do not motivate; shrinking runway does.

**Applied:** for every *evidenced* date, the server renders remaining time concretely —
runway chips ("4 days left"), never invented dates. The server also enforces an urgency
floor as an evidenced date approaches, so a "watch" item cannot still read "Prevent
drift" two days before a recorded deadline.

### 3. Proposed actions were not small enough

"Agree the launch scope" is a wall, not a step. Implementation-intention research
(Gollwitzer) shows concrete if-then first steps outperform goal statements, with larger
effects under executive dysfunction.

**Applied:** every attention item now requires a `firstStep` — one physical, startable
step with a visible finish, sized around fifteen minutes or less. **Discuss next step**
prefills the first step, not the goal. A **"I have 30 minutes"** quick action converts
the open-ended dashboard into a bounded, winnable session.

### 4. Importance is the wrong motivational currency

ADHD motivation runs on urgency, novelty, interest, and challenge (the interest-based
nervous system), not importance. Ranking by importance is correct for *prioritisation*
but weak for *activation*.

**Applied:** briefing and item copy lead with consequence and immediacy; the time-boxed
session entry point supplies bounded challenge. Prioritisation logic is unchanged.

### 5. No model for ignored advice

The original spec suppressed dismissed items and forbade manufactured repetition —
respectful, but it meant ignored advice was repeated at the same volume forever, which
an ADHD brain experiences as silence. The user asked directly: *how should the LLM
react when its advice is ignored, and can it spell out consequences?*

**Applied — an escalation ladder with these principles:**

1. **Actively declined ≠ passively unacted.** A dismissal is a decision; respect it
   absolutely and never escalate it. An item that stayed visible across reviews with
   unchanged evidence and *no* user response is a server-computed state
   (`unactedReviewCount`) — no model inference of "you ignored me" is needed.
2. **Escalate specificity, never frequency or volume.** On a repeated unacted
   appearance the model must spell out the concrete consequence chain with an
   evidenced date ("If the scope decision is not made by Wednesday, Friday's testing
   compresses to one day — log.md shows what happened last time"). Consequence claims
   use the same validated-excerpt mechanism as dates. Loss framing is motivating but,
   with rejection sensitivity in play, **every warning must come with a door**:
   consequence + one small recovery step + an honest exit. Never consequence alone.
3. **Offer the exit ramp as a first-class action.** After repeated non-action:
   *"You've deferred this three times — park it deliberately until November, with no
   nudges until then?"* Converting passive avoidance into an explicit, guilt-free
   decision is standard ADHD coaching practice. **Park this project** is now a direct
   response control, and the single question budget may be spent on this kind of
   pattern question.
4. **Cap the ladder.** One consequence escalation per issue, then the pattern/park
   question, then a quiet visible row. Never moralize; describe consequences to the
   *project*, never characterize the *user*.

### 6. Requested addition: hyperfocus detection and a focus report

The original spec excluded all activity-signal inference, which also excluded
detecting hyperfocus misallocation — the ADHD failure mode where one project absorbs
everything while a committed project rots.

**Applied, with a carefully drawn line:** the server keeps **local, bounded, per-project
daily activity counts** (chat turns and changed-file events — no content, no
durations, no provider calls) and renders a **focus report**: an iOS-Screen-Time-style
view of where attention went over 7/30 days, always captioned **"Activity is not
progress."** The server — not the model — computes an attention-allocation signal
(e.g., one project dominating recent activity while a higher-priority project with an
evidenced date has none) and supplies it as a labeled fact. The model may raise at most
one allocation observation or question from it. The original honesty rule survives
intact: activity counts can *never* establish trajectory, progress, or drift on their
own, and are never presented as time spent.

### 7. Requested addition: continuous progress reports for a boss

Some projects must be reported upward; assembling "what actually happened" from
memory is exactly the executive task ADHD makes hardest, and the workspace's dated
logs already contain the raw material.

**Applied:** projects can be marked **reportable**. An on-demand **Draft progress
report** action makes one no-tools provider call over that project's collected
evidence and dated log history since the previous report, producing a validated draft
(period covered, completed work with citations, in progress, blockers and risks, next
steps) with unverified items labeled. Drafts are copy-only: never auto-sent, never
written into project files, with a bounded per-project draft history. Together with
the dated log convention this yields a continuous, evidence-backed reporting trail at
near-zero recall cost.

### 8. Mockup inconsistencies

- Urgency badges ("This week", "Recover direction", "Needs context") diverged from the
  spec's three display labels, and the top "today" recommendation wore a mid-tier
  badge. **Applied:** labels aligned to **Act now / This week / Prevent drift**; the
  briefing's focus item now carries **Act now**.
- No time-runway anywhere. **Applied:** runway chips on dated items.
- One win slot only. **Applied:** up to three evidenced improvements.
- Fixture strings were interpolated without escaping in places the spec requires
  `textContent`. **Applied** in the mockup renderer.

### 9. Information architecture: long page versus tabs

After the additions above, a single page became long enough to trigger the other ADHD
failure mode: overwhelm. A wall of content creates an unbounded perceived obligation to
process everything, which produces avoidance just as surely as hiding things does. But
plain tabs risk the original sin — out of sight, out of mind.

**Applied — a hybrid with one invariant:** tabs ordered by decreasing importance
(**Today**, **All projects**, **Focus report**), where **Today** is the *decision
surface* and the others are *reference surfaces* that are safe to leave unopened **by
construction**: nothing actionable may ever live only outside Today; if a reference
surface contains something that needs action, the review must promote it into Today.
A tab that is structurally safe to ignore cannot cause a missed deadline, so the
out-of-sight risk is engineered away rather than mitigated with badges. Tabs carry
factual counts only — no red badge walls — with at most one small amber dot on the
focus report when the allocation signal fires. Today ends with an explicit closure
line (**Nothing else here needs a decision right now**), giving the user permission to
stop — bounding the obligation is what actually relieves the overwhelm.

### 10. Carrying the model into project home pages

The overview optimizes *choosing* what to work on; project pages are where work
actually happens, and they host their own ADHD tax: **task-resumption cost**. Every
return to a project forces the user to reconstruct "where was I, what was I doing,
what's next?" from raw documents — exactly the working-memory operation ADHD makes
expensive, and a common point where a session dies before it starts.

**Applied — a project brief** ([mockup](mockups/project-home.html)) above the
existing document view, rendered entirely from the saved review, controls, and the
project's own status/log — never a provider call:

- **Where you left off**: server-quoted last completed outcome and recorded next
  action, with source links. Five-second re-entry instead of a document archaeology
  session.
- **Next useful step** with the **Start here** first step, runway chip, and any
  escalation note — the same nudge, now at the exact point of performance.
- **The same controls** (park, priority, correct, 30-minute session, report draft),
  through the same idempotent API, so acting is possible wherever the user happens
  to be when motivation strikes — a scarce resource not to be wasted on navigation.
- **The cross-project strip above it**, covering the opposite failure (hyperfocus
  here while an evidenced deadline approaches elsewhere).

One gap surfaced in review and closed in the spec: the brief mixes live and saved
data. **Where you left off** is read live from the documents, so it can never
contradict the page below it; the assessment rows are saved review output, so they
can. A timestamp alone would make the user do the staleness arithmetic — exactly the
inference this design exists to remove — so the brief inherits the overview's
server-computed freshness state and shows an explicit **Changed since this review**
marker instead (spec A38).

What deliberately does **not** carry over: a second dashboard. No briefing prose, no
question, no other projects' rows — the brief is one collapsible band, and the
document view beneath is unchanged. The Today-surface invariant extends here:
nothing actionable may exist only on a project page, so skipping project pages
remains structurally safe.

### 11. Model selection: quality, cost basis, and the silent-failure tier

The review is a judgment task. Schema validation catches fabrication and malformed
output — so genuinely weak models fail loudly — but it cannot catch shallow
judgment. The dangerous tier is the mid-capability model that returns structurally
valid JSON with wrong priorities and generic first steps. That failure is silent, and
for this product it is fatal: one confidently wrong briefing destroys the trust the
entire ADHD design depends on, and a distrusted advisor is worse than none.

Decisions applied to the spec:

- **A hard context-window gate** (arithmetic, non-overridable) and **curated
  capability tiers** in the catalog (`recommended` / `capable` / `unverified` /
  `unsupported`), maintained from fixture evaluations rather than guessed at runtime.
  Below-recommended selection is allowed with an explicit, honestly worded
  confirmation — capable local models are never blocked on cost grounds.
- **No model-selects-model routing.** A weak router is the weakest link in a judgment
  pipeline, adds a hidden provider call, and makes configuration non-reproducible.
  Task-based routing (cheap model for thread titles) is fine; delegated judgment
  about judgment is not.
- **Cost basis is first-class UX.** Subscription/OAuth credentials mean a scheduled
  review costs plan quota, not money; metered API keys spend real money in the
  background. Automatic review on a metered key requires one explicit
  acknowledgment. This matters doubly for ADHD users: ambient cost anxiety is itself
  an avoidance trigger, and a flat-rate credential removes it.
- **Never silently substitute.** Quota exhaustion, rate limits, and validation
  failures produce visible failure with the last good review preserved — never a
  quiet fallback to a cheaper model. Silent downgrade is silent quality compromise by
  another name.
- **Highest reasoning effort by default.** Reviews are infrequent, background, and
  budget-capped; latency is irrelevant and judgment is the product.
- **Trust calibration on first use**: save settings, run one manual review, inspect
  the citations, then enable automatic — the user earns confidence in the model
  before it runs unattended.
- **Capability feedback**: two consecutive invalid reviews stop automatic retries
  with honest guidance, instead of burning the daily budget proving a model cannot
  do the job.

## Is the expectation realistic? The honest boundary

Realistic, with these changes: cross-project working memory, honest 30-second triage,
low-friction initiation, evidence-grounded escalation, dignified exits, hyperfocus
visibility, and effortless upward reporting.

Not realistic, and deliberately so: **the tool cannot help while it is closed.** No
notifications, no monitoring while the server is stopped, no phone-level interruption.
It is a prosthetic frontal lobe for the moments the user engages it, not a guardian
angel. The classic failure mode is that the checking habit itself requires the
executive function the user lacks; mitigations are making the overview the landing
surface, keeping the 30-second contract sacred, and anchoring use to an existing
routine — but the limit should be stated plainly, in the product and to oneself.
