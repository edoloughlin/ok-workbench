import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { extractWebText } from '../src/web-fetch-text.mjs';

const bytes = value => Buffer.from(value, 'utf8');

test('HTML extraction selects main and removes active and hidden content', () => {
  const html = '<title>Example &amp; title</title><nav>Nav</nav><main><h1>Hello &amp; welcome</h1><script>bad()</script><p hidden>secret</p><p>Good <b>text</b></p></main><footer>Footer</footer>';
  const result = extractWebText(bytes(html), 'text/html', 'utf-8', 20000);
  assert.equal(result.title, 'Example & title');
  assert.match(result.text, /Hello & welcome/);
  assert.match(result.text, /Good text/);
  assert.doesNotMatch(result.text, /bad|secret|Nav|Footer/);
});

test('fixture extraction preserves readable document structure without subresources', async () => {
  const html = await readFile(new URL('./fixtures/web-fetch/readable.html', import.meta.url));
  const result = extractWebText(html, 'text/html', 'utf-8', 20000);
  assert.equal(result.title, 'Fixture & source');
  for (const expected of ['Heading & entity', 'See linked text.', 'First item', 'Second item', 'Key | Value', 'Alpha | Beta', 'one\n\n  two']) assert.ok(result.text.includes(expected), expected);
  assert.doesNotMatch(result.text, /Navigation|Hidden|Footer|bad\(\)|https:\/\//);
});

test('all excluded subtrees and hidden attributes are omitted', () => {
  const excluded = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'nav', 'footer', 'form'];
  const html = `<head><title>Head title</title></head><body><main>visible${excluded.map(tag => tag === 'embed' ? '<embed src="https://example.com/secret">' : `<${tag}>secret-${tag}</${tag}>`).join('')}<span hidden>hidden secret</span><span aria-hidden="TRUE">aria secret</span></main></body>`;
  const result = extractWebText(bytes(html), 'text/html', 'utf-8', 20000);
  assert.equal(result.title, 'Head title'); assert.equal(result.text, 'visible');
});

test('preferred containers respect excluded ancestors and preserve preformatted blank lines', () => {
  const html = '<div hidden><main>hidden main</main></div><nav><article>hidden article</article></nav><article><p>Visible</p><pre>one\n\n\n  two</pre></article>';
  const result = extractWebText(bytes(html), 'text/html', 'utf-8', 20000);
  assert.doesNotMatch(result.text, /hidden/);
  assert.match(result.text, /Visible/);
  assert.match(result.text, /one\n\n\n  two/);
});

test('HTML fallback selects first readable main, then article, then body', () => {
  const html = '<main><script>ignored</script></main><main hidden>hidden</main><article><p>article content</p></article><p>body content</p>';
  assert.equal(extractWebText(bytes(html), 'text/html', 'utf-8', 20000).text, 'article content');
  assert.equal(extractWebText(bytes('<main hidden>hidden</main><p>body content</p>'), 'text/html', 'utf-8', 20000).text, 'body content');
  assert.deepEqual(extractWebText(bytes('<main><script>only script</script></main>'), 'text/html', 'utf-8', 20000), { error: 'EMPTY_CONTENT' });
  const title = extractWebText(bytes(`<title>${'x'.repeat(400)}</title><main>ok</main>`), 'text/html', 'utf-8', 20000).title;
  assert.equal(title.length, 300);
  assert.equal(extractWebText(bytes('<body><title>Not a head title</title><main>ok</main></body>'), 'text/html', 'utf-8', 20000).title, null);
});

test('plain text normalizes, rejects empty input, and respects surrogate boundaries', () => {
  assert.deepEqual(extractWebText(bytes(' \r\n\0 '), 'text/plain', 'utf-8', 20), { error: 'EMPTY_CONTENT' });
  const result = extractWebText(bytes('a😀b'), 'text/plain', 'utf-8', 2);
  assert.equal(result.text, 'a'); assert.equal(result.truncated, true);
});

test('extraction worker processes data independently', async () => {
  const worker = new Worker(new URL('../src/web-fetch-text-worker.mjs', import.meta.url), { workerData: { bytes: bytes('<main>ok</main>'), contentType: 'text/html', charset: 'utf-8', maxChars: 1000 }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
  try {
    const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    assert.equal(result.text, 'ok');
  } finally { await worker.terminate(); }
});
