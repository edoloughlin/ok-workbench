import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkspaceReviewCoordinator, collectEvidence } = require('../src/workspace-review.js');
const { validateReview } = require('../src/workspace-review-schema.js');
import { PORTFOLIOS } from './fixtures/workspace-review-portfolios.mjs';

// Fixture-portfolio acceptance tests (spec: "Include fixture portfolios for
// healthy-but-quiet, busy-but-drifting, blocked-before-deadline, parked,
// stale/unknown, and competing-priority situations"). Every portfolio uses a
// deterministic fake provider and an injected clock; no provider credits are
// spent. These check structural/behavioral correctness end to end through
// the real collector, validator, coordinator, and public projection. They do
// not substitute for the spec's manual semantic review of real model output.
for (const portfolio of PORTFOLIOS) {
  test(`fixture portfolio: ${portfolio.slug}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), `ok-workbench-review-fixture-${portfolio.slug}-`));
    try {
      await portfolio.build(root);
      const evidence = await collectEvidence(root, { guidance: [] }, new Date('2026-09-08T12:00:00Z'));
      const response = portfolio.respond(evidence);
      // The fixture's fabricated response must itself satisfy the same
      // schema the real model output would be validated against.
      const validated = validateReview(response, { projects: evidence.projects, sources: evidence.sources });
      assert.equal(validated.projects.length, evidence.projects.length);
      const coordinator = new WorkspaceReviewCoordinator({
        stateDir: root, workspaceRoot: root, now: () => new Date('2026-09-08T12:00:00Z'),
        provider: async () => JSON.stringify(response)
      });
      await coordinator.store.saveSettings({ provider: 'openai', model: 'reviewer' }, 0);
      await coordinator.run(); await coordinator.running.task;
      const state = await coordinator.state();
      assert.ok(state.review, `${portfolio.slug}: expected a completed, published review`);
      // publicReview() overlays effective priority/lifecycle/urgency onto the
      // stored assessment; portfolios check against that public projection,
      // the same shape the overview renders.
      portfolio.expect({ projects: state.review.projects, attention: state.review.attention });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('the fixture set covers all six required portfolio situations', () => {
  const slugs = new Set(PORTFOLIOS.map(item => item.slug));
  for (const required of ['healthy-but-quiet', 'busy-but-drifting', 'blocked-before-deadline', 'parked', 'stale-unknown', 'competing-priority']) {
    assert.ok(slugs.has(required), `missing required fixture portfolio: ${required}`);
  }
});
