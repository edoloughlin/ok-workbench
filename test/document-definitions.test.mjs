import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const { documentDefinitions } = createRequire(import.meta.url)('../src/document-definitions.js');
const entry = (data, key) => data.entries.find(item => item.key === key)?.definition;

test('extracts ID definitions from first table cells and bullet starts, not mentions elsewhere', () => {
  const data = documentDefinitions(`# Requirements
Reference WC-1 and SEC-2 in prose.
| ID | Requirement |
|----|-------------|
| WC-1 | **Work contract** with details.<br>*A note.* |
| SEC-2 | <img src=x onerror=alert(1)> Security. |
- MOD-3 — Handle an ordinary bullet.
* WC-4: Another form.
- **REQ-5**: Bold ID.
* \`REQ-6\`: Code ID.
- **REQ-9:** Bold with colon inside.
- WC-7
  Continuation line.
| ID | Requirement |
|----|-------------|
| REF-8 | Follow up. |
`);
  assert.match(entry(data, 'WC-1'), /Work contract/);
  assert.equal(entry(data, 'SEC-2'), 'Security.');
  assert.equal(entry(data, 'MOD-3'), 'Handle an ordinary bullet.');
  assert.equal(entry(data, 'WC-4'), 'Another form.');
  assert.equal(entry(data, 'REQ-5'), 'Bold ID.');
  assert.equal(entry(data, 'REQ-6'), 'Code ID.');
  assert.equal(entry(data, 'REQ-9'), 'Bold with colon inside.');
  assert.equal(entry(data, 'WC-7'), 'Continuation line.');
  assert.equal(entry(data, 'REF-8'), 'Follow up.');
  assert.equal(entry(data, 'MISSING-9'), undefined);
  assert.ok(data.sources.some(item => item.key === 'WC-1' && item.line === 5));
});

test('extracts numbered Glossary and Definitions tables and bullet lists only inside their sections', () => {
  const data = documentDefinitions(`# Document
## 21. Glossary
| Term | Meaning |
|------|---------|
| Work contract | A unit of **work**. |
| Blue/green deployment | Two environments. |
- **Human proxy**: An agent representing a human.
* Break-glass — Emergency override.
### More terms
- \`DoD\`: Definition of done.
## 22. Outside
- Mistake: Not a glossary entry.
## Definitions
| Term | Definition |
|------|------------|
| ADR | Architecture decision record. |
`);
  assert.equal(entry(data, 'Work contract'), 'A unit of work.');
  assert.equal(entry(data, 'Blue/green deployment'), 'Two environments.');
  assert.equal(entry(data, 'Human proxy'), 'An agent representing a human.');
  assert.equal(entry(data, 'Break-glass'), 'Emergency override.');
  assert.equal(entry(data, 'DoD'), 'Definition of done.');
  assert.equal(entry(data, 'ADR'), 'Architecture decision record.');
  assert.equal(entry(data, 'Mistake'), undefined);
  assert.equal(entry(data, 'Term'), undefined);
});

test('parses tables without outer pipes and keeps unrelated tables out of the glossary', () => {
  const data = documentDefinitions(`# Document
ID | Definition
---|---
ABC-10 | First column definition.
## 2. Definitions
Term | Explanation
---|---
Alpha term | Explains alpha.
## Other section
Term | Explanation
---|---
Unrelated term | Not a glossary entry.
`);
  assert.equal(entry(data, 'ABC-10'), 'First column definition.');
  assert.equal(entry(data, 'Alpha term'), 'Explains alpha.');
  assert.equal(entry(data, 'Unrelated term'), undefined);
});

test('skips fenced code, frontmatter, false prefixes and duplicate definitions', () => {
  const data = documentDefinitions(`---
key: secret
---
\`\`\`md
| ID | Requirement |
|----|-------------|
| SEC-1 | Not real. |
- FAKE-2: Not real.
\`\`\`
| ID | Requirement |
|----|-------------|
| SEC-1 | First definition. |
| SEC-1 | Second definition. |
- SEC-12: Another definition.
The SEC-1 reference is not a source.
`);
  assert.equal(entry(data, 'SEC-1'), 'First definition.');
  assert.equal(entry(data, 'SEC-12'), 'Another definition.');
  assert.equal(entry(data, 'FAKE-2'), undefined);
  assert.equal(data.entries.filter(item => item.key === 'SEC-1').length, 1);
  assert.equal(data.sources.filter(item => item.key === 'SEC-1').length, 2);
});

test('numbered requirements and glossary definitions use a reproducible fixture', () => {
  // Keep this independent of private, changing files in the developer's home.
  const source = `# Requirements
| ID | Requirement |
|----|-------------|
| WC-1 | A work contract defines agent work. |
| P-12 | One mechanism for all agent work. |
## 21 Glossary
| Term | Definition |
|------|------------|
| Blue/green deployment | Two identical production environments. |
| Work contract | The unit of agent work with acceptance criteria. |
`;
  const data = documentDefinitions(source);
  assert.match(entry(data, 'WC-1'), /work contract/);
  assert.match(entry(data, 'P-12'), /One mechanism for all (?:agent )?work/);
  assert.match(entry(data, 'Blue/green deployment'), /Two identical production environments/);
  assert.match(entry(data, 'Work contract'), /unit of (?:all|agent) work/);
  const location = data.sources.find(item => item.key === 'WC-1');
  assert.match(source.split('\n')[location.line - 1], /WC-1/);
});
