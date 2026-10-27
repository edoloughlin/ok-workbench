import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FAILURE_CASES } from './fixtures/workspace-review-failures/cases.mjs';
import { gradeResponse, promptRequest } from './fixtures/workspace-review-failures/evaluate.mjs';

for (const fixture of FAILURE_CASES) {
  test(`recorded prompt failure: ${fixture.id}`, () => {
    const bad = gradeResponse(fixture, fixture.failedResponse);
    assert.equal(bad.passed, false, 'the recorded bad behavior must not pass prompt evaluation');
    if (fixture.expectedFailure.issueCode) assert.ok(bad.validationIssues.some(item => item.code === fixture.expectedFailure.issueCode), JSON.stringify(bad));
    if (fixture.expectedFailure.presentationOnly) { assert.equal(bad.productionValid, true); assert.ok(bad.checks.some(item => item.name === 'outcome-within-prompt-target' && !item.passed)); }
    if (fixture.expectedFailure.parseError) { assert.equal(bad.strictJson, false); assert.equal(bad.productionValid, false); }
    if (fixture.expectedFailure.recovery) {
      assert.equal(bad.strictJson, false);
      assert.equal(bad.productionValid, true, 'recovered JSON is not a rejected review');
      assert.equal(bad.recovery, fixture.expectedFailure.recovery);
    }
    assert.equal(gradeResponse(fixture, fixture.referenceResponse).passed, true, 'the anonymised repair must pass the production validator and case criteria');
  });
}

test('a structurally valid empty review cannot pass by avoiding every recommendation', () => {
  for (const fixture of FAILURE_CASES) {
    const candidate = JSON.parse(fixture.referenceResponse);
    if (fixture.stage === 'project') candidate.attentionCandidates = [];
    else candidate.attention = [];
    const grade = gradeResponse(fixture, JSON.stringify(candidate));
    assert.equal(grade.productionValid, true);
    assert.equal(grade.passed, false, 'the case requires a useful current action');
  }
});

test('requests use current production prompts and exclude expected answers', () => {
  for (const fixture of FAILURE_CASES) {
    const request = promptRequest(fixture);
    assert.equal(request.messages.length, 2);
    assert.match(request.messages[0].content, /read-only/);
    const { eligibility, ...input } = JSON.parse(request.messages[1].content);
    assert.deepEqual(input, fixture.input);
    if (fixture.stage === 'synthesis') {
      assert.deepEqual(eligibility.focusProjectIds, fixture.input.projects.filter(project => project.state === 'current').map(project => project.projectId));
      const staleSources = fixture.input.projects.filter(project => project.state !== 'current').flatMap(project => project.sources.filter(source => !source.generated).map(source => source.id));
      assert.ok(eligibility.evidenceIds.every(id => !staleSources.includes(id)));
      assert.match(request.messages[0].content, /a user focus override does not make a stale\/unavailable assessment eligible/);
    }
    assert.equal(request.referenceResponse, undefined);
    if (fixture.input.priorCandidate) assert.match(request.messages[0].content, /untrusted model output/);
  }
});

test('grading supports multiple samples and rejects missing or unknown case IDs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-prompt-eval-'));
  const script = path.resolve('scripts/evaluate-workspace-review-prompts.mjs');
  const file = path.join(directory, 'outputs.jsonl');
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  try {
    const valid = FAILURE_CASES.map(fixture => ({ id: fixture.id, response: fixture.referenceResponse }));
    await writeFile(file, [...valid, valid[0]].map(row => JSON.stringify(row)).join('\n'));
    let result = run(['--grade', file]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout.trim().split('\n').at(-1)).summary;
    assert.equal(summary.samples, FAILURE_CASES.length + 1);
    await writeFile(file, JSON.stringify(valid[0]));
    result = run(['--grade', file]);
    assert.equal(result.status, 1); assert.match(result.stderr, /Missing outputs/);
    await writeFile(file, JSON.stringify({ id: 'unknown', response: '{}' }));
    result = run(['--grade', file]);
    assert.equal(result.status, 1); assert.match(result.stderr, /Unknown or out-of-scope/);
    result = run(['--requests', '--prompt-file', file]);
    assert.equal(result.status, 1); assert.match(result.stderr, /requires --requests and --stage/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
