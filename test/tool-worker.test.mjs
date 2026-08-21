import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const worker = createRequire(import.meta.url)(path.join(root, 'dist', 'tool-worker.js'));
function zipArchive(files) {
  const local = []; const central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name); const source = Buffer.from(content); const compressed = deflateRawSync(source); const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(source.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(source.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42); central.push(entry, filename); offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, directory, end]);
}
test('worker rejects traversal, private names, and symlink escapes while allowing scoped edits', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-worker-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ok-workbench-outside-'));
  await writeFile(path.join(workspace, 'note.md'), 'hello\n');
  await writeFile(path.join(outside, 'private.md'), 'private\n');
  await symlink(path.join(outside, 'private.md'), path.join(workspace, 'escape.md'));
  await symlink(outside, path.join(workspace, 'outside'));
  worker.setWorkspaceRoot(workspace);
  await assert.rejects(worker.readFile('../private.md'));
  await assert.rejects(worker.readFile('.env'));
  await assert.rejects(worker.readFile('escape.md'));
  await assert.rejects(worker.applyPatch({ path: 'outside/new.md', content: 'nope' }));
  await worker.applyPatch({ path: 'notes/new.md', content: 'safe' });
  assert.equal(await readFile(path.join(workspace, 'notes', 'new.md'), 'utf8'), 'safe');
});
test('worker extracts text from PDF and Office documents without exposing binary reads', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-documents-'));
  await writeFile(path.join(workspace, 'report.pdf'), '%PDF-1.4\nBT\n(Quarterly report) Tj\n<4865782074657874> Tj\nET\n');
  await writeFile(path.join(workspace, 'note.md'), '# Note\n');
  await writeFile(path.join(workspace, 'report.docx'), zipArchive({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Project brief</w:t></w:r></w:p></w:body></w:document>' }));
  await writeFile(path.join(workspace, 'slides.pptx'), zipArchive({ 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p></p:sld>' }));
  await writeFile(path.join(workspace, 'numbers.xlsx'), zipArchive({ 'xl/sharedStrings.xml': '<sst><si><t>Revenue</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>' }));
  await writeFile(path.join(workspace, 'report.odt'), zipArchive({ 'content.xml': '<office:document-content><text:h>Project report</text:h><text:p>OpenDocument text</text:p></office:document-content>' }));
  await writeFile(path.join(workspace, 'slides.odp'), zipArchive({ 'content.xml': '<office:document-content><draw:page><text:p>OpenDocument slide</text:p></draw:page></office:document-content>' }));
  await writeFile(path.join(workspace, 'numbers.ods'), zipArchive({ 'content.xml': '<office:document-content><table:table table:name="Budget"><table:table-row><table:table-cell><text:p>Cost</text:p></table:table-cell><table:table-cell><text:p>10</text:p></table:table-cell></table:table-row></table:table></office:document-content>' }));
  worker.setWorkspaceRoot(workspace);
  assert.match((await worker.extractDocument('report.pdf')).content, /Quarterly report Hex text/);
  assert.match((await worker.extractDocument('report.docx')).content, /Project brief/);
  assert.match((await worker.extractDocument('slides.pptx')).content, /Roadmap/);
  assert.match((await worker.extractDocument('numbers.xlsx')).content, /A1: Revenue.*B1: 42/);
  assert.match((await worker.extractDocument('report.odt')).content, /Project report[\s\S]*OpenDocument text/);
  assert.match((await worker.extractDocument('slides.odp')).content, /OpenDocument slide/);
  assert.match((await worker.extractDocument('numbers.ods')).content, /Budget[\s\S]*Cost \| 10/);
  await assert.rejects(worker.extractDocument('../report.pdf'));
  await assert.rejects(worker.extractDocument('note.md'), /Supported document types/);
});
test('worker discovers only executable Python or Node workspace tools in the permitted directories', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-tools-'));
  await writeFile(path.join(workspace, 'index.md'), '# Workspace\n');
  await writeFile(path.join(workspace, 'top-tool'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  await mkdir(path.join(workspace, 'tools'));
  await writeFile(path.join(workspace, 'tools', 'top-tool.js'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  await chmod(path.join(workspace, 'tools', 'top-tool.js'), 0o755);
  await writeFile(path.join(workspace, 'tools', 'top-tool.tool.json'), JSON.stringify({ environment: ['JIRA_API_TOKEN', 'JIRA_BASE_URL'], network: true, timeoutSeconds: 120 }));
  await mkdir(path.join(workspace, 'project', 'tools'), { recursive: true });
  await writeFile(path.join(workspace, 'project', 'tools', 'project-tool'), '#!/usr/bin/env python3\nprint("ready")\n');
  await chmod(path.join(workspace, 'project', 'tools', 'project-tool'), 0o755);
  worker.setWorkspaceRoot(workspace);
  assert.deepEqual(await worker.listWorkspaceTools(), {
    tools: [
      { path: 'tools/top-tool.js', runtime: 'nodejs', manifestPath: 'tools/top-tool.tool.json', manifest: { environment: ['JIRA_API_TOKEN', 'JIRA_BASE_URL'], network: true, timeoutSeconds: 120 }, environment: ['JIRA_API_TOKEN', 'JIRA_BASE_URL'], network: true, timeoutSeconds: 120 },
      { path: 'project/tools/project-tool', runtime: 'python3', manifestPath: null, manifest: null, environment: [], network: false, timeoutSeconds: 30 }
    ], diagnostics: []
  });
  await writeFile(path.join(workspace, 'tools', 'orphan.tool.json'), '{}');
  assert.deepEqual((await worker.listWorkspaceTools()).diagnostics, [{ path: 'tools/orphan.tool.json', error: 'Tool metadata does not match a script in this directory' }]);
  await assert.rejects(worker.applyPatch({ path: 'tools/top-tool.tool.json', content: '{}' }), /managed outside agent file updates/);
  await assert.rejects(worker.applyPatch({ path: 'tools/top-tool.js', content: 'console.log(1)' }), /managed outside agent file updates/);
  await assert.rejects(worker.runWorkspaceTool({ path: 'top-tool.js' }), /direct files/);
  await assert.rejects(worker.runWorkspaceTool({ path: 'tools/top-tool.js', arguments: ['\0'] }), /arguments/);
  await writeFile(path.join(workspace, 'tools', 'top-tool.tool.json'), JSON.stringify({ timeoutSeconds: 601 }));
  await assert.rejects(worker.workspaceToolPolicy('tools/top-tool.js'), /timeoutSeconds must be an integer from 1 to 600/);
});
test('worker creates and registers a discoverable top-level project', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ok-workbench-project-'));
  const template = await mkdtemp(path.join(tmpdir(), 'ok-workbench-template-'));
  await writeFile(path.join(workspace, 'index.md'), '# Workspace\n');
  await cp(path.join(root, 'seed', 'workspace', 'templates', 'project'), template, { recursive: true });
  const savedTemplate = process.env.OK_WORKBENCH_PROJECT_TEMPLATE; process.env.OK_WORKBENCH_PROJECT_TEMPLATE = template;
  worker.setWorkspaceRoot(workspace);
  try {
    const created = await worker.createProject({ id: 'planning', title: 'Private planning' });
    assert.deepEqual(created, { id: 'planning', path: 'planning', location: '/workspace/planning', title: 'Private planning', structure: 'OKF 0.2 project template' });
    assert.match(await readFile(path.join(workspace, 'planning', 'index.md'), 'utf8'), /type: Project/);
    assert.match(await readFile(path.join(workspace, 'planning', 'index.md'), 'utf8'), /# Private planning/);
    assert.match(await readFile(path.join(workspace, 'planning', 'status.md'), 'utf8'), /title: Private planning status/);
    assert.match(await readFile(path.join(workspace, 'index.md'), 'utf8'), /- \[Private planning\]\(planning\/\)/);
    await assert.rejects(worker.createProject({ id: 'planning' }), /already exists/);
    await assert.rejects(worker.createProject({ id: '../outside' }), /Project ID/);
    await assert.rejects(worker.applyProjectUpdate({ changes: [{ path: 'planning/brief.md', content: '# Brief\n' }] }), /requires planning\/index.md/);
    const index = await readFile(path.join(workspace, 'planning', 'index.md'), 'utf8');
    const log = await readFile(path.join(workspace, 'planning', 'log.md'), 'utf8');
    const status = await readFile(path.join(workspace, 'planning', 'status.md'), 'utf8');
    await assert.rejects(worker.applyProjectUpdate({ changes: [
      { path: 'planning/index.md', content: index }, { path: 'planning/log.md', content: log }, { path: 'planning/status.md', content: status }, { path: 'planning/references/note.md', content: 'evidence\n' }
    ] }), /New directory planning\/references requires planning\/references\/index.md/);
    const update = await worker.applyProjectUpdate({ changes: [
      { path: 'planning/index.md', content: `${index}\n* [Evidence](references/index.md)\n` },
      { path: 'planning/log.md', content: `${log}\n## 2026-08-17\n\n- Added initial evidence.\n` },
      { path: 'planning/status.md', content: status.replace('No substantive work recorded yet.', 'Added initial evidence.') },
      { path: 'planning/references/index.md', content: '# References\n\n* [Evidence note](note.md)\n' },
      { path: 'planning/references/note.md', content: 'evidence\n' }
    ] });
    assert.deepEqual(update.paths, ['planning/index.md', 'planning/log.md', 'planning/status.md', 'planning/references/index.md', 'planning/references/note.md']);
  } finally { if (savedTemplate === undefined) delete process.env.OK_WORKBENCH_PROJECT_TEMPLATE; else process.env.OK_WORKBENCH_PROJECT_TEMPLATE = savedTemplate; }
});
