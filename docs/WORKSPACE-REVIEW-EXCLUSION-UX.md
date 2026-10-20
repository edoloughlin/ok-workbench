# Keep excluded projects out of the Today briefing

Make **Today** useful after the user excludes projects from workspace review. Show recommendations about included projects, and keep exclusion settings out of the main briefing.

Status: implementation specification for GPT-6 Luna. Implement the behavior below; this document does not include an implementation. For exclusion-related briefing behavior, this specification supersedes the corresponding requirements in [Workspace overview](WORKSPACE-OVERVIEW-SPEC.md). Preserve the caching contract in [Workspace review reliability](WORKSPACE-REVIEW-RELIABILITY.md).

## Before you begin

- Read `WorkspaceReviewCoordinator.state()` in `src/workspace-review.js`, especially the `redacted` set and the replacement of `assessment.headline` and `assessment.summary`.
- Read `renderWorkspaceOverview()` in `src/public/app.js`, including its `projects[0]` focus fallback, `.workspace-brief` markup, and closure message.
- Read `publicReview()` in `src/workspace-review-schema.js` and the saved `pipeline.selectedProjectIds` in `src/workspace-review-pipeline.js`.
- Read the existing exclusion regression in `test/workspace-review.test.mjs` and the browser fixtures in `test/e2e/workspace-overview.e2e.mjs`.
- Use the existing server, components, CSS, and test helpers. You do not need a live model or provider credentials to verify this change.

## Understand the failure

The current server constructs `redacted` from every configured exclusion, plus projects that have become unavailable. Whenever that set is nonempty, it replaces the saved briefing with:

> Workspace review updated
>
> Some project findings are hidden because projects are excluded or unavailable.

The client puts those strings under **Recommended focus**. This condition stays true even after the model produces a new review covering only included projects. It also fires for an excluded project that never contributed to the saved briefing.

The replacement originally prevents an old portfolio summary from exposing findings about a newly excluded project. Preserve that protection while removing the prominent administrative message.

## Implement the change

1. Add a server-derived briefing state to the public review response. Determine whether the saved synthesis actually covered a project that is now excluded or unavailable.
2. For an affected synthesis, suppress its portfolio narrative in the response and omit the briefing card in **Today**. Keep eligible project actions visible.
3. For an unaffected synthesis, render its actual headline and summary even when the settings contain exclusions.
4. Handle an empty review scope and a temporary absence of recommendations with the exact quiet empty states below.
5. Add focused server and browser regressions for the acceptance cases. Stop after the behavior and checks pass; avoid unrelated review or layout refactoring.

## Determine whether the saved briefing is usable

Compute this state on every `state()` read from the saved review and current eligibility. Do not persist a replacement headline or ask the model to rewrite a briefing while serving a read request.

Use `latest.pipeline.selectedProjectIds` as the saved synthesis scope when it is a valid array. For legacy records without that field, use project IDs from `latest.assessment.projects`. Include an explicitly named `focusProjectId` and project IDs resolved from the synthesis's evidence references when determining dependencies. Workspace sources with `projectId: null` are not project dependencies.

Compare those dependencies with configured exclusions and, when evidence collection succeeds, the currently eligible project IDs. An exclusion affects the briefing only when it removes one of those dependencies. Do not treat a configured exclusion by itself as evidence that a saved briefing is invalid.

For staged records, an old table row marked `not_included` is not automatically a synthesis dependency. Do not use every cached project or every retained source as the synthesis scope. For malformed or insufficient legacy metadata, suppress the briefing conservatively rather than guessing that it is safe.

If evidence collection fails, use explicit exclusions to remove known excluded findings and preserve the existing collection-error behavior. A failed collection is not proof that every project disappeared.

### Response field

Add the following presentation fields. They are not new fields in the model response schema or persisted review format.

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `review.briefingState` | `"ready" \| "scope_changed" \| "empty"` | Yes, when `review` exists | Whether the client can display the saved portfolio briefing. |
| `eligibleProjectCount` | Integer or null | Yes, at the state response root | Current eligible project count after exclusions; null when collection fails. |

Collect current eligibility even when no saved review exists. Reuse the existing collection result within `state()`; do not add a second collection pass. Return `current.projects.length` as `eligibleProjectCount`, or null on collection failure. In the client, handle `eligibleProjectCount === 0` before the ordinary no-review setup branch. This gives a user who excludes all projects the same empty state before and after their first review.

Apply these rules in order:

