# Evaluate workspace review prompts with recorded failure cases

Use these fictional reconstructions of recorded review failures to compare prompt variants against the production validators. You can export model requests and grade responses offline without loading the original workspace or calling a provider.

## Before you begin

- Install the repository dependencies and use Node.js 22.19 or later.
- Run the commands from the repository root.
- To generate new model responses, use your chosen evaluation tool and its credentials. These scripts make no API calls.

## Inspect the cases

The source copy contained 14 trace exchanges: 11 rejected responses, two responses recovered by removing extra trailing braces, and one provider failure without a response. Eight cases represent the 13 response-bearing exchanges. The six stale-focus failures cover three freshness mixes, with two observations per mix.

| Case | Observations | Expected failure | Prompt improvement to evaluate |
| :--- | :--- | :--- | :--- |
| `stale-project-selected-as-focus` | 2 | Stale focus with one stale project out of six | Identify eligible current projects before choosing focus. |
| `stale-focus-with-2-stale-projects` | 2 | Stale focus with two stale projects out of six | Preserve freshness rules as the stale share grows. |
| `stale-focus-with-3-stale-projects` | 2 | Stale focus with three stale projects out of six | Compare urgency only among eligible current projects. |
| `correction-retains-stale-citations` | 2 | Correction changes focus but retains stale citations and a stale date | Recheck all citations, attention items, and dates after correcting focus. |
| `first-step-chains-execution-and-recording` | 1 | First step combines running a check and recording its result | Put follow-up work in `action`; keep one action in `firstStep`. |
| `outcome-exceeds-field-budget` | 1 | A 244-character outcome exceeds the accepted 240-character limit | State the 200-character target in the project schema and summarise requirements. |
| `malformed-nested-array-closure` | 1 | Incorrect closure inside the attention array | Check nested object and array closure before returning JSON. |
| `extra-closing-brace-after-complete-json` | 2 | Invalid raw JSON that production recovers | Stop after the final brace; measure formatting without recovery. |

The provider-unavailable trace has no output to evaluate, so it is excluded from prompt cases. These are reconstructions, rather than copies of raw exchanges: project identities, source IDs, prose, domains, dates, and timestamps are fictional. Trace paths, hashes, job IDs, settings, and personal details are omitted. Failure mechanisms, field lengths, correction feedback, and the six-project freshness patterns are retained. Project cases reduce the original evidence to the facts needed to reproduce each failure. No test imports the original example directory.

## Compare prompts

1. Replay the rejected and recovered examples, then check the valid reference responses:

   ```sh
   node scripts/evaluate-workspace-review-prompts.mjs --replay
   node scripts/evaluate-workspace-review-prompts.mjs --references
   ```

2. Export requests that use the current production prompts:

   ```sh
   node scripts/evaluate-workspace-review-prompts.mjs --requests > /tmp/review-requests.jsonl
   ```

   Each request contains `id`, `stage`, and two `messages`: a system prompt and fictional user evidence. Requests omit reference answers, rubrics, and failure metadata. The correction case includes the rejected `priorCandidate` and `validationFeedback`, matching the correction contract.

3. To evaluate a prompt variant for one stage, export requests with a replacement system prompt:

   ```sh
   node scripts/evaluate-workspace-review-prompts.mjs --requests \
     --stage synthesis --prompt-file /tmp/synthesis-prompt.txt \
     > /tmp/synthesis-requests.jsonl
   ```

   The evaluator appends the correction contract for correction inputs. Keep the production stage schema in your replacement prompt.

4. Generate raw responses with your evaluation tool. Save one JSONL row per sample:

   ```json
   {"id":"stale-project-selected-as-focus","response":"{...complete raw model response...}"}
   ```

   Use the exact case IDs and encode the complete response as a JSON string. You can repeat IDs to evaluate multiple samples. Record model, reasoning effort, prompt version, and sampling settings alongside each run.

5. Grade every case in the exported stage:

   ```sh
   node scripts/evaluate-workspace-review-prompts.mjs --grade /tmp/synthesis-outputs.jsonl --stage synthesis
   ```

6. Inspect each case's `manualReview` questions alongside its evidence and output. Check whether citations support the claims, whether the proposed action helps, and whether freshness qualifiers remain accurate. Structural validity alone does not establish useful judgment.

Change one prompt rule at a time and compare repeated samples with the same model settings. Start with freshness eligibility and citation checks, which account for eight observed rejections. Use existing portfolio fixtures alongside these failures to check for regressions in healthy, parked, unknown, and competing-priority situations.

## Interpret results

The grader applies the production JSON parser and stage validators. It separately checks that the raw output is one JSON object, that the case still receives an actionable recommendation, and that project outcomes stay within the 200-character prompt target. It does not require the exact reference wording. It rejects the empty-attention shortcut because each fictional case includes an evidenced pending validation.

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | String | Yes | Case ID from `cases.mjs`. |
| `response` | String | Yes | Unmodified model response, including any malformed JSON or trailing punctuation. |
| `strictJson` | Boolean | Output | Raw output parses as one JSON object without fences or repairs. |
| `productionValid` | Boolean | Output | Production parsing and schema validation accept the response. |
| `recovery` | String or null | Output | Trailing-delimiter recovery applied by the production parser. |
| `checks` | Array | Output | Case-specific automated checks for useful attention and outcome length. |
| `passed` | Boolean | Output | Raw JSON, production validation, and case checks all pass. |
| `manualReview` | Array | Output | Questions for reviewing evidence relevance and recommendation quality. |

For the trailing-brace case, the reconstructed response has `productionValid: true` and `passed: false`. That distinction preserves the observed recovery while measuring whether a new prompt fixes the formatting problem. Reference responses illustrate acceptable repairs; they are not evidence that a live model follows the prompt.

## Troubleshoot evaluation

| Error | Cause | Recommended action |
| :--- | :--- | :--- |
| Exit code `1` during grading | One or more samples fail automated checks. | Inspect each row's `error` and failed `checks`. |
| `Missing outputs` | The file omits a selected case. | Include every case in the chosen stage. |
| `Unknown or out-of-scope case id` | A row names an unknown ID or another stage. | Use the IDs from the exported requests. |
| `--prompt-file requires --requests and --stage` | A prompt override lacks a stage. | Select `project` or `synthesis` to avoid mixing schemas. |
| `response must be the raw model output string` | A row contains an object instead of the raw response. | Preserve the model text as a JSON string. |

## What's next

- Run `node --test test/workspace-review-prompt-cases.test.mjs` to verify failure reproduction and reference repairs.
- Review [portfolio fixtures](../workspace-review-portfolios.mjs) for broader semantic scenarios.
- Check [review reliability requirements](../../../docs/WORKSPACE-REVIEW-RELIABILITY.md) before changing production prompts or validators.
