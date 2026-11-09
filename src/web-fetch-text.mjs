import { parse } from 'parse5';

const EXCLUDED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'head', 'nav', 'footer', 'form']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre', 'tr', 'br', 'hr']);

function hidden(node) {
  return node.attrs?.some(attr => attr.name === 'hidden' || (attr.name === 'aria-hidden' && attr.value.toLowerCase() === 'true'));
}
function elements(root, name, { visibleOnly = false } = {}) {
  const result = []; const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (visibleOnly && (EXCLUDED.has(node.tagName) || hidden(node))) continue;
    if (node.tagName === name) result.push(node);
    const children = node.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return result;
}

function extract(root) {
  const out = []; const stack = [{ node: root, pre: false, end: false }];
  while (stack.length) {
    const { node, pre, end } = stack.pop();
    const tag = node.tagName;
    if (end) { if (BLOCKS.has(tag)) out.push({ text: '\n', pre: false }); else if (tag === 'td' || tag === 'th') out.push({ text: ' | ', pre: false }); continue; }
    if (node.nodeName === '#text') { out.push({ text: pre ? node.value : node.value.replace(/[\t\r\n\f ]+/g, ' '), pre }); continue; }
    if (EXCLUDED.has(tag) || hidden(node)) continue;
    if (BLOCKS.has(tag)) out.push({ text: '\n', pre: false });
    stack.push({ node, pre, end: true });
    const children = node.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], pre: pre || tag === 'pre', end: false });
  }
  const normalized = []; let trailingNewlines = 0;
  for (const chunk of out) {
    let value = chunk.text.replace(/\0/g, '').replace(/\r\n?/g, '\n');
    if (!chunk.pre) {
      value = value.replace(/\n{3,}/g, '\n\n');
      const leading = value.match(/^\n+/)?.[0].length || 0;
      if (leading && trailingNewlines) value = value.slice(Math.min(leading, Math.max(0, trailingNewlines + leading - 2)));
    }
    if (value) {
      normalized.push(value);
      const suffix = value.match(/\n+$/)?.[0].length || 0;
      trailingNewlines = suffix === value.length ? trailingNewlines + suffix : suffix;
    }
  }
  return normalized.join('').trim();
}

export function extractWebText(bytes, contentType, charset, maxChars) {
  let decoded;
  try {
    const decoder = new TextDecoder(charset || 'utf-8');
    decoded = decoder.decode(bytes);
    // Some Node/ICU builds decode the Windows-1252 control range as Latin-1.
    // Correct that range only when the runtime decoder exhibits that behavior.
    if (['windows-1252', 'iso-8859-1'].includes(charset?.toLowerCase()) && decoder.decode(Uint8Array.of(0x80)) === '\u0080') {
      const replacements = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
      decoded = decoded.replace(/[\u0080-\u009f]/g, character => replacements[character.charCodeAt(0) - 0x80]);
    }
  } catch { return { error: 'UNSUPPORTED_ENCODING' }; }
  let title = null; let text;
  if (contentType === 'text/html') {
    const document = parse(decoded);
    const head = elements(document, 'head')[0];
    const titleNode = head && elements(head, 'title')[0];
    if (titleNode) title = (titleNode.childNodes || []).map(node => node.value || '').join('').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
    const candidates = [...elements(document, 'main', { visibleOnly: true }), ...elements(document, 'article', { visibleOnly: true }), ...elements(document, 'body', { visibleOnly: true })];
    text = '';
    for (const candidate of candidates) { text = extract(candidate); if (text) break; }
  } else text = decoded.replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { error: 'EMPTY_CONTENT' };
  const truncated = text.length > maxChars;
  if (truncated) {
    text = text.slice(0, maxChars);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  return { title, text, truncated };
}