| Condition | Value | Response behavior |
| :--- | :--- | :--- |
| Evidence collection succeeds and there are zero eligible projects. | `empty` | Suppress the portfolio narrative and focus target. |
| A saved synthesis dependency is now excluded or unavailable, or its scope cannot be established safely. | `scope_changed` | Suppress the portfolio narrative and focus target. |
| Otherwise. | `ready` | Preserve the saved portfolio narrative and existing freshness information. |

For `scope_changed` and `empty`, return `headline: null`, `summary: null`, `focusProjectId: null`, `evidenceIds: []`, `changes: []`, and `question: null` within the public `review.assessment`. The schema validators still require ordinary strings in new model results; only the public projection permits these nulls.

Suppress the whole workspace narrative because its text can compare projects without linking each sentence to a source. Do not preserve a summary merely because its focus project remains included. Do not try to remove project names with string replacement.

Keep the existing filtering of excluded or unavailable project rows, attention, deferred items, sources, and project errors. For retained attention and deferred items, also reject entries whose evidence references resolve to removed project sources. Keep valid included-project items, their ordering, and their evidence links. Do not claim that this change can detect uncited project mentions inside arbitrary prose.

Do not mutate `latest.json` or the project caches when producing this projection. Re-inclusion must be able to use saved records under the existing freshness and cache rules.

## Render Today

| Briefing state | Top of Today | Other behavior |
| :--- | :--- | :--- |
| `ready` | Existing **Recommended focus** card with the actual saved headline and summary. | Render normal changes, attention, deferred items, and question. |
| `scope_changed`, with retained attention | **Needs attention**, followed immediately by the retained action cards. | Omit the entire briefing card and its **I have 30 minutes** button. Render retained deferred items below the actions. |
| `scope_changed`, with no retained attention | A quiet paragraph: “No current recommendations for these projects yet.” | Render any retained deferred items. Keep the existing header **Review now** action available. |
| `empty` | A quiet paragraph: “No projects selected for review.” and a **Choose projects** button opening Monitoring. | Omit the briefing, attention placeholder, and closure message. |

For a missing `briefingState`, default the client to suppressing the briefing until it receives a response with explicit state. This prevents a partially updated installation from displaying the old generic replacement as a recommendation.

Use these presentation rules:

- Remove the hidden briefing from the DOM. Do not leave a blank card, heading, vertical spacer, or keyboard-focusable action.
- Render **I have 30 minutes** in the briefing only when `briefingState` is `ready` and the explicit `focusProjectId` resolves to a visible project. Remove the `projects[0]` fallback for this action. A null focus is valid.
- Do not add an exclusion banner, toast, badge, count, or list of excluded names to **Today**. Users can inspect and change exclusions in Monitoring.
- For `scope_changed`, suppress “Nothing else here needs a decision right now.” The absence of a usable synthesis does not establish that conclusion.
- Preserve existing freshness markers and real provider or collection errors in their current locations. Intentional exclusions alone must not produce an error or a partial-coverage warning.
- Use current eligible coverage for displayed scope counts. Do not keep counting excluded projects from the old saved coverage. Preserve genuine partial coverage for included projects with missing or failed assessments.
- Keep the existing responsive layout, typography, tab behavior, and keyboard focus handling. Empty-state text uses the existing quiet-text style rather than headline or alert styling.

### Example response during a scope change

The fragment below shows presentation metadata after excluding the old focus project. Included project rows and valid attention items remain in the rest of the response.

```json
{
  "briefingState": "scope_changed",
  "assessment": {
    "headline": null,
    "summary": null,
    "focusProjectId": null,
    "evidenceIds": [],
    "changes": [],
    "question": null
  }
}
```

## Preserve review and cache behavior

Saving exclusions must take effect on the next state response and page refresh, including when automatic review is off. This UI fix must work without a successful new model call.

After a successful review covering the included projects, return `ready` and show its actual briefing. Excluded IDs that remain in settings must not suppress that new briefing. Recompute this state after a restart rather than keeping a dismissal flag in browser storage.

Preserve automatic-review opt-in, existing retry rules, and existing scheduling. A normal review after a scope change must reuse valid included-project assessments and regenerate synthesis as necessary; do not invoke **Reassess all** or invalidate every project cache. When projects leave the synthesis scope, omit the old comparison baseline from the next synthesis input so it cannot reintroduce excluded findings. Reading or rendering state must make zero provider calls.

