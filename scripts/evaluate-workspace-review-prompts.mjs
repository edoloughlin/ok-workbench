import { readFile } from 'node:fs/promises';
import { FAILURE_CASES } from '../test/fixtures/workspace-review-failures/cases.mjs';
import { gradeResponse, promptRequest } from '../test/fixtures/workspace-review-failures/evaluate.mjs';

const usage = `Usage:
  node scripts/evaluate-workspace-review-prompts.mjs --requests [--stage project|synthesis] [--prompt-file PATH]
  node scripts/evaluate-workspace-review-prompts.mjs --grade OUTPUTS.jsonl [--stage project|synthesis]
  node scripts/evaluate-workspace-review-prompts.mjs --references
  node scripts/evaluate-workspace-review-prompts.mjs --replay

Requests contain only fictional input and current production prompts. No API calls are made.
Grade rows are {"id":"case-id","response":"raw model output"}; repeat IDs for multiple samples.
--references checks the valid examples. --replay reports the reconstructed failures without failing the command.
`;
try {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (!mode || mode === '--help') { process.stdout.write(usage); process.exit(0); }
  if (!['--requests', '--grade', '--references', '--replay'].includes(mode)) throw new Error('Unknown mode');
  let outputFile;
  if (mode === '--grade') { outputFile = args.shift(); if (!outputFile || outputFile.startsWith('--')) throw new Error('--grade requires a JSONL file'); }
  let stage; let promptFile;
  while (args.length) {
    const flag = args.shift(); const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--stage' && ['project', 'synthesis'].includes(value)) stage = value;
    else if (flag === '--prompt-file') promptFile = value;
    else throw new Error(`Unsupported argument: ${flag} ${value}`);
  }
  if (promptFile && (mode !== '--requests' || !stage)) throw new Error('--prompt-file requires --requests and --stage; prompts have different schemas');
  const fixtures = FAILURE_CASES.filter(item => !stage || item.stage === stage);
  const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (mode === '--requests') {
    const prompt = promptFile ? await readFile(promptFile, 'utf8') : undefined;
    fixtures.forEach(fixture => write(promptRequest(fixture, prompt)));
  } else {
    let rows;
    if (mode === '--grade') {
      rows = (await readFile(outputFile, 'utf8')).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      const ids = new Set(fixtures.map(fixture => fixture.id));
      for (const row of rows) if (!ids.has(row.id)) throw new Error(`Unknown or out-of-scope case id: ${row.id}`);
      const seen = new Set(rows.map(row => row.id));
      const missing = [...ids].filter(id => !seen.has(id));
      if (missing.length) throw new Error(`Missing outputs for: ${missing.join(', ')}`);
    } else {
      rows = fixtures.map(fixture => ({ id: fixture.id, response: mode === '--replay' ? fixture.failedResponse : fixture.referenceResponse }));
    }
    const grades = rows.map(row => gradeResponse(fixtures.find(fixture => fixture.id === row.id), row.response));
    grades.forEach(write);
    const summary = {
      mode, samples: grades.length, cases: fixtures.length,
      passed: grades.filter(grade => grade.passed).length,
      strictJson: grades.filter(grade => grade.strictJson).length,
      productionValid: grades.filter(grade => grade.productionValid).length,
      manualSemanticReview: 'pending; automated checks do not establish evidence relevance or recommendation quality'
    };
    write({ summary });
    if (mode !== '--replay' && summary.passed !== summary.samples) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n${usage}`);
  process.exitCode = 1;
}