Keep this implementation confined to presentation, scope dependency checks, and focused regressions. Do not redesign the model schema, change report drafting, remove cached files, or introduce a new background job.

## Handle errors and incomplete information

| Condition | Required behavior |
| :--- | :--- |
| A refresh fails after exclusions change. | Keep the old affected briefing suppressed. Retain available included-project actions and show the real failure through the existing error UI. |
| A project directory disappears. | Treat a saved dependency on that project as a scope change after successful collection confirms its absence. |
| Collection fails for the workspace. | Preserve the existing error and freshness behavior; do not show the zero-project empty state based on a missing collection result. |
| An included project is new and has no saved assessment. | Do not infer an empty review scope from `review.projects.length`. Use current eligibility; retain existing setup or review controls. |
| There is no saved review. | Preserve the existing initial setup/review screen. Apply the quiet zero-scope state when eligibility is known to be empty. |

## Verify acceptance criteria

Use fictional `alpha`, `beta`, and `gamma` projects and a stub provider. Verify the public response and rendered UI; a check for the absence of one string is insufficient.

| ID | Setup or action | Required result |
| :--- | :--- | :--- |
| A1 | Save a review of alpha and beta with alpha as focus, then exclude alpha with automatic review off. | The next state response is `scope_changed`; alpha's findings and portfolio narrative are absent. Today begins with beta's retained attention. Neither generic replacement string appears. No provider call occurs. |
| A2 | In the same saved scope, exclude beta while alpha remains the focus. | Suppress the affected portfolio briefing; retain valid alpha attention. Do not assume the old summary is safe because its focus survives. |
| A3 | Save a synthesis of beta only while alpha remains excluded in settings. | Return `ready` and show beta's actual headline and summary, including after a server restart. |
| A4 | Exclude gamma, which never contributed to the saved alpha/beta synthesis. | Preserve the existing briefing and focus. A nonempty exclusion list does not suppress it. |
| A5 | Save a staged synthesis of beta with an omitted alpha table row outside `selectedProjectIds` and no synthesis references to alpha, then exclude alpha. | Remove alpha's row and preserve the beta briefing. |
| A6 | Exclude the focus and leave no retained attention but at least one eligible project. | Show the quiet no-recommendations paragraph. No **Recommended focus**, invented fallback focus, time-box button, exclusion alert, or false closure message appears. |
| A7 | Exclude every eligible project, both with and without a saved review. | Show the quiet zero-scope message and **Choose projects**. Do not render a recommendation card or contradictory empty-attention/closure text. |
| A8 | Restore a project, or clear all exclusions. | Derive state from current eligibility and saved dependencies; no permanent suppression flag remains. Preserve honest freshness and reuse eligible caches. |
| A9 | Use a legacy saved review without pipeline metadata. | Derive dependencies from its assessment projects. Preserve immediate exclusion filtering; no migration or provider call is required to hide affected narrative. |
| A10 | Put a removed project's source ID in a retained item's evidence references. | Suppress that item; remove affected workspace changes and questions. Valid included-project items still render. |
| A11 | Fail synthesis after excluding alpha. | Do not restore the old alpha briefing. Show the real error with remaining usable content. |
| A12 | Remove a saved dependency's directory, then separately simulate a collection error. | Confirmed removal suppresses the affected briefing; a collection error does not falsely produce the zero-project state. |
| A13 | Refresh after exclusions using unchanged, not-due included-project caches. | Reuse those assessments and regenerate synthesis when required. Do not call the provider for excluded projects or force all included projects to refresh. |
| A14 | Inspect Today at 390px and 1440px and navigate with the keyboard. | Omitted briefing leaves no empty space or focus target; remaining actions and **Choose projects** work. Current scope counts exclude intentionally excluded projects. |
| A15 | Keep a valid briefing with a null focus ID. | Render its headline and summary without assigning the first table row as the focus-button target. |

Extend the existing exclusion test rather than weakening its assertion that excluded findings disappear. Add browser coverage for A1, A3, A6, and A7 using the existing fixture approach. Run the focused review tests and browser checks; report a missing browser as a verification limitation rather than a pass.

## What's next

Implement this specification using [Workspace overview](WORKSPACE-OVERVIEW-SPEC.md) for the surrounding UI and [Workspace review reliability](WORKSPACE-REVIEW-RELIABILITY.md) for caching. In your handoff, list the changed files, the checks you ran, and any acceptance criterion that remains unmet.
