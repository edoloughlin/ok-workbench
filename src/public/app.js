const documentPane = document.querySelector('#document');
const nav = document.querySelector('#file-nav');
const picker = document.querySelector('#project-select');
const workspaceAssetOrigin = document.querySelector('meta[name="ok-workbench-asset-origin"]')?.content.replace(/\/$/, '');
const createProjectUi = {
  button: document.querySelector('#create-project-button'), dialog: document.querySelector('#create-project-dialog'), form: document.querySelector('#create-project-form'),
  name: document.querySelector('#create-project-name'), id: document.querySelector('#create-project-id'), description: document.querySelector('#create-project-description'),
  cancel: document.querySelector('#create-project-cancel'), close: document.querySelector('.create-project-header button'), submit: document.querySelector('#create-project-submit'), error: document.querySelector('#create-project-error')
};
const externalLinkUi = {
  dialog: document.querySelector('#external-link-dialog'), form: document.querySelector('#external-link-form'), alias: document.querySelector('#external-link-alias'), target: document.querySelector('#external-link-target'),
  close: document.querySelector('#external-link-close'), cancel: document.querySelector('#external-link-cancel'), approve: document.querySelector('#external-link-approve'), error: document.querySelector('#external-link-error')
};
let displayedDocument = null;
let pageLoadSequence = 0;
let pendingEntryRename = null;
let mermaidModulePromise = null;
const sectionPreview = document.createElement('aside');
sectionPreview.className = 'section-preview'; sectionPreview.setAttribute('role', 'tooltip'); sectionPreview.hidden = true;
sectionPreview.innerHTML = '<span class="section-preview-number"></span><span class="section-preview-title"></span>';
document.body.append(sectionPreview);
let sectionPreviewTimer = null;

function dismissSectionPreview() { clearTimeout(sectionPreviewTimer); sectionPreviewTimer = setTimeout(() => { sectionPreview.hidden = true; }, 90); }
function positionSectionPreview(x, y) {
  const gap = 14; const padding = 10; const rect = sectionPreview.getBoundingClientRect();
  sectionPreview.style.left = `${Math.max(padding, Math.min(x + gap, innerWidth - rect.width - padding))}px`;
  sectionPreview.style.top = `${Math.max(padding, Math.min(y + gap, innerHeight - rect.height - padding))}px`;
}
function showSectionPreview(reference, x, y) {
  clearTimeout(sectionPreviewTimer);
  sectionPreview.querySelector('.section-preview-number').textContent = reference.dataset.sectionNumber;
  sectionPreview.querySelector('.section-preview-title').textContent = reference.dataset.sectionMissing === 'true' ? 'Heading not found in this document; it may refer to another document.' : reference.dataset.sectionTitle;
  sectionPreview.hidden = false; positionSectionPreview(x, y);
}
documentPane.addEventListener('pointerover', event => {
  const reference = event.target.closest('.section-reference'); if (!reference || !documentPane.contains(reference)) return;
  showSectionPreview(reference, event.clientX, event.clientY);
});
documentPane.addEventListener('pointerout', event => {
  const reference = event.target.closest('.section-reference'); if (reference && !reference.contains(event.relatedTarget) && !sectionPreview.contains(event.relatedTarget)) dismissSectionPreview();
});
documentPane.addEventListener('focusin', event => {
  const reference = event.target.closest('.section-reference'); if (!reference) return;
  const rect = reference.getBoundingClientRect(); showSectionPreview(reference, rect.left, rect.bottom);
});
documentPane.addEventListener('focusout', event => { if (event.target.closest('.section-reference') && !sectionPreview.contains(event.relatedTarget)) dismissSectionPreview(); });
sectionPreview.addEventListener('pointerenter', () => clearTimeout(sectionPreviewTimer));
sectionPreview.addEventListener('pointerleave', dismissSectionPreview);

function loadMermaid() {
  mermaidModulePromise ||= import('/vendor/mermaid/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', flowchart: { htmlLabels: false }, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });
    return mermaid;
  });
  return mermaidModulePromise;
}

async function renderMermaidDiagrams(container) {
  const diagrams = Array.from(container.querySelectorAll('.mermaid-diagram:not([data-mermaid-rendered])'));
  if (!diagrams.length) return;
  const sources = new Map(diagrams.map(diagram => [diagram, diagram.textContent]));
  diagrams.forEach(diagram => { diagram.dataset.mermaidRendered = 'pending'; });
  try {
    const mermaid = await loadMermaid();
    await mermaid.run({ nodes: diagrams });
  } catch (error) {
    console.warn('Could not render Mermaid diagram.', error);
    for (const diagram of diagrams) {
      diagram.replaceChildren(document.createTextNode(sources.get(diagram)));
      diagram.classList.add('mermaid-diagram-error');
      const message = document.createElement('p'); message.className = 'mermaid-diagram-message'; message.setAttribute('role', 'alert'); message.textContent = 'Diagram could not be rendered; showing Mermaid source.';
      diagram.before(message);
    }
  }
}

function routePath() {
  const clean = decodeURIComponent(location.pathname).replace(/\/+$/, '');
  return clean === '' || clean === '/' ? '/workspace' : clean;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function inline(value, sourcePath, sectionHeadings = new Map()) {
  const protectedParts = [];
  const protect = markup => { protectedParts.push(markup); return `\u0000${protectedParts.length - 1}\u0000`; };
  let result = escapeHtml(value).replace(/`([^`]+)`/g, (_, code) => protect(`<code>${code}</code>`));
  result = result.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => protect(`<img alt="${label}" src="${linkHref(href, sourcePath, true)}">`));
  result = result.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => protect(`<a href="${linkHref(href, sourcePath)}"${externalLinkAttributes(href)}>${label}</a>`));
  result = result.replace(/§\s*(\d+(?:\.\d+)*)\b/g, (reference, number) => {
    const heading = sectionHeadings.get(number);
    if (!heading) return `<span class="section-reference section-reference-missing" data-section-number="${number}" data-section-missing="true" tabindex="0" role="note">§${number}</span>`;
    return `<a class="section-reference" href="#${heading.id}" data-section-number="${number}" data-section-title="${escapeHtml(heading.title)}" aria-label="Section ${number}: ${escapeHtml(heading.title)}">§${number}</a>`;
  });
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>').replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');
  return result.replace(/\u0000(\d+)\u0000/g, (_, index) => protectedParts[index]);
}

function linkHref(href, sourcePath, asset = false) {
  if (/^(?:https?:|mailto:|#)/i.test(href)) return href;
  const [raw, hash] = href.split('#');
  const source = sourcePath.split('/').slice(0, -1);
  const output = raw.startsWith('/') ? raw.split('/') : [...source, ...raw.split('/')].reduce((parts, part) => part === '..' ? (parts.pop(), parts) : part !== '.' && part ? (parts.push(part), parts) : parts, []);
  const encodePathPart = part => { try { return encodeURIComponent(decodeURIComponent(part)); } catch { return encodeURIComponent(part); } };
  const resolved = `/${output.filter(Boolean).map(encodePathPart).join('/')}`.replace(/^\/workspace\/workspace/, '/workspace');
  const target = asset ? `${workspaceAssetOrigin}${resolved}` : resolved;
  return `${target}${hash ? `#${encodeURIComponent(hash)}` : ''}`;
}

function externalLinkAttributes(href) {
  return /^(?:https?:)\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
}

const KEYWORDS = {
  python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case',
  javascript: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield',
  typescript: 'abstract any as asserts async await boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface keyof let namespace never new null number object of private protected public readonly return set static string super switch symbol this throw true try type typeof undefined unknown var void while with yield',
  shell: 'case do done elif else esac fi for function if in local readonly return select then time until while',
  sql: 'all alter and as asc between by case create delete desc distinct drop else end exists from group having in index inner insert into is join left like limit not null on or order outer primary right select set table then union unique update values when where',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while',
  cpp: 'alignas alignof and asm auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend if inline int long namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while',
  ruby: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield',
  perl: 'continue do else elsif for foreach given goto if last local my next no our package redo require return state sub unless until use when while',
  php: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include instanceof interface isset list match namespace new null or print private protected public readonly require return static switch throw trait true try unset use var while xor yield',
  makefile: 'define else endef endif export ifdef ifeq ifndef ifneq include override private sinclude undefine unexport vpath',
  dockerfile: 'ADD ARG CMD COPY ENTRYPOINT ENV EXPOSE FROM HEALTHCHECK LABEL MAINTAINER ONBUILD RUN SHELL STOPSIGNAL USER VOLUME WORKDIR'
};
for (const language of Object.keys(KEYWORDS)) KEYWORDS[language] = new Set(KEYWORDS[language].split(' '));

function token(className, value) { return `<span class="tok-${className}">${escapeHtml(value)}</span>`; }

function highlightCode(source, language = 'plaintext') {
  const lang = language.toLowerCase().replace(/^(?:js|jsx)$/, 'javascript').replace(/^(?:ts|tsx)$/, 'typescript').replace(/^(?:sh|bash|zsh)$/, 'shell');
  if (lang === 'plaintext' || lang === 'csv') return escapeHtml(source);
  if (lang === 'diff') return source.split('\n').map(line => {
    const kind = line.startsWith('+') && !line.startsWith('+++') ? 'inserted' : line.startsWith('-') && !line.startsWith('---') ? 'deleted' : line.startsWith('@@') ? 'keyword' : 'comment';
    return token(kind, line);
  }).join('\n');

  const hashComments = new Set(['python', 'shell', 'ruby', 'perl', 'yaml', 'toml', 'ini', 'gitignore', 'makefile', 'dockerfile']);
  const slashComments = new Set(['javascript', 'typescript', 'go', 'rust', 'java', 'c', 'cpp', 'php', 'css']);
  const blockComments = new Set(['javascript', 'typescript', 'go', 'rust', 'java', 'c', 'cpp', 'php', 'css']);
  const keywords = KEYWORDS[lang] || new Set();
  let output = ''; let index = 0;

  while (index < source.length) {
    const rest = source.slice(index);
    if (lang === 'html' && rest.startsWith('<!--')) { const end = source.indexOf('-->', index + 4); const stop = end < 0 ? source.length : end + 3; output += token('comment', source.slice(index, stop)); index = stop; continue; }
    if (blockComments.has(lang) && rest.startsWith('/*')) { const end = source.indexOf('*/', index + 2); const stop = end < 0 ? source.length : end + 2; output += token('comment', source.slice(index, stop)); index = stop; continue; }
    if ((hashComments.has(lang) && source[index] === '#') || (slashComments.has(lang) && rest.startsWith('//')) || (lang === 'sql' && rest.startsWith('--'))) { const end = source.indexOf('\n', index); const stop = end < 0 ? source.length : end; output += token('comment', source.slice(index, stop)); index = stop; continue; }
    if (lang === 'html' && source[index] === '<') { const match = rest.match(/^<\/?[A-Za-z][^>]*>/); if (match) { output += token('keyword', match[0]); index += match[0].length; continue; } }
    if ('\'"`'.includes(source[index])) { const quote = source[index]; let stop = index + 1; while (stop < source.length) { if (source[stop] === '\\') { stop += 2; continue; } if (source[stop++] === quote) break; } output += token('string', source.slice(index, stop)); index = stop; continue; }
    const number = rest.match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i); if (number) { output += token('number', number[0]); index += number[0].length; continue; }
    const identifier = rest.match(/^[A-Za-z_$][\w$-]*/); if (identifier) {
      const value = identifier[0]; const after = source.slice(index + value.length);
      const kind = keywords.has(value) || keywords.has(value.toLowerCase()) ? 'keyword' : /^(?:true|false|null|none|undefined)$/i.test(value) ? 'literal' : /^\s*\(/.test(after) ? 'function' : /^\s*:/.test(after) && ['json', 'yaml', 'css', 'toml'].includes(lang) ? 'property' : '';
      output += kind ? token(kind, value) : escapeHtml(value); index += value.length; continue;
    }
    if (/[{}()[\].,:;=+*/<>!&|%-]/.test(source[index])) output += token('operator', source[index]);
    else output += escapeHtml(source[index]);
    index++;
  }
  return output;
}

function table(lines, sourcePath, sectionHeadings) {
  const rows = lines.filter(line => !/^\s*\|?\s*:?-{3,}/.test(line)).map(line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
  if (!rows.length) return '';
  return dataTable(rows, (cell) => inline(cell, sourcePath, sectionHeadings), 'markdown-table');
}

function parseCsv(source) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell === '') quoted = true;
    else if (character === ',') { row.push(cell.trim()); cell = ''; }
    else if (character === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else if (character !== '\r') cell += character;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter(values => values.some(value => value !== ''));
}

function dataTable(rows, renderCell, className) {
  const width = Math.max(...rows.map(row => row.length));
  const normalized = rows.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
  return `<table class="${className}"><thead><tr>${normalized[0].map((cell, index) => `<th scope="col" tabindex="0" data-sortable="true" aria-sort="none" data-column="${index}">${renderCell(cell, 0)}</th>`).join('')}</tr></thead><tbody>${normalized.slice(1).map((row, rowIndex) => `<tr>${row.map((cell, index) => `<td data-column="${index}">${renderCell(cell, rowIndex + 1)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function csvTable(source) {
  const rows = parseCsv(source);
  return rows.length ? dataTable(rows, cell => escapeHtml(cell), 'csv-table') : '<p class="empty-table">This CSV file is empty.</p>';
}

const TASK_STATES = {
  ' ': { name: 'To do', className: 'todo', icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" />' },
  x: { name: 'Completed', className: 'completed', icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="m5.25 8 1.8 1.8 3.7-3.7" />' },
  '~': { name: 'In progress', className: 'in-progress', icon: '<circle cx="8" cy="8" r="5.5" /><path d="M8 4.7v3.5l2.3 1.4" />' },
  '!': { name: 'Blocked', className: 'blocked', icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M8 4.8v3.5M8 10.8h.01" />' },
  '-': { name: 'Canceled', className: 'canceled', icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="m5.5 5.5 5 5m0-5-5 5" />' }
};

function taskListItem(value, sourcePath, location = {}, sectionHeadings) {
  const marker = value.match(/^\[([ xX!~\-])\]\s*/);
  if (!marker) return { isTask: false, html: `<li>${inline(value, sourcePath, sectionHeadings)}</li>` };

  const state = TASK_STATES[marker[1].toLowerCase()];
  const icon = `<button class="task-marker" type="button" title="Edit task: ${state.name}" aria-label="Edit task: ${state.name}" data-task-start-line="${location.startLine || ''}" data-task-end-line="${location.endLine || ''}" data-task-source-path="${escapeHtml(sourcePath)}"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${state.icon}</svg></button>`;
  return { isTask: true, html: `<li class="task-item task-${state.className}" data-task-state="${state.name.toLowerCase()}">${icon}<span class="task-content">${inline(value.slice(marker[0].length), sourcePath, sectionHeadings)}</span></li>` };
}

function normalizeSortableValue(text) {
  const value = text.replace(/\s+/g, ' ').trim();
  if (!value) return { kind: 'empty', value: '' };
  const numeric = value.replace(/[$,%]/g, '').replace(/,/g, '');
  if (/^-?\d+(?:\.\d+)?$/.test(numeric)) return { kind: 'number', value: Number(numeric) };
  const date = Date.parse(value);
  if (!Number.isNaN(date) && /\d/.test(value)) return { kind: 'date', value: date };
  return { kind: 'text', value };
}

function compareSortableValues(left, right, direction) {
  if (left.kind === 'empty' && right.kind === 'empty') return 0;
  if (left.kind === 'empty') return 1;
  if (right.kind === 'empty') return -1;
  if (left.kind === right.kind) {
    if (left.kind === 'number' || left.kind === 'date') return (left.value - right.value) * direction;
    return left.value.localeCompare(right.value, undefined, { numeric: true, sensitivity: 'base' }) * direction;
  }
  return left.value.toString().localeCompare(right.value.toString(), undefined, { numeric: true, sensitivity: 'base' }) * direction;
}

function sortMarkdownTable(header) {
  const table = header.closest('table');
  const tbody = table?.tBodies[0];
  if (!tbody) return;

  const headers = Array.from(header.parentElement.children);
  const columnIndex = headers.indexOf(header);
  if (columnIndex < 0) return;

  const currentColumn = Number(table.dataset.sortColumn);
  const nextDirection = currentColumn === columnIndex && table.dataset.sortDirection === 'asc' ? 'desc' : 'asc';
  const direction = nextDirection === 'asc' ? 1 : -1;
  const rows = Array.from(tbody.rows).map((row, index) => ({
    row,
    index,
    value: normalizeSortableValue((row.cells[columnIndex]?.textContent || '').trim())
  }));

  rows.sort((left, right) => compareSortableValues(left.value, right.value, direction) || left.index - right.index);
  tbody.replaceChildren(...rows.map(item => item.row));
  table.dataset.sortColumn = String(columnIndex);
  table.dataset.sortDirection = nextDirection;
  headers.forEach((cell, index) => cell.setAttribute('aria-sort', index === columnIndex ? (nextDirection === 'asc' ? 'ascending' : 'descending') : 'none'));
}

function renderMarkdown(markdown, sourcePath) {
  const normalizedMarkdown = markdown.replace(/\r/g, '');
  const frontmatter = normalizedMarkdown.match(/^---[\s\S]*?---\s*/);
  const sourceLineOffset = frontmatter ? frontmatter[0].split('\n').length - 1 : 0;
  const lines = (frontmatter ? normalizedMarkdown.slice(frontmatter[0].length) : normalizedMarkdown).split('\n');
  const headingId = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const sectionHeadings = new Map(lines.flatMap(line => {
    const heading = line.match(/^(#{1,6})\s+(.+)$/); const section = heading?.[2].match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/);
    return section ? [[section[1], { id: headingId(heading[2]), title: section[2] }]] : [];
  }));
  const fenceStart = line => line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const blockBoundary = line => /^(?:#{1,6}\s| {0,3}(?:`{3,}|~{3,})|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\s*([-*_])(?:\s*\1){2,}\s*$)/.test(line);
  const output = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const openingFence = fenceStart(line);
    if (openingFence) {
      const marker = openingFence[1][0]; const minimumLength = openingFence[1].length; const closeFence = new RegExp(`^ {0,3}${marker}{${minimumLength},}\\s*$`);
      const info = openingFence[2].trim(); const lang = info.split(/\s+/, 1)[0] || 'plaintext'; const block = [];
      while (++i < lines.length && !closeFence.test(lines[i])) block.push(lines[i]);
      if (i < lines.length) i++;
      const source = block.join('\n'); output.push(lang.toLowerCase() === 'mermaid' ? `<pre class="mermaid mermaid-diagram">${escapeHtml(source)}</pre>` : `<pre><code class="language-${escapeHtml(lang)}">${highlightCode(source, lang)}</code></pre>`); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/); if (heading) { const level = heading[1].length; const id = headingId(heading[2]); output.push(`<h${level} id="${id}">${inline(heading[2], sourcePath, sectionHeadings)}</h${level}>`); i++; continue; }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) { const tableLines = [line]; while (++i < lines.length && /^\s*\|/.test(lines[i])) tableLines.push(lines[i]); output.push(table(tableLines, sourcePath, sectionHeadings)); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { output.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) { const quote = []; while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, '')); output.push(`<blockquote><p>${inline(quote.join(' '), sourcePath)}</p></blockquote>`); continue; }
    if (/^\s*[-*+]\s+/.test(line)) { const items = []; let hasTask = false; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { const start = i; const item = [lines[i++].replace(/^\s*[-*+]\s+/, '')]; while (i < lines.length && lines[i].trim() && !blockBoundary(lines[i])) item.push(lines[i++].trim()); const rendered = taskListItem(item.join(' '), sourcePath, { startLine: start + 1 + sourceLineOffset, endLine: i + sourceLineOffset }, sectionHeadings); hasTask ||= rendered.isTask; items.push(rendered.html); } output.push(`<ul${hasTask ? ' class="task-list"' : ''}>${items.join('')}</ul>`); continue; }
    if (/^\s*\d+\.\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { const item = [lines[i++].replace(/^\s*\d+\.\s+/, '')]; while (i < lines.length && lines[i].trim() && !blockBoundary(lines[i])) item.push(lines[i++].trim()); items.push(`<li>${inline(item.join(' '), sourcePath, sectionHeadings)}</li>`); } output.push(`<ol>${items.join('')}</ol>`); continue; }
    const paragraph = [line]; while (++i < lines.length && lines[i].trim() && !/^(#{1,6}\s| {0,3}(?:`{3,}|~{3,})|>|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i])) paragraph.push(lines[i]); output.push(`<p>${inline(paragraph.join(' '), sourcePath, sectionHeadings)}</p>`);
  }
  return output.join('\n');
}

function normalizedRoute(path) { return path.replace(/\/index\.md$/i, '').replace(/\/$/, ''); }
function active(path) { return normalizedRoute(path) === normalizedRoute(routePath()); }
function navLink(item) { return `<a class="nav-link ${active(item.path) ? 'active' : ''}" href="${item.path}">${escapeHtml(item.label)}</a>`; }
function containsCurrent(path) { const directory = normalizedRoute(path); const current = normalizedRoute(routePath()); return current === directory || current.startsWith(`${directory}/`); }

const NAV_ICONS = {
  project: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5h6l1.7 2h9.3v9.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z"/><path d="M3.5 7.5V5.7A1.7 1.7 0 0 1 5.2 4h4.1l1.8 2h7.7a1.7 1.7 0 0 1 1.7 1.7v1.8"/></svg>',
  document: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12h6M9 15.5h6"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
  config: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12h6M9 15.5h4"/><path d="M16.5 12.5h.01"/></svg>',
  spreadsheet: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M8.5 12h7M8.5 15.5h7M12 10v7"/></svg>',
  presentation: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="12" rx="1.5"/><path d="M12 16v4M8.5 20h7M8 8h8M8 11h5"/></svg>',
  image: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="16" rx="2"/><circle cx="9" cy="9" r="1.4"/><path d="m5.5 17 4.5-4 3.1 2.8 2.2-2 3.2 3.2"/></svg>',
  archive: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14v12H5zM4 3.5h16v3H4zM10 11h4"/></svg>',
  code: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/></svg>',
  instructions: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.2 5.8L5 10l5.8 1.2L12 17l1.2-5.8L19 10l-5.8-1.2z"/><path d="m5 16-.6 2.4L2 19l2.4.6L5 22l.6-2.4L8 19l-2.4-.6z"/></svg>',
  activity: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.35-5.65L4 8.7"/><path d="M4 4v4.7h4.7M12 7v5l3.3 2"/></svg>',
  status: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.3 2.3 4.7-4.7"/></svg>',
  overview: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12h6M9 15.5h4"/></svg>',
  readme: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 5.5A3.5 3.5 0 0 1 8 3h4v16H8a3.5 3.5 0 0 0-3.5 2zM19.5 5.5A3.5 3.5 0 0 0 16 3h-4v16h4a3.5 3.5 0 0 1 3.5 2z"/></svg>'
};

const ENTRY_ACTION_ICONS = {
  page: '<span class="entry-action-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 1.75h5l3 3v9.5h-8z"/><path d="M8.5 1.75v3h3"/></svg><span class="entry-action-plus">+</span></span>',
  directory: '<span class="entry-action-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M1.75 4.25h4l1.35 1.5h7.15v8H1.75z"/><path d="M1.75 4.25V2.75h4l1.35 1.5h7.15v1.5"/></svg><span class="entry-action-plus">+</span></span>'
};

function entryCreationActions(parentPath) {
  const parent = escapeHtml(parentPath);
  return `<span class="entry-creation-actions"><button type="button" data-create-entry="page" data-entry-parent="${parent}" title="Create page" aria-label="Create page">${ENTRY_ACTION_ICONS.page}</button><button type="button" data-create-entry="directory" data-entry-parent="${parent}" title="Create directory" aria-label="Create directory">${ENTRY_ACTION_ICONS.directory}</button></span>`;
}

const CORE_DOCUMENTS = {
  'AGENTS.md': { title: 'Instructions', subtitle: 'System prompt', icon: 'instructions' },
  'log.md': { title: 'Activity', subtitle: 'Operation log', icon: 'activity' },
  'status.md': { title: 'Status', subtitle: 'Current project state', icon: 'status' },
  'index.md': { title: 'Overview', subtitle: 'Project index', icon: 'overview' },
  'README.md': { title: 'Read me', subtitle: 'Project guide', icon: 'readme' }
};

function coreDocumentLink(item) {
  const document = CORE_DOCUMENTS[item.label] || { title: item.label, subtitle: 'Core document', icon: 'document' };
  return `<a class="core-document ${active(item.path) ? 'active' : ''}" href="${item.path}"><span class="nav-icon core-icon">${NAV_ICONS[document.icon]}</span><span class="core-document-copy"><span class="core-document-title">${escapeHtml(document.title)}</span><span class="core-document-subtitle">${escapeHtml(document.subtitle)}</span></span></a>`;
}

function projectLink(item) {
  return `<a class="nav-link project-link ${active(item.path) ? 'active' : ''}" href="${item.path}"><span class="nav-icon project-icon">${NAV_ICONS.project}</span><span>${escapeHtml(item.label)}</span></a>`;
}

function fileIcon(path) {
  const name = path.split('/').pop().toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const types = {
    sh: ['terminal', 'shell'], bash: ['terminal', 'shell'], zsh: ['terminal', 'shell'], fish: ['terminal', 'shell'], ps1: ['terminal', 'shell'],
    conf: ['config', 'config'], cfg: ['config', 'config'], ini: ['config', 'config'], toml: ['config', 'config'], yaml: ['config', 'config'], yml: ['config', 'config'], json: ['config', 'config'], env: ['config', 'config'],
    xlsx: ['spreadsheet', 'spreadsheet'], xls: ['spreadsheet', 'spreadsheet'], csv: ['spreadsheet', 'spreadsheet'], ods: ['spreadsheet', 'spreadsheet'],
    pptx: ['presentation', 'presentation'], ppt: ['presentation', 'presentation'], odp: ['presentation', 'presentation'], key: ['presentation', 'presentation'],
    png: ['image', 'image'], jpg: ['image', 'image'], jpeg: ['image', 'image'], gif: ['image', 'image'], webp: ['image', 'image'], svg: ['image', 'image'],
    zip: ['archive', 'archive'], gz: ['archive', 'archive'], tgz: ['archive', 'archive'], bz2: ['archive', 'archive'], xz: ['archive', 'archive'], tar: ['archive', 'archive'],
    js: ['code', 'code'], mjs: ['code', 'code'], cjs: ['code', 'code'], ts: ['code', 'code'], tsx: ['code', 'code'], jsx: ['code', 'code'], py: ['code', 'code'], rb: ['code', 'code'], go: ['code', 'code'], rs: ['code', 'code'], java: ['code', 'code'], c: ['code', 'code'], h: ['code', 'code'], cpp: ['code', 'code'], hpp: ['code', 'code'], css: ['code', 'code'], html: ['code', 'code'], sql: ['code', 'code']
  };
  const [icon, kind] = types[extension] || ['document', extension === 'md' ? 'markdown' : 'generic'];
  return `<span class="nav-icon page-icon file-icon-${kind}">${NAV_ICONS[icon]}</span>`;
}

function treeNode(item) {
  if (item.type === 'file') {
    if (pendingEntryRename?.path === item.path) return `<form class="tree-inline-rename" data-entry-path="${escapeHtml(item.path)}">${fileIcon(item.path)}<input type="text" value="${escapeHtml(item.label)}" maxlength="120" aria-label="Page name"><span class="tree-inline-extension" aria-hidden="true">.md</span></form>`;
    const renamable = item.path.split('/').pop() !== 'index.md';
    return `<a class="nav-link tree-link tree-page ${active(item.path) ? 'active' : ''}" href="${item.path}" ${renamable ? 'data-entry-type="page"' : ''}>${fileIcon(item.path)}<span>${escapeHtml(item.label)}</span></a>`;
  }
  if (item.type === 'external-link') {
    const status = item.status === 'approved' ? 'External · read only' : item.status === 'changed' ? 'External link changed' : item.status === 'missing' ? 'External link missing' : 'External link · enable';
    if (item.status === 'approved') return `<a class="nav-link tree-link tree-page external-link-approved ${active(item.path) ? 'active' : ''}" href="${item.path}"><span class="nav-icon page-icon">${NAV_ICONS.project}</span><span>${escapeHtml(item.label)} <small>${status}</small></span></a>`;
    return `<button class="external-link-request tree-link tree-page" type="button" data-external-link="${escapeHtml(item.linkPath)}"><span class="nav-icon page-icon">${NAV_ICONS.project}</span><span>${escapeHtml(item.label)} <small>${status}</small></span></button>`;
  }
  if (item.type === 'internal-link') return `<a class="nav-link tree-link tree-page" href="${item.path}"><span class="nav-icon page-icon">${NAV_ICONS.project}</span><span>${escapeHtml(item.label)} <small>Linked inside workspace</small></span></a>`;
  if (pendingEntryRename?.path === item.path) return `<div class="tree-inline-directory"><span class="nav-icon page-icon">${NAV_ICONS.project}</span><form class="tree-inline-rename" data-entry-path="${escapeHtml(item.path)}"><input type="text" value="${escapeHtml(item.label)}" maxlength="120" aria-label="Directory name"></form></div>`;
  const containsPendingEntry = pendingEntryRename?.path.startsWith(`${item.path}/`);
  return `<details class="tree-directory" ${containsCurrent(item.path) || containsPendingEntry ? 'open' : ''}><summary><a class="tree-directory-link ${active(item.path) ? 'active' : ''}" href="${item.path}" data-entry-type="directory">${escapeHtml(item.label)}</a>${entryCreationActions(item.path)}</summary><div class="tree-children">${item.children.length ? item.children.map(treeNode).join('') : '<span class="tree-empty">Empty</span>'}</div></details>`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderFile(file, kicker) {
  const header = `<p class="doc-kicker">${escapeHtml(kicker)}</p><div class="file-header"><h1>${escapeHtml(file.name)}</h1><span>${escapeHtml(file.fileType)} · ${formatBytes(file.size)}</span></div>`;
  if (file.kind === 'code' && file.language === 'csv') return `${header}${csvTable(file.text)}`;
  if (file.kind === 'code') return `${header}<pre class="source-view" data-language="${escapeHtml(file.language)}"><code>${highlightCode(file.text, file.language)}</code></pre>`;
  if (file.kind === 'media' && file.mediaType === 'image') return `${header}<figure class="media-view"><a href="${file.url}" target="_blank" rel="noopener noreferrer"><img src="${file.url}" alt="${escapeHtml(file.name)}"></a></figure>`;
  if (file.kind === 'media' && file.mediaType === 'pdf') return `${header}<iframe class="document-view" src="${file.url}" title="${escapeHtml(file.name)}"></iframe>`;
  if (file.kind === 'media' && file.mediaType === 'audio') return `${header}<div class="media-view"><audio controls src="${file.url}"></audio></div>`;
  if (file.kind === 'media' && file.mediaType === 'video') return `${header}<div class="media-view"><video controls src="${file.url}"></video></div>`;
  return `${header}<div class="binary-view"><p>This file cannot be previewed safely in the browser.</p><a href="${file.url}" target="_blank" rel="noopener">Open or download file ↗</a></div>`;
}

let workspaceReviewState = null;
let workspaceReviewPoll = null;
let workspaceReviewShowAll = false;
let workspaceReviewNotice = null;
let workspaceReviewNoticeTimer = null;
function setWorkspaceReviewNotice(message, feedbackId) {
  if (workspaceReviewNoticeTimer) clearTimeout(workspaceReviewNoticeTimer);
  workspaceReviewNotice = { message, feedbackId };
  const region = document.querySelector('#workspace-review-status');
  if (region) region.innerHTML = `${reviewEscape(message)} ${feedbackId ? `<button class="quiet" data-review-undo-feedback="${reviewEscape(feedbackId)}">Undo</button>` : ''}`;
  workspaceReviewNoticeTimer = setTimeout(() => { workspaceReviewNotice = null; if (region) region.textContent = ''; }, 12000);
}
function stopWorkspaceReviewPolling() { if (workspaceReviewPoll) clearTimeout(workspaceReviewPoll); workspaceReviewPoll = null; }
function scheduleWorkspaceReviewPolling(state) {
  stopWorkspaceReviewPolling(); if (document.hidden || routePath() !== '/workspace' || location.hash) return;
  const delay = state?.job?.state === 'running' ? 2000 : 30000;
  workspaceReviewPoll = setTimeout(async () => { try { await refreshWorkspaceOverview(); } catch { /* Retain the last rendered, non-live state. */ } finally { if (routePath() === '/workspace' && !location.hash) scheduleWorkspaceReviewPolling(workspaceReviewState); } }, delay);
}
function reviewEscape(value) { return escapeHtml(String(value || '')); }
function reviewUrgency(value, kind) { return value === 'now' ? 'Act now' : value === 'soon' ? 'This week' : kind === 'drift' ? 'Recover direction' : kind === 'update' ? 'Needs context' : 'Prevent drift'; }
function reviewPriority(value) { return ({ focus: 'First', next: 'Next', maintain: 'Maintain', parked: 'Parked' })[value] || value; }
function reviewTrajectory(value) { return ({ on_course: 'On course', watch: 'Losing momentum', at_risk: 'At risk', drifting: 'Drifting', unknown: 'Needs an update' })[value] || value; }
function reviewLifecycleLabel(project) { return project.effectiveLifecycle === 'active' || project.effectiveLifecycle === 'unknown' ? reviewTrajectory(project.trajectory) : project.effectiveLifecycle; }
function reviewTierLabel(tier) { return ({ recommended: 'Recommended', capable: 'Capable', unverified: 'Unverified', unsupported: 'Not supported' })[tier] || 'Unverified'; }
function reviewTierHint(tier) { return ({ recommended: 'This model is verified as recommended for workspace reviews.', capable: 'This model is verified as capable but not the top tier; judgment may be less thorough on complex portfolios.', unsupported: 'Fixture evaluation found this model unsuitable for review judgment; a below-recommended confirmation is required.', unverified: 'This model has not been evaluated against the review fixtures; a below-recommended confirmation is required.' })[tier] || ''; }
function reviewRunway(item) { return item.runway?.label ? `<span class="workspace-runway">${reviewEscape(item.runway.label)}</span>` : ''; }
function reviewErrorMessage(error) {
  // Only show fixed, safe explanations for known validation failures. Never
  // display a raw model response or arbitrary validator/provider text here.
  if (error?.code === 'INVALID_REVIEW') {
    if (error.message?.startsWith('claimEvidence excerpt is not in its cited source')) return 'A supporting quote did not exactly match its cited document. The review was not saved.';
    if (error.message?.startsWith('projects must contain')) return 'The model omitted one or more projects from the review. The review was not saved.';
    if (error.message?.startsWith('project evidenceIds must contain')) return 'A project assessment did not cite any collected evidence. The review was not saved.';
    if (error.message?.startsWith('claimEvidence claim ')) return 'The model attached a supporting quote with an unsupported claim type. The review was not saved.';
    if (error.message?.startsWith('claimEvidence sourceId ')) return 'A supporting quote cited a document that was not part of the evidence. The review was not saved.';
    if (error.message?.includes('did not return valid review JSON')) return 'The model replied with text that was not a single JSON review object. The review was not saved; the response shape below shows how the reply was malformed, and the server log has a bounded preview.';
    if (error.message?.startsWith('non-active lifecycle needs supporting claimEvidence')) return 'A project was marked waiting, parked, or complete without the required supporting quote. The review was not saved.';
    return 'Could not produce a supported review.';
  }
  return error?.message || String(error || '');
}
function reviewErrorBanner(error) {
  if (!error) return '';
  // state.error is the last *recorded* attempt, persisted across restarts so
  // a failure is never silently hidden: it is not a live health check and
  // will not clear on its own. Say so, so a reload is never mistaken for a
  // fresh check, and point at the one action that can clear it.
  const at = error.at ? new Date(error.at) : null;
  const meta = at ? `<span class="workspace-error-meta">Last attempted <time title="${reviewEscape(at.toISOString())}">${reviewEscape(at.toLocaleString())}</time>; this stays until you try again.</span>` : '';
  // A persisted, content-free response shape (computed on the server) turns
  // an opaque "not valid JSON" failure into a diagnosable one: an empty
  // reply, a truncated reply, and a prose-wrapped reply all look different
  // here, and no rejected model text ever reaches the client.
  const detail = error.detail ? `<p class="workspace-error-meta-line"><span class="workspace-error-meta">Model response shape — ${reviewEscape(error.detail)}</span></p>` : '';
  return `<p class="workspace-error">Review unavailable: ${reviewEscape(reviewErrorMessage(error))}</p>${detail}${meta ? `<p class="workspace-error-meta-line">${meta}</p>` : ''}`;
}
function reviewSource(item, sources) { const source = sources?.find(value => value.id === item.evidenceIds?.[0]); if (!source?.path) return ''; const prefix = source.projectId ? `/workspace/${encodeURIComponent(source.projectId)}/` : '/workspace/'; const href = `${prefix}${source.path.split('/').map(encodeURIComponent).join('/')}`; return `<a class="workspace-source" href="${href}">Evidence: ${reviewEscape(source.path)}${source.heading ? ` · ${reviewEscape(source.heading)}` : ''}</a>`; }
async function loadWorkspaceReview() {
  const response = await chatApi('/api/workspace-review'); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not load workspace review'); workspaceReviewState = data; return data;
}
function workspaceOverviewNav(data) {
  const projects = data.projects.filter(item => item.name !== 'workspace');
  return `<div class="breadcrumbs" aria-label="Current location"><a href="/workspace/" aria-current="page">Workspace overview</a></div><p class="nav-label">Workspace</p><a class="nav-link active" href="/workspace/">Overview</a><a class="nav-link" href="/workspace/index.md">Documents</a><hr class="nav-rule"><p class="nav-label">Projects</p><div class="project-list">${projects.map(projectLink).join('')}</div>`;
}
function renderWorkspaceOverview(state) {
  const review = state.review; const sources = review?.sources || []; const tab = sessionStorage.getItem('ok-workbench-workspace-tab') || 'today'; const active = ['today', 'projects', 'focus'].includes(tab) ? tab : 'today';
  if (!review) {
    const running = state.job?.state === 'running';
    const label = running ? 'Reviewing\u2026' : (state.settings?.provider ? 'Review now' : 'Set up reviews');
    const action = running ? '' : (state.settings?.provider ? 'data-review-run' : 'data-review-settings');
    const heading = running ? 'Reviewing your projects for the first time\u2026' : (state.settings?.provider ? 'Review your projects when you are ready.' : 'Set up a read-only workspace review.');
    documentPane.innerHTML = `<section class="workspace-overview"><p id="workspace-review-status" class="workspace-status" role="status" aria-live="polite">${running ? 'Reviewing\u2026 this can take a little while on the first run.' : ''}</p><p class="doc-kicker">WORKSPACE</p><h1>Workspace overview</h1>${reviewErrorBanner(state.error)}${state.modelWarning ? `<p class="workspace-error">${reviewEscape(state.modelWarning)}</p>` : ''}<div class="workspace-empty"><h2>${reviewEscape(heading)}</h2><p>The review reads bounded project evidence, highlights priorities and risks, and never edits your files or starts work.</p><div class="workspace-actions"><button class="workspace-primary" ${action} ${running ? 'disabled' : ''}>${reviewEscape(label)}</button>${state.settings?.provider ? '<button data-review-settings>Review settings</button>' : ''}</div></div></section>`;
    scheduleWorkspaceReviewPolling(state);
    return;
  }
  const attention = review.attention || []; const visible = workspaceReviewShowAll ? attention : attention.slice(0, 3); const projects = review.projects || []; const focus = projects.find(project => project.projectId === review.assessment?.focusProjectId) || projects[0];
  const tabs = `<div class="workspace-tabs" role="tablist" aria-label="Workspace overview"><button role="tab" id="review-tab-today" aria-selected="${active === 'today'}" aria-controls="review-panel-today" data-review-tab="today">Today</button><button role="tab" id="review-tab-projects" aria-selected="${active === 'projects'}" aria-controls="review-panel-projects" data-review-tab="projects">All projects <span>${projects.length}</span></button>${state.settings?.activityTracking !== false ? `<button role="tab" id="review-tab-focus" aria-selected="${active === 'focus'}" aria-controls="review-panel-focus" data-review-tab="focus">Focus report</button>` : ''}</div>`;
  const itemMarkup = visible.length ? visible.map(item => `<article class="workspace-attention"><div><span class="workspace-project">${reviewEscape(projects.find(project => project.projectId === item.projectId)?.outcome || item.projectId)}</span><span class="workspace-urgency ${item.urgency}">${reviewUrgency(item.urgency, item.kind)}</span>${reviewRunway(item)}</div><h3>${reviewEscape(item.title)}</h3><p>${reviewEscape(item.inference)}</p>${item.escalation?.mode === 'consequence' ? `<p class="workspace-escalation"><strong>Consequence to avoid:</strong> ${reviewEscape(item.action)} Start with the recovery step below.</p>` : item.escalation?.mode === 'pattern' ? '<p class="workspace-escalation">This has remained visible across reviews. You can choose a smaller scope or park the project without losing the record.</p>' : ''}<p class="workspace-first-step"><strong>Start here:</strong> ${reviewEscape(item.firstStep)}</p><div class="workspace-actions"><button data-review-discuss="${reviewEscape(item.id)}">Discuss next step</button><button data-review-session="${reviewEscape(item.id)}">I have 30 minutes</button><button class="quiet" data-review-revisit="${reviewEscape(item.id)}">Revisit…</button>${item.escalation?.mode === 'pattern' ? `<button class="quiet" data-review-park="${reviewEscape(item.projectId)}">Park this project</button>` : ''}</div><details><summary>Why this matters</summary><p><strong>Observed:</strong> ${reviewEscape(item.observation)}</p><p><strong>Proposed:</strong> ${reviewEscape(item.action)}</p>${reviewSource(item, sources)}<div class="workspace-actions"><button class="quiet" data-review-correct="${reviewEscape(item.id)}">Correct assessment</button><button class="quiet" data-review-dismiss="${reviewEscape(item.id)}">Dismiss</button><button class="quiet" data-review-resolved="${reviewEscape(item.id)}">Resolved elsewhere</button></div></details></article>`).join('') : '<p class="workspace-quiet">No immediate action surfaced from the saved evidence.</p>';
  const changes = review.assessment?.changes || []; const sinceLastReview = changes.length ? `<section class="workspace-since-last"><p class="doc-kicker">SINCE THE LAST REVIEW</p><ul>${changes.map(item => `<li>${reviewEscape(item.text)} ${reviewSource(item, sources)}</li>`).join('')}</ul></section>` : '';
  const deferred = review.deferred || []; const deferredSection = deferred.length ? `<section class="workspace-deferred"><p class="doc-kicker">DEFERRED</p><ul>${deferred.map(item => `<li><span>${reviewEscape(item.title)}</span><small>Revisit ${reviewEscape(new Date(item.feedback.until).toLocaleString())}</small><button class="quiet" data-review-undo-feedback="${reviewEscape(item.feedback.id)}">Undo</button></li>`).join('')}</ul></section>` : '';
  const closure = !attention.length && !deferred.length && !review.assessment?.question ? '<p class="workspace-closure">Nothing else here needs a decision right now.</p>' : '';
  const today = `<section id="review-panel-today" role="tabpanel" aria-labelledby="review-tab-today" ${active === 'today' ? '' : 'hidden'}><div class="workspace-brief"><p class="doc-kicker">RECOMMENDED FOCUS</p><h2>${reviewEscape(review.assessment?.headline || `Focus on ${focus?.projectId || 'your next project'}`)}</h2><p>${reviewEscape(review.assessment?.summary || 'Review the project evidence to choose the next useful action.')}</p>${focus ? `<button data-review-session-focus="${reviewEscape(focus.projectId)}">I have 30 minutes</button>` : ''}</div>${sinceLastReview}<section class="workspace-attention-list"><div class="workspace-section-heading"><div><h2>Needs attention</h2><p>Small, evidenced next steps across your projects.</p></div>${attention.length > 3 ? `<button class="quiet" data-review-show-all>${workspaceReviewShowAll ? 'Show fewer' : `Show all ${attention.length}`}</button>` : ''}</div>${itemMarkup}</section>${deferredSection}${review.assessment?.question ? `<section class="workspace-question"><p class="doc-kicker">ONE THING TO CLARIFY</p><h2>${reviewEscape(review.assessment.question.text)}</h2><p>${reviewEscape(review.assessment.question.reason)}</p>${review.assessment.question.options.map(option => `<button data-review-answer="${reviewEscape(option)}">${reviewEscape(option)}</button>`).join(' ')} <button class="quiet" data-review-guidance>Add context…</button></section>` : ''}${closure}</section>`;
  const rows = projects.map(project => `<tr><td data-label="Project / outcome"><strong>${reviewEscape(project.projectId)}</strong><small>${reviewEscape(project.outcome)}</small></td><td data-label="Priority"><button class="workspace-priority" data-review-priority="${reviewEscape(project.projectId)}">${reviewEscape(reviewPriority(project.effectivePriority?.priority || project.priority))} <small>${project.effectivePriority?.source === 'user' ? 'Your priority' : 'Inferred'}</small></button></td><td data-label="Trajectory"><span class="workspace-trajectory ${reviewEscape(project.trajectory)}">${reviewEscape(reviewLifecycleLabel(project))}</span><small>${reviewEscape(project.assessment)}</small></td><td data-label="Next useful step">${reviewEscape(project.nextAction || 'No next action recorded')}${state.settings?.reportableProjects?.includes(project.projectId) ? `<br><button class="quiet" data-review-report="${reviewEscape(project.projectId)}">Draft progress report</button>` : ''}</td></tr>`).join('');
  const projectsPanel = `<section id="review-panel-projects" role="tabpanel" aria-labelledby="review-tab-projects" ${active === 'projects' ? '' : 'hidden'}><div class="workspace-section-heading"><div><h2>All projects</h2><p>Priority and trajectory remain separate judgments.</p></div></div><div class="workspace-table-wrap"><table class="workspace-table"><thead><tr><th>Project / outcome</th><th>Priority</th><th>Trajectory</th><th>Next useful step</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  const focusPanel = `<section id="review-panel-focus" role="tabpanel" aria-labelledby="review-tab-focus" ${active === 'focus' ? '' : 'hidden'}><div class="workspace-section-heading"><div><h2>Where your attention went</h2><p>Activity is not progress. Counts include chat turns and changed-file events.</p></div></div><div id="workspace-focus-content" class="workspace-focus-loading">Loading local activity…</div></section>`;
  const reviewedTime = review.completedAt ? new Date(review.completedAt) : null; const staleNotice = state.freshness === 'stale' ? '<span class="workspace-stale">Changed since this review</span>' : '';
  const nextCheck = state.nextCheckAt ? `<time title="${reviewEscape(state.nextCheckAt)}">Next check ${new Date(state.nextCheckAt).toLocaleString()}</time>` : 'No automatic check scheduled'; const monitor = state.settings?.automatic ? `${state.monitor === 'paused' ? 'Automatic reviews are paused' : 'Automatic reviews are enabled'} while Workbench is running. ${nextCheck}. Scope: ${review.coverage?.filter(item => item.included).length || 0} included projects; saved reviews never edit files or start work.` : 'Automatic reviews are off. You can request a manual review; saved reviews never edit files or start work.';
  documentPane.innerHTML = `<section class="workspace-overview"><p id="workspace-review-status" class="workspace-status" role="status" aria-live="polite"></p><header class="workspace-overview-header"><div><p class="doc-kicker">THE BIG PICTURE</p><h1>Workspace overview</h1><p>${state.job?.state === 'running' ? 'Reviewing changes… ' : ''}${reviewedTime ? `<time title="${reviewedTime.toISOString()}">Last reviewed ${reviewedTime.toLocaleString()}</time>` : 'No completed review'} · ${review.coverage?.filter(item => item.included).length || 0} projects covered ${staleNotice}</p></div><div class="workspace-header-actions"><button data-review-settings>Monitoring</button>${state.settings?.automatic ? `<button data-review-pause="${state.monitor !== 'paused'}">${state.monitor === 'paused' ? 'Resume reviews' : 'Pause reviews'}</button>` : ''}<button class="workspace-primary" data-review-run ${state.job?.state === 'running' ? 'disabled' : ''}>${state.job?.state === 'running' ? 'Reviewing…' : 'Review now'}</button></div></header>${reviewErrorBanner(state.error)}${state.modelWarning ? `<p class="workspace-error">${reviewEscape(state.modelWarning)}</p>` : ''}${tabs}${today}${projectsPanel}${focusPanel}<footer class="workspace-monitor">${monitor}</footer></section>`;
  if (active === 'focus' && state.settings?.activityTracking !== false) void renderFocusReport();
  if (workspaceReviewNotice) { const region = document.querySelector('#workspace-review-status'); if (region) region.innerHTML = `${reviewEscape(workspaceReviewNotice.message)} ${workspaceReviewNotice.feedbackId ? `<button class="quiet" data-review-undo-feedback="${reviewEscape(workspaceReviewNotice.feedbackId)}">Undo</button>` : ''}`; }
  scheduleWorkspaceReviewPolling(state);
}
async function renderFocusReport() { const target = document.querySelector('#workspace-focus-content'); if (!target) return; try { const response = await chatApi('/api/workspace-review/focus'); const data = await response.json(); if (!data.enabled) { target.textContent = 'Activity tracking is disabled.'; return; } const total = data.projects.reduce((sum, item) => sum + item.sevenDays, 0) || 1; const allocation = data.allocation ? `<p class="workspace-allocation">Attention allocation: ${reviewEscape(data.allocation.dominantProjectId)} received ${data.allocation.dominantPercent}% of recorded activity while ${reviewEscape(data.allocation.unattendedProjectId)} had an evidenced upcoming date and no recorded activity. This is a local activity signal, not a progress judgment.</p>` : ''; target.innerHTML = allocation + (data.projects.length ? data.projects.map(item => `<div class="workspace-focus-row"><span>${reviewEscape(item.projectId)}</span><div><i style="width:${Math.round(item.sevenDays / total * 100)}%"></i></div><small>${item.sevenDays} events / 7 days · ${item.thirtyDays} / 30 days</small></div>`).join('') : '<p class="workspace-quiet">No local activity has been recorded yet.</p>'); } catch { target.textContent = 'Could not load the local activity report.'; } }
function reviewDialog(title, content) {
  let dialog = document.querySelector('#workspace-review-dialog');
  if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'workspace-review-dialog'; dialog.className = 'workspace-review-dialog'; document.body.append(dialog); }
  dialog.innerHTML = `<form method="dialog"><header><h2>${reviewEscape(title)}</h2><button type="button" aria-label="Close">×</button></header>${content}</form>`;
  const close = event => { event.preventDefault(); dialog.close(); };
  dialog.querySelector('header button').addEventListener('click', close);
  dialog.querySelectorAll('button[value="cancel"]').forEach(button => {
    button.type = 'button';
    button.addEventListener('click', close);
  });
  dialog.showModal();
  return dialog;
}
async function reviewControl(operation) { const state = workspaceReviewState || await loadWorkspaceReview(); const response = await chatApi('/api/workspace-review/controls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: state.controlsRevision, requestId: crypto.randomUUID(), operation }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not save review control'); await refreshWorkspaceOverview(); return data; }
async function refreshWorkspaceOverview() { const state = await loadWorkspaceReview(); if (routePath() === '/workspace' && !location.hash) renderWorkspaceOverview(state); }
async function renderProjectReviewContext(projectId, isProjectHome) {
  try {
    const state = await loadWorkspaceReview(); const review = state.review; if (!review) return;
    // The bar is deferrable, not permanently dismissable: hiding it is keyed
    // to the review it summarises, so the next completed review brings it back.
    const barKey = `ok-workbench.review-bar.${projectId}`;
    if (review.completedAt && localStorage.getItem(barKey) === review.completedAt) return;
    const project = review.projects?.find(item => item.projectId === projectId);
    const stripResponse = await chatApi(`/api/workspace-review/strip?projectId=${encodeURIComponent(projectId)}`); const stripData = stripResponse.ok ? await stripResponse.json() : { item: null }; const elsewhere = stripData.item ? [stripData.item] : [];
    const briefResponse = isProjectHome ? await chatApi(`/api/workspace-review/brief?projectId=${encodeURIComponent(projectId)}`) : null; const briefData = briefResponse?.ok ? await briefResponse.json() : null;
    const showBrief = Boolean(isProjectHome && project);
    if (!showBrief && !elsewhere.length) return;
    const live = briefData?.live; const topItem = review.attention?.find(item => item.projectId === projectId);
    const detail = showBrief ? `<details class="review-bar-more"><summary>Details</summary><div class="review-bar-panel"><p>${reviewEscape(project.assessment)}</p>${live?.status ? `<p><a href="/workspace/${encodeURIComponent(projectId)}/${live.status.path}">${reviewEscape(live.status.text)}</a></p>` : ''}${live?.log ? `<p><a href="/workspace/${encodeURIComponent(projectId)}/${live.log.path}">${reviewEscape(live.log.text)}</a></p>` : ''}${project.nextAction ? `<p><strong>Next useful step:</strong> ${reviewEscape(project.nextAction)}</p>` : ''}${topItem ? `<p><strong>Start here:</strong> ${reviewEscape(topItem.firstStep)} ${reviewRunway(topItem)}</p>` : ''}<div class="review-bar-panel-actions"><button data-review-session-focus="${reviewEscape(projectId)}">I have 30 minutes</button><button data-review-priority="${reviewEscape(projectId)}">Adjust priority</button>${state.settings?.reportableProjects?.includes(projectId) ? `<button data-review-report="${reviewEscape(projectId)}">Draft progress report</button>` : ''}<a href="/workspace/">Workspace overview</a></div></div></details>` : '';
    const briefPart = showBrief ? `<span class="review-bar-status"><strong>${reviewEscape(reviewPriority(project.effectivePriority?.priority || project.priority))}</strong><span class="workspace-trajectory ${reviewEscape(project.trajectory)}">${reviewEscape(reviewLifecycleLabel(project))}</span>${project.evidenceState === 'stale' ? '<em>Changed since review</em>' : ''}</span>${project.nextAction || project.assessment ? `<span class="review-bar-next" title="${reviewEscape(project.nextAction || project.assessment)}">${reviewEscape(project.nextAction || project.assessment)}</span>` : ''}` : '';
    const stripPart = elsewhere.map(item => `<span class="review-bar-also" title="${reviewEscape(item.title)}"><strong>${reviewEscape(item.projectId)}</strong> ${reviewEscape(item.title)}</span><button data-review-discuss="${reviewEscape(item.id)}">Discuss</button>`).join('');
    const context = document.createElement('aside'); context.className = 'project-review-bar'; context.setAttribute('aria-label', 'Workspace review');
    context.innerHTML = `<span class="review-bar-kicker">Review</span>${briefPart}${stripPart}${detail}<button class="review-bar-defer" title="Hide until the next review" aria-label="Hide until the next review">\u00d7</button>`;
    context.querySelector('.review-bar-defer').addEventListener('click', () => { if (review.completedAt) localStorage.setItem(barKey, review.completedAt); context.remove(); });
    documentPane.prepend(context);
  } catch { /* Context must never block a project document. */ }
}
function reviewIssue(id) { return workspaceReviewState?.review?.attention?.find(item => item.id === id); }
function reviewProject(id) { return workspaceReviewState?.review?.projects?.find(item => item.projectId === id); }
function closeReviewDialog() { document.querySelector('#workspace-review-dialog')?.close(); }
async function openReviewSettings() {
  const state = workspaceReviewState || await loadWorkspaceReview();
  const statusResponse = await chatApi('/api/chat/status'); const status = await statusResponse.json().catch(() => ({}));
  const controlsResponse = await chatApi('/api/workspace-review/controls'); const controlsData = controlsResponse.ok ? await controlsResponse.json().catch(() => ({})) : {};
  const providers = status.providers || []; const selectedProvider = state.settings?.provider || status.defaultProvider || '';
  const modelOptions = providerId => (providers.find(provider => provider.id === providerId)?.models || []).map(model => `<option value="${reviewEscape(model.id)}" data-review-tier="${reviewEscape(model.reviewTier || 'unverified')}">${reviewEscape(model.label || model.id)} \u00b7 ${reviewTierLabel(model.reviewTier)}</option>`).join('');
  const effortOptions = (providerId, modelId) => { const model = (providers.find(provider => provider.id === providerId)?.models || []).find(item => item.id === modelId); const levels = model?.thinkingLevels || []; return `<option value="">Model default</option>${levels.map(level => `<option value="${reviewEscape(level)}">${reviewEscape(level)}</option>`).join('')}`; };
  const projects = state.review?.projects?.map(project => project.projectId) || [];
  const checked = (items, id) => items?.includes(id) ? 'checked' : '';
  const guidanceItemMarkup = entry => `<li><div><strong>${reviewEscape(entry.projectId || 'Workspace')}</strong><span>${reviewEscape(new Date(entry.createdAt).toLocaleString())}</span></div><p>${reviewEscape(entry.text)}</p><button class="quiet" type="button" data-review-remove-guidance="${reviewEscape(entry.id)}">Remove</button></li>`;
  const guidanceListMarkup = list => list.length ? `<ul class="workspace-guidance-list">${list.map(guidanceItemMarkup).join('')}</ul>` : '<p class="workspace-quiet">No saved guidance yet. Corrections and answered questions appear here.</p>';
  const guidanceEntries = (controlsData.controls?.guidance || []).slice().reverse();
  const guidanceToText = list => list.slice().reverse().map(entry => `- [${entry.projectId || 'workspace'}] ${entry.text} (${entry.createdAt})`).join('\n');
  const dialog = reviewDialog('Workspace review settings', `<div class="workspace-dialog-body"><p>Reviews are read-only. They use the selected chat provider and a bounded local evidence bundle.</p><label>Provider<select name="provider" id="review-settings-provider"><option value="">Choose a provider</option>${providers.map(provider => `<option value="${reviewEscape(provider.id)}" ${provider.id === selectedProvider ? 'selected' : ''}>${reviewEscape(provider.label)}</option>`).join('')}</select></label><label>Model<select name="model" id="review-settings-model">${modelOptions(selectedProvider)}</select></label><p id="review-settings-model-tier" class="workspace-model-tier"></p><label>Reasoning effort<select name="effort" id="review-settings-effort">${effortOptions(selectedProvider, state.settings?.model)}</select></label><label class="workspace-check"><input type="checkbox" name="automatic" ${state.settings?.automatic ? 'checked' : ''}> Run automatic reviews while Workbench is open</label><label class="workspace-check"><input type="checkbox" name="meteredAutomatic" ${state.settings?.confirmations?.meteredAutomatic ? 'checked' : ''}> I understand automatic reviews may use metered provider credits</label><label class="workspace-check"><input type="checkbox" name="belowRecommendedModel" ${state.settings?.confirmations?.belowRecommendedModel ? 'checked' : ''}> I understand a lower-capability model may misjudge priorities without visible error</label><label class="workspace-check"><input type="checkbox" name="activityTracking" ${state.settings?.activityTracking !== false ? 'checked' : ''}> Keep local activity counts for the focus report</label><fieldset><legend>Projects to exclude from review</legend>${projects.map(id => `<label class="workspace-check"><input type="checkbox" name="excludedProjects" value="${reviewEscape(id)}" ${checked(state.settings?.excludedProjects, id)}> ${reviewEscape(id)}</label>`).join('') || '<p>No reviewed projects yet.</p>'}</fieldset><fieldset><legend>Projects that may draft copy-only reports</legend>${projects.map(id => `<label class="workspace-check"><input type="checkbox" name="reportableProjects" value="${reviewEscape(id)}" ${checked(state.settings?.reportableProjects, id)}> ${reviewEscape(id)}</label>`).join('') || '<p>No reviewed projects yet.</p>'}</fieldset><fieldset class="workspace-guidance-fieldset"><legend>Guidance</legend><p>Corrections and answers you record persist here as reviewer guidance. This is stored in Workbench on this device; it is not written into your workspace files.</p><div id="review-settings-guidance-list">${guidanceListMarkup(guidanceEntries)}</div><button class="quiet" type="button" data-review-copy-guidance ${guidanceEntries.length ? '' : 'disabled'}>Copy guidance</button></fieldset><p class="workspace-dialog-error" hidden></p><footer><button value="cancel">Cancel</button><button class="workspace-primary" value="default" data-review-save-settings>Save settings</button></footer></div>`);
  const model = dialog.querySelector('#review-settings-model'); const provider = dialog.querySelector('#review-settings-provider'); const effort = dialog.querySelector('#review-settings-effort');
  const refreshEffort = () => { effort.innerHTML = effortOptions(provider.value, model.value); const levels = [...effort.options].map(option => option.value).filter(Boolean); effort.value = state.settings?.provider === provider.value && state.settings?.model === model.value && levels.includes(state.settings?.effort) ? state.settings.effort : (levels.at(-1) || ''); };
  const tierHint = dialog.querySelector('#review-settings-model-tier');
  const refreshTierHint = () => { const tier = model.options[model.selectedIndex]?.dataset.reviewTier || 'unverified'; tierHint.textContent = reviewTierHint(tier); tierHint.dataset.reviewTier = tier; };
  const refreshModels = () => { const current = providers.find(item => item.id === provider.value); model.innerHTML = modelOptions(provider.value); const desired = state.settings?.provider === provider.value ? state.settings?.model : current?.models?.[0]?.id; if (desired) model.value = desired; refreshEffort(); refreshTierHint(); };
  model.addEventListener('change', refreshTierHint);
  const resetConfirmations = () => { dialog.querySelector('[name=meteredAutomatic]').checked = false; dialog.querySelector('[name=belowRecommendedModel]').checked = false; };
  provider.addEventListener('change', () => { resetConfirmations(); refreshModels(); }); model.addEventListener('change', () => { resetConfirmations(); refreshEffort(); }); refreshModels();
  let currentGuidance = guidanceEntries; const copyGuidanceButton = dialog.querySelector('[data-review-copy-guidance]');
  dialog.querySelector('#review-settings-guidance-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-review-remove-guidance]'); if (!button) return;
    try { await reviewControl({ operation: 'remove_guidance', guidanceId: button.dataset.reviewRemoveGuidance }); currentGuidance = currentGuidance.filter(entry => entry.id !== button.dataset.reviewRemoveGuidance); dialog.querySelector('#review-settings-guidance-list').innerHTML = guidanceListMarkup(currentGuidance); copyGuidanceButton.disabled = !currentGuidance.length; } catch (caught) { alert(caught.message); }
  });
  copyGuidanceButton?.addEventListener('click', async () => { await navigator.clipboard.writeText(guidanceToText(currentGuidance)); copyGuidanceButton.textContent = 'Copied'; setTimeout(() => { copyGuidanceButton.textContent = 'Copy guidance'; }, 2000); });
  dialog.querySelector('[data-review-save-settings]').addEventListener('click', async event => { event.preventDefault(); const form = new FormData(dialog.querySelector('form')); const body = { expectedRevision: state.settings.revision, provider: form.get('provider') || null, model: form.get('model') || null, effort: form.get('effort') || null, automatic: form.get('automatic') === 'on', confirmations: { meteredAutomatic: form.get('meteredAutomatic') === 'on', belowRecommendedModel: form.get('belowRecommendedModel') === 'on' }, activityTracking: form.get('activityTracking') === 'on', excludedProjects: form.getAll('excludedProjects'), reportableProjects: form.getAll('reportableProjects'), timezone: state.settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', dailyAutomaticLimit: state.settings.dailyAutomaticLimit || 6 };
    const error = dialog.querySelector('.workspace-dialog-error'); try { const response = await chatApi('/api/workspace-review/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not save review settings'); closeReviewDialog(); await refreshWorkspaceOverview(); } catch (caught) { error.textContent = caught.message; error.hidden = false; }
  });
}
function openPriorityDialog(projectId) {
  const project = reviewProject(projectId); if (!project) return;
  const dialog = reviewDialog(`Priority for ${projectId}`, `<div class="workspace-dialog-body"><p>Overrides are visible as your judgment; the review’s inferred priority remains available for comparison.</p><label>Priority<select name="tier"><option value="focus">Focus</option><option value="next">Next</option><option value="maintain">Maintain</option><option value="parked">Parked</option></select></label><label>Reason<textarea name="reason" required maxlength="400" placeholder="Why this belongs here"></textarea></label><footer><button value="cancel">Cancel</button><button class="workspace-primary" data-review-save-priority>Save priority</button></footer></div>`);
  dialog.querySelector('select').value = project.effectivePriority?.priority || project.priority;
  dialog.querySelector('[data-review-save-priority]').addEventListener('click', async event => { event.preventDefault(); const tier = dialog.querySelector('[name=tier]').value; const reason = dialog.querySelector('[name=reason]').value.trim(); if (!reason) return dialog.querySelector('[name=reason]').focus(); try { await reviewControl({ operation: 'priority', projectId, tier, reason, expiresAt: null }); closeReviewDialog(); } catch (caught) { alert(caught.message); } });
}
function openGuidanceDialog({ projectId = null, issueId = null, prefix = '' } = {}) {
  const dialog = reviewDialog('Add review context', `<div class="workspace-dialog-body"><p>This is saved as guidance for later reviews; it does not change files or silently change the current assessment.</p><label>Context<textarea name="guidance" required maxlength="2000" placeholder="${reviewEscape(prefix || 'What should the reviewer take into account?')}"></textarea></label><footer><button value="cancel">Cancel</button><button class="workspace-primary" data-review-save-guidance>Save context</button></footer></div>`);
  dialog.querySelector('[data-review-save-guidance]').addEventListener('click', async event => { event.preventDefault(); const text = dialog.querySelector('textarea').value.trim(); if (!text) return dialog.querySelector('textarea').focus(); try { await reviewControl({ operation: 'guidance', projectId, issueId, text }); closeReviewDialog(); } catch (caught) { alert(caught.message); } });
}
function openRevisitDialog(item) {
  const suggested = new Date(Date.now() + 3 * 86400000); const local = new Date(suggested.getTime() - suggested.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const dialog = reviewDialog('Revisit this later', `<div class="workspace-dialog-body"><p>This hides this exact evidenced item until the selected time. It does not change project priority or status.</p><label>Revisit at<input name="until" type="datetime-local" required value="${local}"></label><footer><button value="cancel">Cancel</button><button class="workspace-primary" data-review-save-revisit>Save revisit</button></footer></div>`);
  dialog.querySelector('[data-review-save-revisit]').addEventListener('click', async event => { event.preventDefault(); const value = dialog.querySelector('[name=until]').value; const date = new Date(value); if (!value || Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return dialog.querySelector('[name=until]').focus(); const until = date.toISOString(); try { await reviewControl({ operation: 'feedback', issueId: item.id, evidenceSignature: item.evidenceSignature, action: 'snooze', until }); closeReviewDialog(); } catch (caught) { alert(caught.message); } });
}
async function reviewChatHandoff(projectId, message) {
  const existingDraft = chatUi.input.value.trim();
  if (existingDraft && chatProjectId !== projectId) {
    const dialog = reviewDialog('Keep your unsent draft?', `<div class="workspace-dialog-body"><p>You have an unsent draft in ${reviewEscape(chatProjectId === 'workspace' ? 'workspace chat' : chatProjectId)}.</p><footer><button type="button" data-review-handoff-cancel>Cancel</button><button type="button" data-review-handoff-append>Append to handoff</button><button class="workspace-primary" type="button" data-review-handoff-replace>Replace draft</button></footer></div>`);
    const choice = await new Promise(resolve => { let settled = false; const finish = value => { if (settled) return; settled = true; dialog.close(); resolve(value); }; dialog.addEventListener('cancel', () => finish('cancel'), { once: true }); dialog.querySelector('header button').addEventListener('click', event => { event.preventDefault(); finish('cancel'); }); dialog.querySelector('[data-review-handoff-cancel]').addEventListener('click', () => finish('cancel')); dialog.querySelector('[data-review-handoff-append]').addEventListener('click', () => finish('append')); dialog.querySelector('[data-review-handoff-replace]').addEventListener('click', () => finish('replace')); });
    if (choice === 'cancel') return; if (choice === 'append') message = `${existingDraft}\n\n${message}`;
  }
  history.pushState({}, '', `/workspace/${encodeURIComponent(projectId)}/`); await loadPage();
  chatUi.input.value = message; chatUi.input.focus();
}
function reportMarkdown(report) {
  const section = (title, items) => items?.length ? `\n## ${title}\n${items.map(item => `- ${item.text}`).join('\n')}\n` : '';
  return `# ${report.draft.headline}\n\n_Draft · verify before sending_\n\nPeriod: ${report.period.start} to ${report.period.end}\n${section('Completed', report.draft.completed)}${section('In progress', report.draft.inProgress)}${section('Blockers', report.draft.blockers)}${section('Next steps', report.draft.nextSteps)}\n## Caveats\n${report.draft.caveats}`;
}
async function draftProgressReport(projectId) {
  const dialog = reviewDialog('Drafting progress report', `<div class="workspace-dialog-body"><p>Preparing a copy-only draft from bounded local evidence. Nothing will be sent or written to the project.</p></div>`);
  try { const response = await chatApi('/api/workspace-review/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) }); const job = await response.json().catch(() => ({})); if (!response.ok) throw new Error(job.error || 'Could not draft progress report'); let report = null; for (let attempt = 0; attempt < 80; attempt++) { await new Promise(resolve => setTimeout(resolve, 1500)); const statusResponse = await chatApi(`/api/workspace-review/reports?projectId=${encodeURIComponent(projectId)}`); const status = await statusResponse.json().catch(() => ({})); if (!statusResponse.ok) throw new Error(status.error || 'Could not check progress report'); if (status.job?.id === job.jobId && status.job.state === 'failed') throw new Error(reviewErrorMessage(status.job.error) || 'Could not draft progress report'); if (status.job?.id === job.jobId && status.job.state === 'completed') { report = status.reports?.find(item => item.id === status.job.reportId) || null; break; } } if (!report) throw new Error('The report is taking longer than expected; check again shortly.'); dialog.innerHTML = `<form method="dialog"><header><h2>Draft progress report</h2><button aria-label="Close">×</button></header><div class="workspace-dialog-body"><p><strong>Draft · verify before sending</strong></p><p>${reviewEscape(report.period.start)} to ${reviewEscape(report.period.end)}</p><h3>${reviewEscape(report.draft.headline)}</h3>${['completed', 'inProgress', 'blockers', 'nextSteps'].map(key => report.draft[key]?.length ? `<section><strong>${reviewEscape(key.replace(/([A-Z])/g, ' $1'))}</strong><ul>${report.draft[key].map(item => `<li>${reviewEscape(item.text)}</li>`).join('')}</ul></section>` : '').join('')}<p><strong>Caveats:</strong> ${reviewEscape(report.draft.caveats)}</p><footer><button value="cancel">Close</button><button class="workspace-primary" type="button" data-review-copy-report>Copy report</button></footer></div></form>`; dialog.querySelector('[data-review-copy-report]').addEventListener('click', async () => { await navigator.clipboard.writeText(reportMarkdown(report)); dialog.querySelector('[data-review-copy-report]').textContent = 'Copied'; }); } catch (caught) { dialog.innerHTML = `<form method="dialog"><header><h2>Progress report unavailable</h2><button aria-label="Close">×</button></header><div class="workspace-dialog-body"><p>${reviewEscape(caught.message)}</p><footer><button>Close</button></footer></div></form>`; }
}
async function handleWorkspaceReviewAction(event) {
  const button = event.target.closest('[data-review-tab], [data-review-run], [data-review-settings], [data-review-pause], [data-review-priority], [data-review-revisit], [data-review-dismiss], [data-review-resolved], [data-review-correct], [data-review-guidance], [data-review-answer], [data-review-discuss], [data-review-session], [data-review-session-focus], [data-review-report], [data-review-park], [data-review-show-all], [data-review-strip-dismiss], [data-review-undo-feedback]');
  if (!button) return; event.preventDefault();
  try {
    if (button.dataset.reviewTab) { sessionStorage.setItem('ok-workbench-workspace-tab', button.dataset.reviewTab); renderWorkspaceOverview(workspaceReviewState); return; }
    if (button.hasAttribute('data-review-show-all')) { workspaceReviewShowAll = !workspaceReviewShowAll; renderWorkspaceOverview(workspaceReviewState); return; }
    if (button.hasAttribute('data-review-settings')) return openReviewSettings();
    if (button.hasAttribute('data-review-pause')) { const response = await chatApi('/api/workspace-review/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: button.dataset.reviewPause === 'true' }) }); if (!response.ok) throw new Error('Could not update review monitoring'); return refreshWorkspaceOverview(); }
    if (button.hasAttribute('data-review-run')) {
      const originalLabel = button.textContent; button.disabled = true; button.textContent = 'Starting\u2026';
      try { const response = await chatApi('/api/workspace-review/runs', { method: 'POST' }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not start review'); }
      catch (caught) { button.disabled = false; button.textContent = originalLabel; throw caught; }
      await refreshWorkspaceOverview(); setTimeout(() => refreshWorkspaceOverview().catch(() => {}), 2500); return;
    }
    if (button.dataset.reviewPriority) return openPriorityDialog(button.dataset.reviewPriority);
    if (button.dataset.reviewReport) return draftProgressReport(button.dataset.reviewReport);
    if (button.dataset.reviewPark) return reviewControl({ operation: 'priority', projectId: button.dataset.reviewPark, tier: 'parked', reason: 'Parked from a recurring workspace review item', expiresAt: null });
    if (button.hasAttribute('data-review-guidance')) return openGuidanceDialog();
    if (button.dataset.reviewAnswer) return openGuidanceDialog({ prefix: `Answer: ${button.dataset.reviewAnswer}` });
    if (button.dataset.reviewUndoFeedback) { await reviewControl({ operation: 'undo_feedback', feedbackId: button.dataset.reviewUndoFeedback }); setWorkspaceReviewNotice('Undone.'); return renderWorkspaceOverview(workspaceReviewState); }
    const item = reviewIssue(button.dataset.reviewRevisit || button.dataset.reviewDismiss || button.dataset.reviewResolved || button.dataset.reviewCorrect || button.dataset.reviewDiscuss || button.dataset.reviewSession || button.dataset.reviewStripDismiss);
    if (!item && !button.dataset.reviewSessionFocus) return;
    if (button.dataset.reviewRevisit) return openRevisitDialog(item);
    if (button.dataset.reviewStripDismiss) return reviewControl({ operation: 'feedback', issueId: item.id, evidenceSignature: item.evidenceSignature, action: 'strip_dismiss', until: null, reason: null });
    if (button.dataset.reviewDismiss) { const result = await reviewControl({ operation: 'feedback', issueId: item.id, evidenceSignature: item.evidenceSignature, action: 'dismiss', reason: null }); setWorkspaceReviewNotice('Item dismissed.', result.applied?.id); return renderWorkspaceOverview(workspaceReviewState); }
    if (button.dataset.reviewResolved) { const result = await reviewControl({ operation: 'feedback', issueId: item.id, evidenceSignature: item.evidenceSignature, action: 'resolved', reason: null }); setWorkspaceReviewNotice('Reported resolved by you.', result.applied?.id); return renderWorkspaceOverview(workspaceReviewState); }
    if (button.dataset.reviewCorrect) return openGuidanceDialog({ projectId: item.projectId, issueId: item.id, prefix: 'Correction: ' });
    const projectId = button.dataset.reviewSessionFocus || item.projectId; const prompt = item ? `${button.hasAttribute('data-review-session') ? 'I have 30 minutes. ' : ''}Help me take this first step for the workspace review item “${item.title}”: ${item.firstStep}` : 'I have 30 minutes. Help me choose and start the most useful next step for this project.';
    return reviewChatHandoff(projectId, prompt);
  } catch (caught) { alert(caught.message || 'Could not update the workspace review'); }
}

async function loadPage() {
  const request = ++pageLoadSequence; const route = routePath();
  const isWorkspaceOverview = route === '/workspace' && !location.hash;
  if (!isWorkspaceOverview) stopWorkspaceReviewPolling();
  documentPane.setAttribute('aria-busy', 'true'); nav.setAttribute('aria-busy', 'true'); picker.disabled = true;
  documentPane.innerHTML = '<p class="loading">Loading workspace…</p>';
  try {
    const [projectResponse, documentResponse] = await Promise.all([fetch(`/api/project?path=${encodeURIComponent(route)}`), isWorkspaceOverview ? Promise.resolve(null) : fetch(`/api/document?path=${encodeURIComponent(route)}`)]);
    if (!projectResponse.ok || (documentResponse && !documentResponse.ok)) throw new Error('That document could not be found.');
    const data = await projectResponse.json(); const documentData = documentResponse ? await documentResponse.json() : null;
    if (request !== pageLoadSequence) return;
  displayedDocument = { path: documentData?.path || '/workspace', project: data.project.name, text: documentData?.text || '' };
  document.title = isWorkspaceOverview ? 'Workspace overview / workspace' : `${documentData.title || documentData.name} / workspace`;
  document.querySelector('#project-name').textContent = data.project.title;
  document.querySelector('#stats').textContent = isWorkspaceOverview ? `${data.projects.length - 1} projects` : `${data.stats.documents} docs · ${data.stats.folders} folders · ${data.stats.indexed} indexed`;
  picker.innerHTML = data.projects.map(item => `<option value="${item.path}" ${item.path === data.project.path ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
  const navigation = data.catalog.length
    ? `<p class="nav-label">Projects</p><div class="project-list">${data.catalog.map(projectLink).join('')}</div>`
    : `<div class="nav-section-heading"><p class="nav-label">Project pages</p>${data.project.name === 'workspace' ? '' : entryCreationActions(data.project.path)}</div><div class="project-tree">${data.tree.map(treeNode).join('')}</div>`;
  nav.innerHTML = isWorkspaceOverview ? workspaceOverviewNav(data) : `<div class="breadcrumbs" aria-label="Current directory">${data.context.breadcrumbs.map((item, index) => `<a href="${item.path}" ${index === data.context.breadcrumbs.length - 1 ? 'aria-current="location"' : ''}>${escapeHtml(item.label)}</a>`).join('<span>/</span>')}</div><p class="nav-label">Core documents</p><div class="core-documents">${data.common.map(coreDocumentLink).join('')}</div><hr class="nav-rule">${navigation}`;
  if (pendingEntryRename) requestAnimationFrame(() => { const input = nav.querySelector('.tree-inline-rename input'); input?.focus(); input?.select(); });
  if (isWorkspaceOverview) { renderWorkspaceOverview(await loadWorkspaceReview()); }
  else {
    const contextLabel = data.context.name === data.project.name ? data.project.name : `${data.project.name} / ${data.context.name}`;
    const kicker = `${contextLabel} / ${documentData.name}`;
    documentPane.innerHTML = documentData.kind === 'markdown' ? `<p class="doc-kicker">${escapeHtml(kicker)}</p>${renderMarkdown(documentData.text, documentData.path)}` : renderFile(documentData, kicker);
    void renderMermaidDiagrams(documentPane);
    void renderProjectReviewContext(data.project.name, route === `/workspace/${encodeURIComponent(data.project.name)}`);
  }
  if (typeof applyChatLayout === 'function') applyChatLayout();
  if (typeof chatProjectChanged === 'function') chatProjectChanged(data.project).catch(error => setChatStatus(error.message));
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'start' }); else { documentPane.scrollTop = 0; scrollTo(0, 0); }
  } finally {
    if (request === pageLoadSequence) { documentPane.removeAttribute('aria-busy'); nav.removeAttribute('aria-busy'); picker.disabled = false; }
  }
}

function navigate(event) { const anchor = event.target.closest('a'); const href = anchor?.getAttribute('href') || ''; if (!anchor || anchor.target || /^(?:mailto:|https?:)/i.test(href)) return; const url = new URL(anchor.href); if (url.origin !== location.origin || !url.pathname.startsWith('/workspace')) return; event.preventDefault(); history.pushState({}, '', `${url.pathname}${url.hash}`); loadPage().catch(showError); }
function showError(error) { documentPane.removeAttribute('aria-busy'); nav.removeAttribute('aria-busy'); picker.disabled = false; documentPane.innerHTML = `<h1>Not found</h1><p>${escapeHtml(error.message)}</p>`; }

function reloadChangedDocument(event) {
  if (!displayedDocument || event.project !== displayedDocument.project || !Array.isArray(event.paths)) return;
  const projectPath = event.project === 'workspace' ? '/workspace' : `/workspace/${encodeURIComponent(event.project)}`;
  const changed = event.paths.some(path => `${projectPath}/${String(path).split('/').map(encodeURIComponent).join('/')}` === displayedDocument.path);
  if (changed) loadPage().catch(showError);
}

function handleTableInteraction(event) {
  const header = event.target.closest('th[data-sortable="true"]');
  if (!header || !documentPane.contains(header)) return;
  if (event.type === 'click' && event.target.closest('a, button, input, select, textarea, label')) return;
  if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  sortMarkdownTable(header);
}

document.addEventListener('click', navigate);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopWorkspaceReviewPolling(); else if (routePath() === '/workspace' && !location.hash) refreshWorkspaceOverview().catch(() => {}); });
documentPane.addEventListener('click', handleTableInteraction);
documentPane.addEventListener('click', event => { void handleWorkspaceReviewAction(event); });
documentPane.addEventListener('keydown', event => { const tab = event.target.closest('[data-review-tab]'); if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; const tabs = [...documentPane.querySelectorAll('[data-review-tab]')]; const current = tabs.indexOf(tab); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; event.preventDefault(); sessionStorage.setItem('ok-workbench-workspace-tab', tabs[next].dataset.reviewTab); renderWorkspaceOverview(workspaceReviewState); requestAnimationFrame(() => documentPane.querySelector(`[data-review-tab="${tabs[next].dataset.reviewTab}"]`)?.focus()); });
documentPane.addEventListener('keydown', handleTableInteraction);
picker.addEventListener('change', () => { history.pushState({}, '', `${picker.value}/`); loadPage().catch(showError); });
async function createProjectEntry(button) {
  button.disabled = true;
  try {
    const response = await chatApi(`/api/projects/${encodeURIComponent(displayedDocument.project)}/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: button.dataset.createEntry, parentPath: button.dataset.entryParent }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not create item');
    pendingEntryRename = { path: data.location, type: data.type, renameToken: data.renameToken }; await loadPage(); refreshGitStatus();
  } catch (error) { button.disabled = false; alert(error.message || 'Could not create item'); }
}
async function beginEntryRename(anchor) {
  pendingEntryRename = { path: anchor.getAttribute('href'), type: anchor.dataset.entryType }; await loadPage();
}
async function commitEntryRename(form) {
  if (form.dataset.saving === 'true') return; const input = form.querySelector('input'); const name = input.value.trim();
  if (!name) { pendingEntryRename = null; await loadPage(); return; }
  form.dataset.saving = 'true'; input.disabled = true;
  try {
    const response = await chatApi(`/api/projects/${encodeURIComponent(displayedDocument.project)}/entries`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: form.dataset.entryPath, name, renameToken: pendingEntryRename?.renameToken }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not rename item');
    pendingEntryRename = null; await loadPage(); refreshGitStatus();
  } catch (error) { form.dataset.saving = 'false'; input.disabled = false; alert(error.message || 'Could not rename item'); input.focus(); input.select(); }
}
nav.addEventListener('click', event => {
  const external = event.target.closest('[data-external-link]');
  if (external) { event.preventDefault(); void inspectExternalLink(external.dataset.externalLink).catch(showError); return; }
  const button = event.target.closest('[data-create-entry]');
  if (button) { event.preventDefault(); event.stopPropagation(); void createProjectEntry(button); return; }
  const entry = event.target.closest('[data-entry-type].active');
  if (entry) { event.preventDefault(); event.stopPropagation(); void beginEntryRename(entry); }
});

function closeExternalLinkDialog() { externalLinkUi.dialog.close(); }
async function inspectExternalLink(linkPath) {
  if (!displayedDocument?.project || displayedDocument.project === 'workspace') throw new Error('Select a project before approving an external link.');
  const inspect = await chatApi(`/api/projects/${encodeURIComponent(displayedDocument.project)}/external-links/inspect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: linkPath }) });
  const details = await inspect.json(); if (!inspect.ok) throw new Error(details.error?.message || details.error || 'Could not inspect the external link.');
  externalLinkUi.form.dataset.inspectionToken = details.inspectionToken;
  externalLinkUi.alias.textContent = linkPath; externalLinkUi.target.textContent = details.canonicalTarget; externalLinkUi.error.hidden = true;
  externalLinkUi.dialog.showModal();
}
externalLinkUi.close.addEventListener('click', closeExternalLinkDialog);
externalLinkUi.cancel.addEventListener('click', closeExternalLinkDialog);
externalLinkUi.form.addEventListener('submit', event => { void approveExternalLink(event); });
async function approveExternalLink(event) {
  event.preventDefault(); externalLinkUi.approve.disabled = true; externalLinkUi.error.hidden = true;
  try {
    const approval = await chatApi(`/api/projects/${encodeURIComponent(displayedDocument.project)}/external-links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inspectionToken: externalLinkUi.form.dataset.inspectionToken }) });
    if (!approval.ok) { const failure = await approval.json(); throw new Error(failure.error?.message || failure.error || 'Could not approve the external link.'); }
    closeExternalLinkDialog(); await loadPage();
  } catch (error) { externalLinkUi.error.textContent = error.message || 'Could not enable the external link.'; externalLinkUi.error.hidden = false; }
  finally { externalLinkUi.approve.disabled = false; }
}
nav.addEventListener('submit', event => { const form = event.target.closest('.tree-inline-rename'); if (!form) return; event.preventDefault(); void commitEntryRename(form); });
nav.addEventListener('keydown', event => { if (event.key !== 'Escape') return; const form = event.target.closest('.tree-inline-rename'); if (!form) return; event.preventDefault(); form.dataset.saving = 'true'; pendingEntryRename = null; void loadPage(); });
nav.addEventListener('focusout', event => { const form = event.target.closest('.tree-inline-rename'); if (!form || form.dataset.saving === 'true' || event.relatedTarget && form.contains(event.relatedTarget)) return; form.dataset.saving = 'true'; pendingEntryRename = null; void loadPage(); });
function suggestedProjectId(title) { return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 64); }
function closeCreateProject() { createProjectUi.dialog.close(); }
function openCreateProject() {
  createProjectUi.form.reset(); delete createProjectUi.id.dataset.edited; createProjectUi.error.hidden = true; createProjectUi.submit.disabled = false;
  createProjectUi.dialog.showModal(); requestAnimationFrame(() => createProjectUi.name.focus());
}
createProjectUi.button.addEventListener('click', openCreateProject);
createProjectUi.name.addEventListener('input', () => { if (!createProjectUi.id.dataset.edited) createProjectUi.id.value = suggestedProjectId(createProjectUi.name.value); });
createProjectUi.id.addEventListener('input', () => { createProjectUi.id.dataset.edited = 'true'; });
createProjectUi.cancel.addEventListener('click', closeCreateProject); createProjectUi.close.addEventListener('click', closeCreateProject);
createProjectUi.form.addEventListener('submit', async event => {
  event.preventDefault(); if (!createProjectUi.form.reportValidity()) return;
  createProjectUi.submit.disabled = true; createProjectUi.error.hidden = true;
  try {
    const response = await chatApi('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: createProjectUi.id.value, title: createProjectUi.name.value, description: createProjectUi.description.value }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not create project');
    closeCreateProject(); history.pushState({}, '', `${data.location}/`); await loadPage();
  } catch (error) { createProjectUi.error.textContent = error.message; createProjectUi.error.hidden = false; }
  finally { createProjectUi.submit.disabled = false; }
});
addEventListener('popstate', () => loadPage().catch(showError));
loadPage().catch(showError);

// Project chat ---------------------------------------------------------------
// The UI intentionally speaks only to same-origin APIs. Provider credentials,
// project paths, and tool execution never enter browser state.
const chatUi = {
  layout: document.querySelector('#app-layout'), pane: document.querySelector('#chat-pane'),
  toggle: document.querySelector('#chat-toggle'), collapse: document.querySelector('#chat-collapse'),
  restore: document.querySelector('#chat-restore'), restoreBadge: document.querySelector('#chat-restore-badge'),
  notificationsButton: document.querySelector('#turn-notifications-button'), notificationsMenu: document.querySelector('#turn-notifications-menu'), notificationsList: document.querySelector('#turn-notifications-list'), notificationsCount: document.querySelector('#turn-notifications-count'),
  splitter: document.querySelector('#chat-splitter'), project: document.querySelector('#chat-project'),
  provider: document.querySelector('#chat-provider'), model: document.querySelector('#chat-model'), effort: document.querySelector('#chat-effort'),
  codexLogin: document.querySelector('#chat-codex-login'), copilotLogin: document.querySelector('#chat-copilot-login'), settings: document.querySelector('#chat-settings'), settingsDialog: document.querySelector('#chat-settings-dialog'), settingsForm: document.querySelector('#chat-settings-form'), settingsClose: document.querySelector('#chat-settings-close'), settingsError: document.querySelector('#chat-settings-error'), apiKeys: document.querySelector('#chat-api-keys'), apiKeyAdd: document.querySelector('#chat-api-key-add'), tools: document.querySelector('#chat-tools'), toolSecretAdd: document.querySelector('#chat-tool-secret-add'), runtimeSave: document.querySelector('#runtime-settings-save'), runtimeDirectProvider: document.querySelector('#runtime-direct-provider'), runtimeTurnDiagnostics: document.querySelector('#runtime-turn-diagnostics'), runtimePython: document.querySelector('#runtime-python'), runtimeTimeZone: document.querySelector('#runtime-time-zone'), runtimePythonPackages: document.querySelector('#runtime-python-packages'),
  titleModel: document.querySelector('#chat-title-model'), titleEffort: document.querySelector('#chat-title-effort'),
  thread: document.querySelector('#chat-thread'), newThread: document.querySelector('#chat-new-thread'),
  messages: document.querySelector('#chat-messages'), composer: document.querySelector('#chat-composer'),
  input: document.querySelector('#chat-input'), send: document.querySelector('#chat-send'), stop: document.querySelector('#chat-stop'), authCode: document.querySelector('#chat-auth-code'), authDialog: document.querySelector('#chat-auth-dialog'), authDialogCode: document.querySelector('#chat-auth-dialog-code'),
  status: document.querySelector('#chat-status'), processDirty: document.querySelector('#chat-process-dirty'), changes: document.querySelector('#chat-changes'), changeCount: document.querySelector('#chat-change-count'),
  changesDialog: document.querySelector('#changes-dialog'), diffSummary: document.querySelector('#diff-summary'),
  diffFiles: document.querySelector('#diff-files'), diffFileTitle: document.querySelector('#diff-file-title'), diffContent: document.querySelector('#diff-content'), diffTabs: document.querySelector('#diff-source-tabs'),
  diffLayout: document.querySelector('#diff-layout'), diffPalette: document.querySelector('#diff-palette'),
  diffRevert: document.querySelector('#diff-revert'), diffUnstage: document.querySelector('#diff-unstage'), diffUndo: document.querySelector('#diff-undo')
};
const todoUi = { popover: document.querySelector('#todo-popover'), form: document.querySelector('#todo-form'), close: document.querySelector('#todo-close'), cancel: document.querySelector('#todo-cancel'), states: document.querySelector('#todo-states'), markdown: document.querySelector('#todo-markdown'), useLlm: document.querySelector('#todo-use-llm'), prompt: document.querySelector('#todo-prompt'), model: document.querySelector('#todo-model'), apply: document.querySelector('#todo-apply') };
let activeTodo = null;
function smallModel(models) { return models.find(model => /(?:mini|small|haiku|flash)/i.test(model.label || model.id))?.id || models[0]?.id || ''; }
function todoModels() {
  if (chatModels.length) return chatModels;
  return [...chatUi.model.options].filter(option => option.value).map(option => ({ id: option.value, label: option.textContent }));
}
function updateTodoLlmFields() { const disabled = !todoUi.useLlm.checked; todoUi.model.disabled = disabled; todoUi.prompt.disabled = disabled; }
function closeTodo() { todoUi.popover.hidden = true; activeTodo = null; }
function openTodo(button) {
  if (!displayedDocument?.text || !button.dataset.taskStartLine) return;
  const startLine = Number(button.dataset.taskStartLine), endLine = Number(button.dataset.taskEndLine); const lines = displayedDocument.text.replace(/\r/g, '').split('\n');
  const original = lines.slice(startLine - 1, endLine).join('\n'); if (!original) return;
  const task = original.match(/^(\s*[-*+]\s+)\[([ xX!~\-])\]\s*/);
  activeTodo = { path: button.dataset.taskSourcePath, startLine, endLine, original, markerPrefix: task?.[1] || '* ', state: (task?.[2] || ' ').toLowerCase() };
  todoUi.markdown.value = task ? original.slice(task[0].length) : original; todoUi.prompt.value = ''; todoUi.useLlm.checked = true; updateTodoLlmFields();
  const models = todoModels(); setOptions(todoUi.model, models.length ? models : [{ id: '', label: 'No configured model' }], smallModel(models)); todoUi.model.disabled = false;
  for (const state of todoUi.states.querySelectorAll('[data-todo-state]')) { const current = state.dataset.todoState === activeTodo.state; state.hidden = current; state.setAttribute('aria-pressed', String(current)); }
  const rect = button.getBoundingClientRect(); todoUi.popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 368))}px`; todoUi.popover.style.top = `${Math.min(rect.bottom + 8, innerHeight - 80)}px`; todoUi.popover.hidden = false;
  requestAnimationFrame(() => { todoUi.popover.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - todoUi.popover.offsetHeight - 8))}px`; todoUi.markdown.focus(); });
}
function todoMarkdown(state) {
  const source = todoUi.markdown.value.replace(/\r/g, '').trimEnd(); const marker = state === ' ' ? '[ ]' : `[${state}]`;
  return `${activeTodo?.markerPrefix || '* '}${marker} ${source}`;
}
async function applyTodo() {
  if (!activeTodo) return; const replacement = todoMarkdown(activeTodo.state); todoUi.apply.disabled = true;
  try {
    const response = await chatApi(`/api/projects/${encodeURIComponent(displayedDocument.project)}/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...activeTodo, replacement }) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not update task');
    const sideEffectCheck = todoUi.useLlm.checked;
    const prompt = `I updated the task in ${activeTodo.path} (lines ${activeTodo.startLine}-${activeTodo.endLine}) to:\n\n${replacement}\n\nBriefly check this project for related side effects. Update only any task, status, or log items that genuinely need to stay consistent, then summarize what you found.${todoUi.prompt.value.trim() ? `\n\nAdditional instruction: ${todoUi.prompt.value.trim()}` : ''}`;
    closeTodo(); await loadPage(); refreshGitStatus();
    if (sideEffectCheck && !currentChatTurn()) { addChatMessage('user', prompt, false, new Date().toISOString(), { initiator: 'system' }); await streamChatTurn(prompt, { model: todoUi.model.value, initiator: 'system' }); }
    else if (sideEffectCheck) setChatStatus('Task updated. Cancel or finish the active response before running its side-effect check.');
  } catch (error) { alert(error.message || 'Could not update task'); }
  finally { todoUi.apply.disabled = false; }
}
documentPane.addEventListener('click', event => { const marker = event.target.closest('.task-marker'); if (!marker) return; event.preventDefault(); openTodo(marker); });
todoUi.states.addEventListener('click', event => { const button = event.target.closest('[data-todo-state]'); if (!button || !activeTodo) return; activeTodo.state = button.dataset.todoState; for (const state of todoUi.states.querySelectorAll('[data-todo-state]')) { const current = state === button; state.hidden = current; state.setAttribute('aria-pressed', String(current)); } });
todoUi.useLlm.addEventListener('change', updateTodoLlmFields);
todoUi.close.addEventListener('click', closeTodo); todoUi.cancel.addEventListener('click', closeTodo);
todoUi.form.addEventListener('submit', event => { event.preventDefault(); void applyTodo(); });
document.addEventListener('pointerdown', event => { if (!todoUi.popover.hidden && !todoUi.popover.contains(event.target) && !event.target.closest('.task-marker')) closeTodo(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !todoUi.popover.hidden) closeTodo(); });
const chatStorageKey = 'ok-workbench.chat-pane.v1';
const chatProjectPreferencesKey = 'ok-workbench.chat-project-preferences.v1';
const defaultChatSettings = { collapsed: false, workspaceCollapsed: true, rightSize: 420, diffLayout: 'side-by-side', diffPalette: 'green', titleProvider: '', titleModel: '', titleEffort: '', showThinking: true };
let chatSettings = { ...defaultChatSettings };
try { chatSettings = { ...defaultChatSettings, ...JSON.parse(localStorage.getItem(chatStorageKey) || '{}') }; } catch { /* ignore corrupt local preference */ }
let chatProjectPreferences = {};
try { chatProjectPreferences = JSON.parse(localStorage.getItem(chatProjectPreferencesKey) || '{}'); } catch { /* ignore corrupt local preference */ }
let dirtyProjectItems = {};
let chatProjectId = null;
let chatProjectTitle = '';
let workspaceMode = false;
let chatThreadId = null;
let chatThreads = [];
let chatThreadHasUserChat = false;
let creatingChatThread = null;
// A turn belongs to the project and thread that started it. Turns may continue
// independently while the user visits another project or conversation.
const activeChatTurns = new Set();
const recentTurns = new Map();
const turnNotifications = [];
let pendingChatThread = null;
let titleModels = [];
let diffFiles = [];
let selectedDiffFile = 0;
let chatUnread = 0;
let diffSource = 'unstaged';
let diffData = null;
let diffRecoveryOperation = null;
let chatModels = [];
let chatFollowsActivity = true;
let chatScrollFrame = null;
let dirtyAuditSequence = 0;
let processingDirtyChanges = false;

function persistChatSettings() { localStorage.setItem(chatStorageKey, JSON.stringify(chatSettings)); }
function applyThinkingVisibility() { for (const turn of activeTurnsFor()) renderActiveTurn(turn); }
function setShowThinking(showThinking) { chatSettings.showThinking = Boolean(showThinking); persistChatSettings(); applyThinkingVisibility(); }
let chatCsrf = document.querySelector('meta[name="ok-workbench-csrf"]')?.content || '';
async function refreshChatCsrf() {
  const response = await fetch('/api/chat/session', { headers: { accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.csrf) throw new Error(data.error || 'Could not refresh the chat session');
  chatCsrf = data.csrf;
}
async function invalidChatToken(response) {
  if (response.status !== 400) return false;
  const data = await response.clone().json().catch(() => ({}));
  return data.error === 'Invalid chat request token';
}
async function chatApi(path, options = {}) {
  const request = () => fetch(path, { ...options, headers: { accept: 'application/json', 'x-ok-workbench-csrf': chatCsrf, ...(options.headers || {}) } });
  let response = await request();
  if (await invalidChatToken(response)) { await refreshChatCsrf(); response = await request(); }
  return response;
}
function setChatStatus(message) { chatUi.status.textContent = message; }
function renderChatProjectLabel() { chatUi.project.textContent = chatProjectId === 'workspace' ? 'Workspace chat' : (chatProjectTitle || chatProjectId || 'Loading'); }
function workspaceModeRequired() { return chatProjectId === 'workspace' && !workspaceMode; }
function dirtyItemsFor(project = chatProjectId) { return Array.isArray(dirtyProjectItems[project]) ? dirtyProjectItems[project] : []; }
function renderDirtyProcessPrompt() {
  const items = dirtyItemsFor(); chatUi.processDirty.hidden = items.length === 0;
  chatUi.processDirty.disabled = processingDirtyChanges || Boolean(currentChatTurn());
  if (!items.length) { chatUi.processDirty.removeAttribute('title'); return; }
  chatUi.processDirty.title = `These items were changed:\n\n${items.map(item => `• ${item.path}`).join('\n')}\n\nClick to have AI assess and update related files.`;
}
function setDirtyItems(items) {
  if (!chatProjectId) return;
  dirtyProjectItems[chatProjectId] = Array.isArray(items) ? items : [];
  renderDirtyProcessPrompt();
}
async function refreshDirtyStatus() {
  if (!chatProjectId || chatProjectId === 'workspace') { renderDirtyProcessPrompt(); return; }
  const request = ++dirtyAuditSequence;
  try {
    const response = await chatApi(`/api/projects/${encodeURIComponent(chatProjectId)}/dirty`); if (!response.ok) throw new Error(); const state = await response.json();
    if (request === dirtyAuditSequence) setDirtyItems(state.items || []);
  } catch { if (request === dirtyAuditSequence) renderDirtyProcessPrompt(); }
}
async function processDirtyChanges() {
  const project = chatProjectId; const items = dirtyItemsFor(project); if (processingDirtyChanges || !project || !items.length) return;
  if (currentChatTurn()) { setChatStatus('Cancel or finish the active response before processing changes.'); return; }
  processingDirtyChanges = true; renderDirtyProcessPrompt();
  const message = `Review this accumulated batch of filesystem changes and bring the project state up to date.\n\nChanged items:\n${items.map(item => `- ${item.path}`).join('\n')}\n\nUpdate every related index.md, including affected directory indexes, and update the project status.md and log.md. Inspect the project for impacts on other files. Make only changes that are genuinely needed. Discover and run relevant available project checks (for example /tools/mdcheck when present). If a check reports an actionable error, investigate it, make a careful repair, and rerun the check. If you cannot resolve a reported error, do not claim success: explain clearly what failed, what you tried, and what the user should do next. Summarize the result.`;
  try {
    const model = smallModel(chatModels); addChatMessage('user', message, false, new Date().toISOString(), { initiator: 'system' });
    const completed = await streamChatTurn(message, { model, initiator: 'system' });
    if (completed) {
      const response = await chatApi(`/api/projects/${encodeURIComponent(project)}/dirty`, { method: 'POST' });
      const state = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(state.error || 'Could not mark project changes as processed');
      dirtyProjectItems[project] = state.items || [];
    }
  } finally { processingDirtyChanges = false; renderDirtyProcessPrompt(); await refreshDirtyStatus(); }
}
function activeTurnsFor(projectId = chatProjectId, threadId = chatThreadId) { return [...activeChatTurns].filter(turn => turn.projectId === projectId && turn.threadId === threadId); }
function activeTurnFor(projectId = chatProjectId, threadId = chatThreadId) { return activeTurnsFor(projectId, threadId).at(-1) || null; }
function currentChatTurn() { return activeTurnFor(); }
function syncChatTurnControls() {
  const turn = currentChatTurn(); const steering = Boolean(turn?.supportsSteering); const ready = steering && turn.steeringReady && !turn.steeringSubmitting;
  chatUi.stop.hidden = !turn; chatUi.send.textContent = turn && steering ? 'Steer' : 'Send'; chatUi.send.disabled = Boolean(turn) && !ready;
  chatUi.processDirty.disabled = processingDirtyChanges || Boolean(turn);
  chatUi.input.disabled = Boolean(turn) && !steering;
  chatUi.input.placeholder = !turn ? (chatProjectId === 'workspace' ? 'Ask across projects…' : 'Ask about this project…') : steering ? (turn.steeringReady ? 'Add a steering comment…' : 'Preparing steering…') : 'Cancel the current response to send another comment';
  chatUi.send.title = turn && !steering ? 'Cancel the current response before sending another comment.' : '';
}
function renderTurnNotifications() {
  chatUi.notificationsCount.hidden = turnNotifications.length === 0;
  chatUi.notificationsCount.textContent = turnNotifications.length > 9 ? '9+' : String(turnNotifications.length);
  chatUi.notificationsList.replaceChildren();
  if (!turnNotifications.length) { const empty = document.createElement('p'); empty.className = 'turn-notifications-empty'; empty.textContent = 'No completed turns yet.'; chatUi.notificationsList.append(empty); return; }
  for (const notification of turnNotifications) {
    const item = document.createElement('div'); item.className = 'turn-notification-item';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'turn-notification'; button.dataset.turnNotification = notification.id;
    const title = document.createElement('strong'); title.textContent = notification.promptPreview || notification.projectTitle;
    const detail = document.createElement('span'); detail.textContent = `${notification.projectTitle} · Completed ${formatThreadTime(notification.completedAt)}`;
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'turn-notification-dismiss'; dismiss.dataset.dismissTurnNotification = notification.id; dismiss.textContent = 'Dismiss';
    button.append(title, detail); item.append(button, dismiss); chatUi.notificationsList.append(item);
  }
}
function closeTurnNotifications() { chatUi.notificationsMenu.hidden = true; chatUi.notificationsButton.setAttribute('aria-expanded', 'false'); }
function toggleTurnNotifications() { const open = chatUi.notificationsMenu.hidden; chatUi.notificationsMenu.hidden = !open; chatUi.notificationsButton.setAttribute('aria-expanded', String(open)); if (open) renderTurnNotifications(); }
function addTurnNotification(turn) { turnNotifications.unshift({ id: crypto.randomUUID(), clientTurnId: turn.clientId, turnId: turn.id, projectId: turn.projectId, projectTitle: turn.projectTitle, threadId: turn.threadId, promptPreview: turn.promptPreview, status: turn.status, completedAt: turn.completedAt }); renderTurnNotifications(); }
function dismissTurnNotification(id) { const index = turnNotifications.findIndex(item => item.id === id); if (index >= 0) turnNotifications.splice(index, 1); renderTurnNotifications(); }
function focusTurnNotification(notification) {
  const result = chatUi.messages.querySelector(`[data-turn-id="${notification.turnId}"]`) || chatUi.messages.querySelector(`[data-client-turn-id="${notification.clientTurnId}"]`);
  if (!result) { setChatStatus('That completed turn is no longer available in this thread.'); return false; }
  result.scrollIntoView({ block: 'center' }); result.classList.add('chat-turn-highlight'); setTimeout(() => result.classList.remove('chat-turn-highlight'), 1_500); return true;
}
async function openTurnNotification(id) {
  const notification = turnNotifications.find(item => item.id === id); if (!notification) return;
  if (notification.projectId === chatProjectId) {
    chatThreadId = notification.threadId; renderThreadSelect(); await loadChatThread(chatThreadId); syncChatTurnControls();
    if (focusTurnNotification(notification)) { dismissTurnNotification(id); closeTurnNotifications(); } return;
  }
  pendingChatThread = notification; const projectPath = notification.projectId === 'workspace' ? '/workspace/' : `/workspace/${encodeURIComponent(notification.projectId)}/`;
  history.pushState({}, '', projectPath); await loadPage();
}
function chatSizeBounds() {
  // Right dock: reserve the 240px file sidebar, 8px splitter, and a 320px
  // document column. At narrower widths the drawer media query takes over.
  return { min: 320, max: Math.min(720, innerWidth - 568) };
}
function clampChatSize(value) {
  const { min, max } = chatSizeBounds();
  return Math.min(max, Math.max(min, Math.round(value)));
}
function chatSize() { return clampChatSize(chatSettings.rightSize); }
function workspaceOverviewRoute() { return routePath() === '/workspace' && !location.hash; }
function currentChatCollapsed() { return workspaceOverviewRoute() ? Boolean(chatSettings.workspaceCollapsed) : Boolean(chatSettings.collapsed); }
function applyChatLayout() {
  const collapsed = currentChatCollapsed();
  chatUi.layout.classList.toggle('chat-collapsed', collapsed);
  chatUi.layout.style.setProperty('--chat-size', `${chatSize()}px`);
  chatUi.toggle.setAttribute('aria-expanded', String(!collapsed));
  chatUi.restore.hidden = !collapsed;
  chatUi.restoreBadge.textContent = chatUnread ? String(chatUnread) : '';
  chatUi.splitter.setAttribute('aria-orientation', 'vertical');
  const bounds = chatSizeBounds();
  chatUi.splitter.setAttribute('aria-valuemin', String(bounds.min));
  chatUi.splitter.setAttribute('aria-valuemax', String(bounds.max));
  chatUi.splitter.setAttribute('aria-valuenow', String(chatSize()));
  chatUi.splitter.setAttribute('aria-label', 'Resize right-docked chat pane');
  persistChatSettings();
}
function setChatCollapsed(collapsed) { if (workspaceOverviewRoute()) chatSettings.workspaceCollapsed = Boolean(collapsed); else chatSettings.collapsed = Boolean(collapsed); if (!collapsed) chatUnread = 0; applyChatLayout(); }

function setOptions(select, values, selected) {
  select.replaceChildren(...values.map(value => {
    const option = document.createElement('option'); option.value = value.id || value; option.textContent = value.label || value.id || value; option.selected = option.value === selected; return option;
  }));
}
let configuredApiKeys = [];
let workspaceTools = [];
let configuredToolSecrets = [];
let setupPrompted = false;
const apiKeyProviderOptions = [
  { id: 'anthropic', label: 'Anthropic' }, { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google Gemini' }, { id: 'mistral', label: 'Mistral' },
  { id: 'openrouter', label: 'OpenRouter' },
];
function closeChatSettings() { if (chatUi.settingsDialog.open) chatUi.settingsDialog.close(); chatUi.settings.setAttribute('aria-expanded', 'false'); }
function openChatSettings() { chatUi.settingsError.hidden = true; if (!chatUi.settingsDialog.open) chatUi.settingsDialog.showModal(); chatUi.settings.setAttribute('aria-expanded', 'true'); renderApiKeyRows(); void loadWorkspaceTools(); void loadRuntimeSettings(); }
function toggleChatSettings() { if (chatUi.settingsDialog.open) closeChatSettings(); else openChatSettings(); }
function apiKeyRow(record = null, selectedProvider = '') {
  const row = document.createElement('div'); row.className = 'chat-api-key-row';
  const configured = new Set(configuredApiKeys.map(item => item.provider));
  const selected = record?.provider || selectedProvider || apiKeyProviderOptions.find(option => !configured.has(option.id))?.id || 'anthropic';
  const provider = document.createElement('select'); provider.setAttribute('aria-label', 'API key provider'); setOptions(provider, apiKeyProviderOptions.filter(option => option.id === selected || !configured.has(option.id)), selected);
  const key = document.createElement('input'); key.type = 'password'; key.autocomplete = 'off'; key.spellcheck = false; key.setAttribute('aria-label', 'API key');
  if (record?.source === 'environment') { provider.value = record.provider; provider.disabled = true; key.disabled = true; key.type = 'text'; key.value = `Read from ${record.environment}`; key.className = 'api-key-environment'; }
  if (record?.source === 'stored') { provider.value = record.provider; provider.disabled = true; key.type = 'text'; key.value = record.preview; key.dataset.preview = record.preview; key.className = 'api-key-preview'; key.addEventListener('focus', () => { if (!key.dataset.preview) return; key.value = ''; key.type = 'password'; key.classList.remove('api-key-preview'); delete key.dataset.preview; }); }
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'api-key-remove'; remove.textContent = 'Remove';
  if (record?.source === 'environment') { remove.disabled = true; remove.title = 'This key is supplied by the server environment.'; }
  else remove.addEventListener('click', async () => { if (!record) { row.remove(); return; } await deleteApiKey(record.provider); });
  key.addEventListener('blur', async () => {
    const value = key.value.trim(); if (!value || key.disabled || value === key.dataset.preview) return;
    try { await saveApiKey(provider.value, value); } catch (error) { showSettingsError(error.message); }
  });
  provider.addEventListener('change', () => { key.focus(); });
  row.append(provider, key, remove); return row;
}
function renderApiKeyRows() {
  chatUi.apiKeys.replaceChildren();
  for (const record of configuredApiKeys) chatUi.apiKeys.append(apiKeyRow(record));
  if (!configuredApiKeys.length) { const empty = document.createElement('p'); empty.className = 'chat-api-keys-empty'; empty.textContent = 'No API keys saved.'; chatUi.apiKeys.append(empty); }
  const used = new Set(configuredApiKeys.map(record => record.provider)); chatUi.apiKeyAdd.disabled = apiKeyProviderOptions.every(option => used.has(option.id));
}
function toolRequirementSummary(tool) {
  const requirements = tool.requirements || {}; const parts = ['selected project: read/write'];
  if (requirements.secrets?.length) parts.push(`secrets: ${requirements.secrets.join(', ')}`);
  if (requirements.network?.hosts?.length) parts.push(`network requested: ${requirements.network.hosts.map(host => `${host}:${(requirements.network.ports || [443]).join('/')}`).join(', ')} (currently denied)`);
  if (requirements.timeoutSeconds) parts.push(`timeout: ${requirements.timeoutSeconds}s`);
  return parts.join(' · ');
}
function renderWorkspaceTools() {
  chatUi.tools.replaceChildren();
  if (!workspaceTools.length) { const empty = document.createElement('p'); empty.className = 'chat-api-keys-empty'; empty.textContent = 'No runnable tools in this project.'; chatUi.tools.append(empty); return; }
  for (const tool of workspaceTools) {
    const row = document.createElement('div'); row.className = 'chat-api-key-row'; const detail = document.createElement('span'); detail.textContent = `${tool.path} (${tool.runtime}) — ${toolRequirementSummary(tool)}`;
    const action = document.createElement('button'); action.type = 'button'; action.textContent = tool.approval?.approved ? 'Revoke' : 'Approve version';
    action.addEventListener('click', async () => {
      try {
        if (tool.approval?.approved) {
          if (!confirm(`Revoke approval for ${tool.path}?`)) return;
          const response = await chatApi(`/api/projects/${encodeURIComponent(chatProjectId)}/tools/approvals`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: tool.path }) }); if (!response.ok) throw new Error((await response.json()).error || 'Could not revoke tool approval');
        } else {
          const fingerprint = `${tool.toolSha256.slice(0, 12)}${tool.manifestSha256 ? ` / ${tool.manifestSha256.slice(0, 12)}` : ''}`;
          if (!confirm(`Approve this exact tool version?\n\n${tool.path}\n${toolRequirementSummary(tool)}\nFingerprint: ${fingerprint}\n\nChanging the tool or manifest revokes this approval automatically.`)) return;
          const response = await chatApi(`/api/projects/${encodeURIComponent(chatProjectId)}/tools/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: tool.path }) }); if (!response.ok) throw new Error((await response.json()).error || 'Could not approve tool');
        }
        await loadWorkspaceTools();
      } catch (error) { showSettingsError(error.message); }
    });
    row.append(detail, action); chatUi.tools.append(row);
  }
}
async function loadWorkspaceTools() {
  if (!chatProjectId) return;
  try {
    const [toolsResponse, secretsResponse] = await Promise.all([chatApi(`/api/projects/${encodeURIComponent(chatProjectId)}/tools`), chatApi('/api/chat/tool-secrets')]);
    if (!toolsResponse.ok) throw new Error((await toolsResponse.json()).error || 'Could not load workspace tools');
    workspaceTools = (await toolsResponse.json()).tools || []; configuredToolSecrets = secretsResponse.ok ? ((await secretsResponse.json()).secrets || []) : []; renderWorkspaceTools();
  } catch (error) { showSettingsError(error.message); }
}
function showSettingsError(message) { chatUi.settingsError.textContent = message; chatUi.settingsError.hidden = false; }
function renderRuntimeSettings(settings) { chatUi.runtimeDirectProvider.checked = Boolean(settings.directProvider); chatUi.runtimeTurnDiagnostics.checked = Boolean(settings.turnDiagnostics); chatUi.runtimePython.checked = Boolean(settings.python); chatUi.runtimeTimeZone.value = settings.timeZone || ''; chatUi.runtimePythonPackages.value = settings.pythonPackages || ''; }
async function loadRuntimeSettings() {
  try { const response = await chatApi('/api/chat/runtime-settings'); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load server settings'); renderRuntimeSettings(data.settings || {}); }
  catch (error) { showSettingsError(error.message); }
}
async function saveRuntimeSettings() {
  chatUi.runtimeSave.disabled = true; chatUi.settingsError.hidden = true;
  try {
    const settings = { directProvider: chatUi.runtimeDirectProvider.checked, turnDiagnostics: chatUi.runtimeTurnDiagnostics.checked, python: chatUi.runtimePython.checked, timeZone: chatUi.runtimeTimeZone.value.trim(), pythonPackages: chatUi.runtimePythonPackages.value.trim() };
    const response = await chatApi('/api/chat/runtime-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not save server settings'); renderRuntimeSettings(data.settings); await loadChatStatus();
  } catch (error) { showSettingsError(error.message); }
  finally { chatUi.runtimeSave.disabled = false; }
}
async function saveApiKey(provider, key) {
  const response = await chatApi(`/api/chat/api-keys/${encodeURIComponent(provider)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not save API key'); configuredApiKeys = data.apiKeys || []; renderApiKeyRows(); await loadChatStatus();
}
async function deleteApiKey(provider) {
  try { const response = await chatApi(`/api/chat/api-keys/${encodeURIComponent(provider)}`, { method: 'DELETE' }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not remove API key'); configuredApiKeys = data.apiKeys || []; renderApiKeyRows(); await loadChatStatus(); } catch (error) { showSettingsError(error.message); }
}
function projectChatPreference() { return chatProjectId ? chatProjectPreferences[chatProjectId] || {} : {}; }
function saveProjectChatPreference() {
  if (!chatProjectId) return;
  chatProjectPreferences[chatProjectId] = { provider: chatUi.provider.value, model: chatUi.model.value, effort: chatUi.effort.value };
  localStorage.setItem(chatProjectPreferencesKey, JSON.stringify(chatProjectPreferences));
}
function loadChatEfforts(selected) {
  const model = chatModels.find(item => item.id === chatUi.model.value);
  const efforts = model?.thinkingLevels || [];
  chatUi.effort.disabled = efforts.length === 0;
  setOptions(chatUi.effort, efforts.length ? efforts.map(id => ({ id, label: id === 'xhigh' ? 'Extra high' : id[0].toUpperCase() + id.slice(1) })) : [{ id: '', label: 'Not supported' }], efforts.includes(selected) ? selected : efforts[0] || '');
}
function titleModelKey(model) { return `${model.provider}::${model.id}`; }
function titleModelDefault() { return titleModels.find(model => /(?:mini|small|haiku|flash|nano)/i.test(`${model.id} ${model.label}`)) || titleModels[0]; }
function loadTitleEfforts(selected) {
  const model = titleModels.find(item => item.provider === chatSettings.titleProvider && item.id === chatSettings.titleModel); const efforts = model?.thinkingLevels || [];
  chatUi.titleEffort.disabled = efforts.length === 0;
  setOptions(chatUi.titleEffort, efforts.length ? efforts.map(id => ({ id, label: id === 'xhigh' ? 'Extra high' : id[0].toUpperCase() + id.slice(1) })) : [{ id: '', label: 'Default' }], efforts.includes(selected) ? selected : (efforts.includes('minimal') ? 'minimal' : efforts[0] || ''));
  chatSettings.titleEffort = chatUi.titleEffort.value;
}
function loadTitleModels(providers = []) {
  titleModels = providers.flatMap(provider => (provider.models || []).map(model => ({ ...model, provider: provider.id, providerLabel: provider.label })));
  const selected = titleModels.find(model => model.provider === chatSettings.titleProvider && model.id === chatSettings.titleModel) || titleModelDefault();
  if (selected) { chatSettings.titleProvider = selected.provider; chatSettings.titleModel = selected.id; }
  setOptions(chatUi.titleModel, titleModels.length ? titleModels.map(model => ({ id: titleModelKey(model), label: `${model.providerLabel} · ${model.label}` })) : [{ id: '', label: 'No configured model' }], selected ? titleModelKey(selected) : '');
  loadTitleEfforts(chatSettings.titleEffort);
  persistChatSettings();
}
function setProviderLoginState(providers) {
  for (const { id, label, button } of [
    { id: 'openai-codex', label: 'Codex', button: chatUi.codexLogin },
    { id: 'github-copilot', label: 'Copilot', button: chatUi.copilotLogin },
  ]) {
    const connected = providers.some(provider => provider.id === id);
    button.querySelector('span').textContent = connected ? `${label} connected` : `Sign in to ${label}`;
    button.disabled = connected;
    button.title = connected ? `This browser has its own ${label} sign-in.` : `Sign in to ${label} for this browser.`;
    if (connected && chatUi.authCode.dataset.provider === id) chatUi.authCode.hidden = true;
  }
}
function showAuthenticationCode(provider, label, code) {
  chatUi.authCode.dataset.provider = provider;
  chatUi.authCode.textContent = `${label} verification code: ${code}`;
  chatUi.authCode.hidden = false;
  chatUi.authDialogCode.textContent = code;
  if (!chatUi.authDialog.open) chatUi.authDialog.showModal();
}
function renderChatMarkdown(element, content, sourcePath) {
  // renderMarkdown escapes source text before creating markup; chat replies do
  // not accept raw HTML from a model.
  element.classList.add('chat-markdown');
  element.innerHTML = renderMarkdown(content, sourcePath);
  void renderMermaidDiagrams(element).then(() => scrollChatToLatest());
}
function renderAssistantMarkdown(element, content) { renderChatMarkdown(element, content, '/workspace/index.md'); }
function renderUserMarkdown(element, content) {
  const sourcePath = !chatProjectId || chatProjectId === 'workspace' ? '/workspace/index.md' : `/workspace/${encodeURIComponent(chatProjectId)}/index.md`;
  renderChatMarkdown(element, content, sourcePath);
}
function scrollChatToLatest({ force = false } = {}) {
  if (!force && !chatFollowsActivity) return;
  if (force) chatFollowsActivity = true;
  if (chatScrollFrame) cancelAnimationFrame(chatScrollFrame);
  chatScrollFrame = requestAnimationFrame(() => {
    chatScrollFrame = null;
    if (force || chatFollowsActivity) chatUi.messages.scrollTop = chatUi.messages.scrollHeight;
  });
}
function messageHeader(role, error, createdAt, { model = '', effort = '', initiator = 'user', steering = false } = {}) {
  const header = document.createElement('header'); header.className = 'chat-message-header';
  const meta = document.createElement('span'); meta.className = 'message-meta'; meta.textContent = role === 'user' ? (initiator === 'system' ? 'System' : steering ? 'You · Steering' : 'You') : error ? 'Error' : `${model || 'Model unavailable'} · ${effort || 'Default effort'}`;
  const timestamp = document.createElement('time'); timestamp.className = 'message-time'; timestamp.dateTime = createdAt || ''; timestamp.textContent = formatThreadTime(createdAt);
  header.append(meta, timestamp); return header;
}
function renderChatMessages(messages = [], threadSettings = {}) {
  chatUi.messages.replaceChildren();
  if (!messages.length) { const empty = document.createElement('p'); empty.className = 'chat-empty'; empty.textContent = 'Start a project-scoped conversation. Files are available only when the agent requests them.'; chatUi.messages.append(empty); }
  for (const message of messages) {
    const node = document.createElement('article'); node.className = `chat-message ${message.role === 'user' ? 'user' : message.error ? 'error' : 'assistant'}`;
    const content = document.createElement('div');
    if (!message.error && message.role === 'assistant') renderAssistantMarkdown(content, message.content || '');
    else if (!message.error && message.role === 'user') renderUserMarkdown(content, message.content || '');
    else content.textContent = message.content || '';
    if (message.turnId) node.dataset.turnId = message.turnId;
    node.append(messageHeader(message.role, message.error, message.createdAt, { model: message.model || threadSettings.model, effort: message.effort || threadSettings.effort, initiator: message.initiator, steering: message.steering }), content); chatUi.messages.append(node);
  }
  for (const turn of activeTurnsFor(chatProjectId, chatThreadId)) if (!turn.id || !chatUi.messages.querySelector(`[data-turn-id="${turn.id}"]`)) renderActiveTurn(turn);
  scrollChatToLatest({ force: true });
}
function addChatMessage(role, content, error = false, createdAt = new Date().toISOString(), settings = {}) { const existing = [...chatUi.messages.querySelectorAll('.chat-empty')]; existing.forEach(node => node.remove()); const node = document.createElement('article'); node.className = `chat-message ${role === 'user' ? 'user' : error ? 'error' : 'assistant'}`; node.dataset.streamMessage = role === 'assistant' && !error ? 'true' : ''; if (settings.turnId) node.dataset.turnId = settings.turnId; if (settings.clientTurnId) node.dataset.clientTurnId = settings.clientTurnId; const body = document.createElement('div'); body.className = 'chat-message-body'; if (!error && role === 'assistant') renderAssistantMarkdown(body, content); else if (!error && role === 'user') renderUserMarkdown(body, content); else body.textContent = content; node.append(messageHeader(role, error, createdAt, settings), body); chatUi.messages.append(node); scrollChatToLatest({ force: true }); return body; }

function renderFailedChatTurn(turn) {
  const node = chatUi.messages.querySelector(`[data-client-turn-id="${turn.clientId}"]`);
  if (!node) { addChatMessage('assistant', turn.error || 'Turn failed.', true, new Date().toISOString(), { turnId: turn.id, model: turn.model, effort: turn.effort }); return; }
  node.className = 'chat-message error'; node.removeAttribute('data-stream-message');
  node.querySelector('.message-meta').textContent = 'Error';
  const body = node.querySelector('.chat-message-body'); body.textContent = turn.error || 'Turn failed.';
  node.querySelectorAll('.chat-turn-status, .chat-turn-activity, .chat-turn-thinking').forEach(item => item.remove());
  scrollChatToLatest({ force: true });
}

function turnStatusText(turn) {
  const elapsed = Math.floor((Date.now() - turn.startedAt) / 1000); const quiet = Math.floor((Date.now() - turn.lastEventAt) / 1000);
  const clock = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const state = turn.lastActivityLabel || 'Working';
  return `${quiet > 20 ? 'Still working — processing previous results' : state} · ${clock(elapsed)} · last activity ${clock(quiet)} ago`;
}
function cancelSpecificChatTurn(turn) {
  if (turn.id) void chatApi(`/api/chat/threads/${encodeURIComponent(turn.threadId)}/turns/${encodeURIComponent(turn.id)}`, { method: 'DELETE' }).catch(() => {});
  turn.abort.abort();
}
function renderTurnStatusLine(turn, node = chatUi.messages.querySelector(`[data-client-turn-id="${turn.clientId}"]`)) {
  if (!node) return;
  let status = node.querySelector('.chat-turn-status');
  if (!status) { status = document.createElement('p'); status.className = 'chat-turn-status'; node.append(status); }
  status.replaceChildren(); const text = document.createElement('span'); text.className = 'chat-turn-status-text'; text.textContent = turn.status === 'failed' ? (turn.error || 'Turn failed') : turn.status === 'cancelled' ? 'Stopped.' : turn.status === 'completed' ? 'Completed.' : turnStatusText(turn); status.append(text);
  if (turn.status === 'working') {
    const controls = document.createElement('span'); controls.className = 'chat-turn-controls';
    const toggle = document.createElement('label'); toggle.className = 'chat-thinking-toggle'; const input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(chatSettings.showThinking); input.addEventListener('change', () => setShowThinking(input.checked)); toggle.append(input, ' Show thinking'); controls.append(toggle);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'chat-turn-cancel'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', () => cancelSpecificChatTurn(turn)); controls.append(cancel);
    status.append(controls);
  }
  node.append(status);
}
function renderActiveTurn(turn) {
  if (chatProjectId !== turn.projectId || chatThreadId !== turn.threadId) return;
  let node = chatUi.messages.querySelector(`[data-client-turn-id="${turn.clientId}"]`);
  if (!node) {
    addChatMessage('assistant', '', false, new Date(turn.startedAt).toISOString(), { model: turn.model, effort: turn.effort, clientTurnId: turn.clientId, turnId: turn.id || '' });
    node = chatUi.messages.querySelector(`[data-client-turn-id="${turn.clientId}"]`);
  }
  if (turn.id) node.dataset.turnId = turn.id;
  const body = node.querySelector('.chat-message-body'); renderAssistantMarkdown(body, turn.assistantText || (turn.status === 'completed' ? 'No response returned.' : ''));
  node.querySelectorAll('.chat-turn-activity, .chat-turn-thinking').forEach(item => item.remove());
  if (chatSettings.showThinking && turn.thinkingText) { const thinking = document.createElement('p'); thinking.className = 'chat-turn-thinking'; thinking.textContent = turn.thinkingText; node.append(thinking); }
  for (const activity of turn.activities) { const item = document.createElement('p'); item.className = 'chat-tool-activity chat-turn-activity'; if (activity.kind !== 'tool') item.textContent = activity.label; else { const tool = document.createElement('span'); tool.className = 'chat-tool-lozenge'; tool.textContent = activity.tool; item.append(tool); for (const target of activity.targets || []) { const value = document.createElement('code'); value.className = 'chat-tool-target'; value.textContent = target; item.append(value); } if (activity.failed) { const outcome = document.createElement('span'); outcome.className = 'chat-tool-outcome'; outcome.textContent = 'failed'; item.append(outcome); } else if (!activity.done) { const outcome = document.createElement('span'); outcome.className = 'chat-tool-outcome'; outcome.textContent = 'running'; item.append(outcome); } } node.append(item); }
  renderTurnStatusLine(turn, node); scrollChatToLatest();
}

async function loadChatStatus() {
  try {
    const response = await chatApi('/api/chat/status'); if (!response.ok) throw new Error('Chat unavailable');
    const data = await response.json(); const providers = data.providers || []; configuredApiKeys = data.apiKeys || []; if (chatUi.settingsDialog.open) renderApiKeyRows();
    setProviderLoginState(providers);
    loadTitleModels(providers);
    const preference = projectChatPreference();
    setOptions(chatUi.provider, providers, providers.some(item => item.id === preference.provider) ? preference.provider : (chatUi.provider.value || data.defaultProvider));
    await loadChatModels();
    const providerAvailable = providers.some(provider => provider.models?.length);
    setChatStatus(providerAvailable ? 'Ready' : (data.message || 'Configure a provider'));
    if (!setupPrompted && !providerAvailable) { setupPrompted = true; openChatSettings(); }
  } catch { setProviderLoginState([]); setOptions(chatUi.provider, [{ id: 'anthropic', label: 'Anthropic (not configured)' }], 'anthropic'); chatModels = []; setOptions(chatUi.model, [{ id: '', label: 'No model available' }], ''); loadChatEfforts(''); loadTitleModels([]); setChatStatus('Chat service unavailable'); }
}
async function loadChatModels() {
  const provider = chatUi.provider.value; if (!provider) return;
  try { const response = await chatApi(`/api/chat/status?provider=${encodeURIComponent(provider)}`); const data = await response.json(); chatModels = data.models || []; const preference = projectChatPreference(); setOptions(chatUi.model, chatModels.length ? chatModels : [{ id: '', label: 'No configured model' }], chatModels.some(item => item.id === preference.model) ? preference.model : (chatUi.model.value || data.defaultModel)); loadChatEfforts(preference.effort); } catch { chatModels = []; setOptions(chatUi.model, [{ id: '', label: 'No model available' }], ''); loadChatEfforts(''); }
}
async function signInToProvider(provider) {
  const copilot = provider === 'github-copilot'; const label = copilot ? 'Copilot' : 'Codex'; const button = copilot ? chatUi.copilotLogin : chatUi.codexLogin;
  closeChatSettings();
  const loginWindow = window.open('', `ok-workbench-${provider}-login`, 'popup,width=680,height=760');
  button.disabled = true; setChatStatus(`Preparing ${label} sign-in…`);
  try {
    const response = await chatApi(`/api/chat/auth/${provider}/start`, { method: 'POST' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || `Could not start ${label} sign-in`);
    if (loginWindow) loginWindow.location.href = data.url;
    else window.location.assign(data.url);
    if (data.user_code) showAuthenticationCode(provider, label, data.user_code);
    setChatStatus(data.user_code ? `Enter the ${label} verification code shown above at GitHub.` : `Complete the ${label} sign-in in the browser window, then return here.`);
    const deadline = Date.now() + 120_000;
    const poll = async () => {
      await loadChatStatus();
      if ([...chatUi.provider.options].some(option => option.value === provider)) { setChatStatus(`${label} is ready.`); return; }
      if (Date.now() < deadline) setTimeout(() => { void poll(); }, 1_500);
    };
    void poll();
  } catch (error) { loginWindow?.close(); setChatStatus(error.message || `${label} sign-in failed`); }
  finally { button.disabled = false; }
}
function formatThreadTime(value) {
  const date = new Date(value); if (Number.isNaN(date.valueOf())) return '';
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${date.getDate()} ${month}${date.getFullYear() === new Date().getFullYear() ? '' : ` ${date.getFullYear()}`}, ${time}`;
}
function updateNewThreadAvailability() { chatUi.newThread.disabled = !chatThreadHasUserChat || Boolean(creatingChatThread); }
function renderThreadSelect() { setOptions(chatUi.thread, chatThreads.map(thread => { const title = thread.title || 'New conversation'; return { id: thread.id, label: title === 'New conversation' ? title : `${title} · ${formatThreadTime(thread.updatedAt || thread.createdAt)}` }; }), chatThreadId); }
async function loadChatThread(threadId) {
  if (!threadId) { chatThreadHasUserChat = false; updateNewThreadAvailability(); renderChatMessages([]); return; }
  const response = await chatApi(`/api/chat/threads/${encodeURIComponent(threadId)}`); if (!response.ok) throw new Error('Could not load chat thread');
  const data = await response.json(); chatThreadId = data.id; chatThreadHasUserChat = (data.messages || []).some(message => message.role === 'user' && message.initiator !== 'system'); updateNewThreadAvailability(); renderChatMessages(data.messages || [], data); syncChatTurnControls();
}
async function createChatThread({ force = false } = {}) {
  if (creatingChatThread) return creatingChatThread;
  if (workspaceModeRequired()) throw new Error('Enable workspace-wide mode before starting a workspace chat.');
  if (!force && chatThreadId && !chatThreadHasUserChat) return chatThreads.find(thread => thread.id === chatThreadId) || null;
  creatingChatThread = (async () => {
    const response = await chatApi('/api/chat/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: chatProjectId, workspaceMode, provider: chatUi.provider.value, model: chatUi.model.value, effort: chatUi.effort.value, titleProvider: chatSettings.titleProvider, titleModel: chatSettings.titleModel, titleEffort: chatSettings.titleEffort }) });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not create chat thread');
    const thread = await response.json(); chatThreads.unshift(thread); chatThreadId = thread.id; chatThreadHasUserChat = false; renderThreadSelect(); renderChatMessages([]); updateNewThreadAvailability(); syncChatTurnControls(); return thread;
  })();
  updateNewThreadAvailability();
  try { return await creatingChatThread; } finally { creatingChatThread = null; updateNewThreadAvailability(); }
}
async function loadChatThreads() {
  if (!chatProjectId) return;
  if (workspaceModeRequired()) {
    chatThreads = []; chatThreadId = null; chatThreadHasUserChat = false; renderThreadSelect(); renderChatMessages([]); updateNewThreadAvailability(); setChatStatus('Workspace browsing is read-only for the agent. Send a message to explicitly enable workspace-wide mode.'); return;
  }
  try { const response = await chatApi(`/api/chat/threads?project=${encodeURIComponent(chatProjectId)}`); if (!response.ok) throw new Error('Could not list chat threads'); const loadedThreads = await response.json(); let emptyConversationSeen = false; chatThreads = loadedThreads.filter(thread => { if (thread.title !== 'New conversation') return true; if (emptyConversationSeen) return false; emptyConversationSeen = true; return true; }); const requestedNotification = pendingChatThread?.projectId === chatProjectId ? pendingChatThread : null; const requested = requestedNotification?.threadId; if (requested && chatThreads.some(thread => thread.id === requested)) chatThreadId = requested; else if (!chatThreadId || !chatThreads.some(thread => thread.id === chatThreadId)) chatThreadId = chatThreads[0]?.id || null; if (requested) pendingChatThread = null; if (!chatThreadId) await createChatThread({ force: true }); else { renderThreadSelect(); await loadChatThread(chatThreadId); if (requestedNotification && focusTurnNotification(requestedNotification)) { dismissTurnNotification(requestedNotification.id); closeTurnNotifications(); } } } catch (error) { renderChatMessages([{ role: 'assistant', content: error.message, error: true }]); }
}
async function refreshGitStatus() {
  if (!chatProjectId) return;
  try { const response = await chatApi(`/api/projects/${encodeURIComponent(chatProjectId)}/git/status`); if (!response.ok) throw new Error(); const status = await response.json(); chatUi.changeCount.textContent = String(status.changedFiles || 0); } catch { chatUi.changeCount.textContent = '–'; }
  finally { void refreshDirtyStatus(); }
}
async function chatProjectChanged(project) {
  if (!project?.name || project.name === chatProjectId) return;
  chatProjectId = project.name; chatProjectTitle = project.title || project.name; workspaceMode = false; chatThreadId = null; chatThreadHasUserChat = false; updateNewThreadAvailability(); renderChatProjectLabel(); setChatStatus('Loading project chat…');
  renderDirtyProcessPrompt();
  chatUi.messages.replaceChildren(); const loading = document.createElement('p'); loading.className = 'chat-empty loading'; loading.textContent = 'Loading chat history…'; chatUi.messages.append(loading);
  chatUi.input.disabled = true; chatUi.send.disabled = true;
  try { await Promise.all([loadChatStatus(), loadChatThreads(), refreshGitStatus()]); }
  finally {
    chatUi.input.disabled = false;
    syncChatTurnControls();
    if (currentChatTurn()) setChatStatus('Thinking…');
  }
}
async function cancelChatTurn() {
  const turn = currentChatTurn();
  if (!turn) return;
  cancelSpecificChatTurn(turn);
}
async function steerChatTurn(turn, message) {
  if (!turn?.id || !turn.supportsSteering || !turn.steeringReady || turn.steeringSubmitting) throw new Error('Steering is not available for this response yet');
  turn.steeringSubmitting = true; syncChatTurnControls(); setChatStatus('Sending steering comment…');
  try {
    const response = await chatApi(`/api/chat/threads/${encodeURIComponent(turn.threadId)}/turns/${encodeURIComponent(turn.id)}/steer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not steer the active response');
    const assistant = chatUi.messages.querySelector(`[data-client-turn-id="${turn.clientId}"]`); addChatMessage('user', message, false, new Date().toISOString(), { steering: true }); if (assistant) chatUi.messages.append(assistant);
    turn.activities.push({ kind: 'steering', label: 'Steering comment accepted', at: Date.now(), done: true }); renderActiveTurn(turn); setChatStatus('Steering accepted');
  } finally { turn.steeringSubmitting = false; syncChatTurnControls(); }
}
async function enableWorkspaceMode(initiator) {
  if (!workspaceModeRequired()) return true;
  if (initiator !== 'user' || !confirm('Enable workspace-wide mode? The agent will be able to read and write every project in this workspace for this chat.')) { setChatStatus('Workspace-wide mode was not enabled.'); return false; }
  workspaceMode = true; renderChatProjectLabel(); chatThreadId = null; chatThreadHasUserChat = false; chatThreads = [];
  await loadChatThreads();
  return true;
}
async function streamChatTurn(message, { model = chatUi.model.value, initiator = 'user' } = {}) {
  if (currentChatTurn()) { setChatStatus('Cancel or steer the active response first.'); return false; }
  if (!(await enableWorkspaceMode(initiator))) return false;
  saveProjectChatPreference();
  if (!chatThreadId) await createChatThread({ force: true });
  const selectedModel = chatModels.find(item => item.id === model);
  const turn = { abort: new AbortController(), id: null, clientId: crypto.randomUUID(), projectId: chatProjectId, projectTitle: chatUi.project.textContent || chatProjectId, threadId: chatThreadId, unread: false, promptPreview: message.slice(0, 120), model, effort: chatUi.effort.value, initiator, supportsSteering: selectedModel?.supportsSteering === true, steeringReady: false, steeringSubmitting: false, status: 'working', startedAt: Date.now(), lastEventAt: Date.now(), lastActivityLabel: 'Working', assistantText: '', thinkingText: '', activities: [], error: null };
  activeChatTurns.add(turn); syncChatTurnControls(); setChatStatus('Thinking…');
  const isVisible = () => activeChatTurns.has(turn) && chatProjectId === turn.projectId && chatThreadId === turn.threadId;
  if (isVisible()) renderActiveTurn(turn); let projectCreated = false; let completed = false;
  try {
    const requestTurn = () => fetch(`/api/chat/threads/${encodeURIComponent(turn.threadId)}/turns`, { method: 'POST', signal: turn.abort.signal, headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', 'x-ok-workbench-csrf': chatCsrf }, body: JSON.stringify({ message, initiator, provider: chatUi.provider.value, model, effort: chatUi.effort.value, titleProvider: chatSettings.titleProvider, titleModel: chatSettings.titleModel, titleEffort: chatSettings.titleEffort }) });
    let response = await requestTurn();
    if (await invalidChatToken(response)) { await refreshChatCsrf(); response = await requestTurn(); }
    if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error || 'Could not start chat turn');
    if (initiator !== 'system') { chatThreadHasUserChat = true; updateNewThreadAvailability(); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffered = '';
    for (;;) { const { value, done } = await reader.read(); if (done) break; buffered += decoder.decode(value, { stream: true }); const lines = buffered.split('\n'); buffered = lines.pop(); for (const line of lines) { if (!line) continue; const event = JSON.parse(line); turn.lastEventAt = Date.now(); if (event.type === 'turn.started') { turn.id = event.turn_id || null; turn.supportsSteering = event.supports_steering === true; syncChatTurnControls(); }
      else if (event.type === 'turn.steering') { turn.steeringReady = event.available === true; syncChatTurnControls(); }
      else if (event.type === 'message.delta') { turn.assistantText += event.delta || ''; turn.thinkingText = ''; turn.lastActivityLabel = 'Writing response'; if (currentChatCollapsed() && !turn.unread) { turn.unread = true; chatUnread++; applyChatLayout(); } }
      else if (event.type === 'turn.thinking') { turn.thinkingText += event.delta || ''; turn.lastActivityLabel = 'Model is thinking'; }
      else if (event.type === 'tool.started') { turn.activities.push({ kind: 'tool', tool: event.tool || 'workspace_tool', targets: Array.isArray(event.targets) ? event.targets : [], at: Date.now(), done: false }); turn.lastActivityLabel = event.tool || 'Running tool'; }
      else if (event.type === 'tool.completed' || event.type === 'tool.failed') { if (event.tool === 'create_project' && event.result?.location) projectCreated = true; const activity = [...turn.activities].reverse().find(item => !item.done && item.kind === 'tool'); if (activity) { activity.done = true; activity.tool = event.tool || activity.tool; activity.targets = Array.isArray(event.targets) ? event.targets : activity.targets; activity.failed = event.type === 'tool.failed'; } else turn.activities.push({ kind: 'tool', tool: event.tool || 'workspace_tool', targets: Array.isArray(event.targets) ? event.targets : [], at: Date.now(), done: true, failed: event.type === 'tool.failed' }); turn.lastActivityLabel = event.tool || 'Workspace tool'; }
      else if (event.type === 'scope.granted') turn.activities.push({ kind: 'scope', label: `Attached ${event.grants?.map(grant => `@${grant.project}/${grant.path}`).join(', ') || 'project context'}`, at: Date.now(), done: true });
      else if (event.type === 'turn.status') turn.lastActivityLabel = ({ thinking: 'Model is thinking', retrying: 'Provider busy — retrying', responding: 'Writing response' })[event.state] || 'Working';
      else if (event.type === 'turn.failed') throw new Error(event.error || 'Turn failed'); else if (event.type === 'workspace.changed') { if (event.project === chatProjectId) refreshGitStatus(); reloadChangedDocument(event); } else if (event.type === 'usage.updated' && isVisible()) setChatStatus(event.usage || 'Working…');
      if (isVisible()) renderActiveTurn(turn); }
    }
    completed = true;
    turn.status = 'completed'; turn.thinkingText = ''; turn.completedAt = Date.now(); if (isVisible()) renderActiveTurn(turn);
    if (isVisible()) { setChatStatus('Ready'); if (projectCreated) await loadPage(); else await loadChatThreads(); }
  } catch (error) { turn.status = error.name === 'AbortError' ? 'cancelled' : 'failed'; turn.error = error.name === 'AbortError' ? 'Stopped.' : error.message; if (isVisible()) { if (turn.status === 'failed') renderFailedChatTurn(turn); else renderActiveTurn(turn); setChatStatus(error.name === 'AbortError' ? 'Stopped' : 'Error'); } }
  finally { const visible = isVisible(); activeChatTurns.delete(turn); recentTurns.set(turn.clientId, turn); while (recentTurns.size > 20) recentTurns.delete(recentTurns.keys().next().value); if (completed && !visible) addTurnNotification(turn); if (visible) { syncChatTurnControls(); if (completed) { setChatStatus('Ready'); void refreshDirtyStatus(); } } }
  return completed;
}
setInterval(() => { for (const turn of activeTurnsFor()) renderTurnStatusLine(turn); }, 1_000);
async function loadDiff() {
  if (!chatProjectId) return; chatUi.diffFiles.textContent = 'Loading…'; chatUi.diffFileTitle.textContent = ''; chatUi.diffContent.textContent = 'Loading file changes…'; chatUi.diffSummary.textContent = '';
  try { const response = await chatApi(`/api/projects/${encodeURIComponent(chatProjectId)}/git/diff?source=${encodeURIComponent(diffSource)}`); if (!response.ok) throw new Error((await response.json()).error || 'Could not load diff'); diffData = await response.json(); const selectedPath = diffFiles[selectedDiffFile]?.path; diffFiles = splitDiffFiles(diffData.patch); selectedDiffFile = Math.max(0, diffFiles.findIndex(file => file.path === selectedPath)); const latestCommit = diffSource === 'commits' && diffData.commit?.hash ? ` · ${formatThreadTime(diffData.commit.timestamp)} · ${diffData.commit.hash}` : ''; chatUi.diffSummary.textContent = diffFiles.length ? `${diffFiles.length} changed file${diffFiles.length === 1 ? '' : 's'}${latestCommit}` : (diffData.summary || 'No changes'); renderDiffFiles(); renderDiffPatch(diffFiles[selectedDiffFile]?.patch || ''); chatUi.diffRevert.hidden = diffSource !== 'unstaged' || !diffData.patch; chatUi.diffUnstage.hidden = diffSource !== 'staged' || !diffData.patch; } catch (error) { chatUi.diffFiles.textContent = ''; chatUi.diffFileTitle.textContent = ''; chatUi.diffContent.textContent = error.message; }
}
async function applyDiffAction(action) {
  if (!diffData?.token) return;
  if (!confirm(action === 'unstage' ? 'Unstage the displayed changes?' : 'Revert the displayed unstaged changes?')) return;
  const response = await chatApi(`/api/projects/${encodeURIComponent(chatProjectId)}/git/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: diffData.token }) });
  if (!response.ok) { const data = await response.json().catch(() => ({})); alert(data.error || 'Git operation failed'); return; }
  const result = await response.json(); diffRecoveryOperation = result.operationId || null; chatUi.diffUndo.hidden = !diffRecoveryOperation; await Promise.all([loadDiff(), refreshGitStatus()]);
}
async function undoDiffAction() {
  if (!diffRecoveryOperation) return;
  const response = await chatApi(`/api/projects/${encodeURIComponent(chatProjectId)}/git/revert/${encodeURIComponent(diffRecoveryOperation)}/undo`, { method: 'POST' });
  if (!response.ok) { const data = await response.json().catch(() => ({})); alert(data.error || 'Undo failed'); return; }
  diffRecoveryOperation = null; chatUi.diffUndo.hidden = true; await Promise.all([loadDiff(), refreshGitStatus()]);
}
function diffFilePath(value) { return value.replace(/^"?\/?(?:a|b)\//, '').replace(/"$/, ''); }
function splitDiffFiles(patch) {
  return patch.split(/(?=^diff --git )/m).filter(section => section.startsWith('diff --git ')).map(section => {
    const lines = section.split('\n'); const after = lines.find(line => line.startsWith('+++ '))?.slice(4); const before = lines.find(line => line.startsWith('--- '))?.slice(4);
    const path = diffFilePath((after && after !== '/dev/null' ? after : before) || lines[0].replace(/^diff --git a\/(.*?) b\/.*$/, '$1'));
    const additions = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length; const deletions = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;
    const content = lines.filter(line => !/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (?:from|to) )/.test(line)).join('\n').trim();
    return { path, additions, deletions, patch: content || 'Binary file changed.' };
  });
}
function renderDiffFiles() {
  chatUi.diffFiles.replaceChildren();
  if (!diffFiles.length) { chatUi.diffFiles.textContent = 'No changed files.'; return; }
  for (const [index, file] of diffFiles.entries()) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `diff-file${index === selectedDiffFile ? ' active' : ''}`; button.dataset.diffFile = String(index); button.setAttribute('aria-current', index === selectedDiffFile ? 'true' : 'false');
    const name = document.createElement('span'); name.className = 'diff-file-name'; name.textContent = file.path;
    const stats = document.createElement('span'); stats.className = 'diff-file-stats';
    if (file.additions) { const added = document.createElement('span'); added.className = `diff-file-stat added${chatSettings.diffPalette === 'blue' ? ' blue' : ''}`; added.textContent = `+${file.additions}`; stats.append(added); }
    if (file.deletions) { const deleted = document.createElement('span'); deleted.className = 'diff-file-stat deleted'; deleted.textContent = `−${file.deletions}`; stats.append(deleted); }
    button.append(name, stats); chatUi.diffFiles.append(button);
  }
}
function selectDiffFile(index) {
  if (!Number.isInteger(index) || !diffFiles[index]) return;
  selectedDiffFile = index; renderDiffFiles(); renderDiffPatch(diffFiles[index].patch);
}
function renderDiffPatch(patch) {
  chatUi.diffContent.replaceChildren();
  const file = diffFiles[selectedDiffFile]; chatUi.diffFileTitle.textContent = file?.path || '';
  if (!patch) { chatUi.diffContent.textContent = 'Select a changed file to inspect it.'; return; }
  if (chatSettings.diffLayout === 'inline') { const pre = document.createElement('pre'); pre.className = 'diff-inline'; pre.textContent = patch; chatUi.diffContent.append(pre); return; }
  for (const line of patch.split('\n')) {
    const row = document.createElement('div'); row.className = 'diff-row';
    const cell = (text, className = '') => { const node = document.createElement('div'); node.className = `diff-cell ${className}`; node.textContent = text; return node; };
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@')) row.append(cell(line, 'meta'));
    else if (line.startsWith('-')) { row.append(cell(`− ${line.slice(1)}`, 'deleted'), cell('', '')); }
    else if (line.startsWith('+')) { row.append(cell('', ''), cell(`+ ${line.slice(1)}`, `added ${chatSettings.diffPalette === 'blue' ? 'blue' : ''}`)); }
    else row.append(cell(line, 'context'), cell(line, 'context'));
    chatUi.diffContent.append(row);
  }
}

chatUi.toggle.addEventListener('click', () => setChatCollapsed(!currentChatCollapsed()));
chatUi.collapse.addEventListener('click', () => setChatCollapsed(true));
chatUi.restore.addEventListener('click', () => setChatCollapsed(false));
chatUi.messages.addEventListener('scroll', () => {
  const remaining = chatUi.messages.scrollHeight - chatUi.messages.scrollTop - chatUi.messages.clientHeight;
  chatFollowsActivity = remaining < 24;
});
chatUi.provider.addEventListener('change', () => loadChatModels().then(saveProjectChatPreference));
chatUi.model.addEventListener('change', () => { loadChatEfforts(projectChatPreference().effort); saveProjectChatPreference(); });
chatUi.effort.addEventListener('change', saveProjectChatPreference);
chatUi.settings.addEventListener('click', toggleChatSettings);
chatUi.settingsClose.addEventListener('click', closeChatSettings);
chatUi.settingsForm.addEventListener('submit', event => event.preventDefault());
chatUi.settingsDialog.addEventListener('close', () => chatUi.settings.setAttribute('aria-expanded', 'false'));
chatUi.runtimeSave.addEventListener('click', () => { void saveRuntimeSettings(); });
chatUi.apiKeyAdd.addEventListener('click', () => {
  const used = new Set([...configuredApiKeys.map(record => record.provider), ...[...chatUi.apiKeys.querySelectorAll('select')].map(select => select.value)]);
  const available = apiKeyProviderOptions.find(option => !used.has(option.id)); if (!available) return;
  const empty = chatUi.apiKeys.querySelector('.chat-api-keys-empty'); empty?.remove();
  const row = apiKeyRow(null, available.id); chatUi.apiKeys.append(row); row.querySelector('input').focus();
  chatUi.apiKeyAdd.disabled = apiKeyProviderOptions.every(option => used.has(option.id) || option.id === available.id);
});
chatUi.toolSecretAdd.addEventListener('click', async () => {
  const name = prompt('Logical tool secret name (for example jira-token):'); if (!name) return;
  const value = prompt(`Value for ${name}:`); if (!value) return;
  try { const response = await chatApi(`/api/chat/tool-secrets/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }); if (!response.ok) throw new Error((await response.json()).error || 'Could not save tool secret'); await loadWorkspaceTools(); }
  catch (error) { showSettingsError(error.message); }
});
document.addEventListener('click', event => { if (!event.target.closest('.turn-notifications')) closeTurnNotifications(); });
chatUi.titleModel.addEventListener('change', () => { const model = titleModels.find(item => titleModelKey(item) === chatUi.titleModel.value); if (!model) return; chatSettings.titleProvider = model.provider; chatSettings.titleModel = model.id; loadTitleEfforts(chatSettings.titleEffort); persistChatSettings(); });
chatUi.titleEffort.addEventListener('change', () => { chatSettings.titleEffort = chatUi.titleEffort.value; persistChatSettings(); });
chatUi.codexLogin.addEventListener('click', () => signInToProvider('openai-codex'));
chatUi.copilotLogin.addEventListener('click', () => signInToProvider('github-copilot'));
chatUi.newThread.addEventListener('click', () => createChatThread().catch(error => setChatStatus(error.message)));
chatUi.thread.addEventListener('change', () => loadChatThread(chatUi.thread.value).catch(error => setChatStatus(error.message)));
chatUi.composer.addEventListener('submit', event => {
  event.preventDefault(); const message = chatUi.input.value.trim(); if (!message) return; const turn = currentChatTurn();
  if (turn) { if (!turn.supportsSteering || !turn.steeringReady) { setChatStatus('Cancel the active response before sending another comment.'); return; } chatUi.input.value = ''; void steerChatTurn(turn, message).catch(error => { if (!chatUi.input.value) chatUi.input.value = message; setChatStatus(error.message); }); return; }
  if (workspaceModeRequired()) { void (async () => { if (!(await enableWorkspaceMode('user'))) return; chatUi.input.value = ''; addChatMessage('user', message); await streamChatTurn(message); })(); return; }
  chatUi.input.value = ''; addChatMessage('user', message); void streamChatTurn(message);
});
chatUi.input.addEventListener('keydown', event => { if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return; event.preventDefault(); chatUi.composer.requestSubmit(); });
chatUi.processDirty.addEventListener('click', () => { processDirtyChanges().catch(error => setChatStatus(error.message || 'Could not process project changes')); });
chatUi.stop.addEventListener('click', () => cancelChatTurn());
chatUi.notificationsButton.addEventListener('click', toggleTurnNotifications);
chatUi.notificationsList.addEventListener('click', event => { const dismiss = event.target.closest('[data-dismiss-turn-notification]'); if (dismiss) { dismissTurnNotification(dismiss.dataset.dismissTurnNotification); return; } const button = event.target.closest('[data-turn-notification]'); if (button) openTurnNotification(button.dataset.turnNotification).catch(error => setChatStatus(error.message)); });
chatUi.changes.addEventListener('click', () => { chatUi.changesDialog.showModal(); loadDiff(); });
chatUi.diffTabs.addEventListener('click', event => { const tab = event.target.closest('[data-diff-source]'); if (!tab) return; diffSource = tab.dataset.diffSource; for (const button of chatUi.diffTabs.querySelectorAll('button')) button.setAttribute('aria-selected', String(button === tab)); loadDiff(); });
chatUi.diffFiles.addEventListener('click', event => selectDiffFile(Number(event.target.closest('[data-diff-file]')?.dataset.diffFile)));
chatUi.diffLayout.addEventListener('click', () => { chatSettings.diffLayout = chatSettings.diffLayout === 'side-by-side' ? 'inline' : 'side-by-side'; chatUi.diffLayout.textContent = chatSettings.diffLayout === 'side-by-side' ? 'Side by side' : 'Inline'; persistChatSettings(); if (diffData) renderDiffPatch(diffFiles[selectedDiffFile]?.patch || ''); });
chatUi.diffPalette.addEventListener('click', () => { chatSettings.diffPalette = chatSettings.diffPalette === 'green' ? 'blue' : 'green'; chatUi.diffPalette.textContent = chatSettings.diffPalette === 'green' ? 'Red / green' : 'Red / blue'; document.documentElement.dataset.diffPalette = chatSettings.diffPalette; persistChatSettings(); renderDiffFiles(); if (diffData) renderDiffPatch(diffFiles[selectedDiffFile]?.patch || ''); });
chatUi.diffRevert.addEventListener('click', () => applyDiffAction('revert'));
chatUi.diffUnstage.addEventListener('click', () => applyDiffAction('unstage'));
chatUi.diffUndo.addEventListener('click', undoDiffAction);

let resizeState = null;
chatUi.splitter.addEventListener('pointerdown', event => { if (innerWidth <= 900) return; resizeState = { coordinate: event.clientX }; chatUi.splitter.setPointerCapture(event.pointerId); event.preventDefault(); });
chatUi.splitter.addEventListener('pointermove', event => {
  if (!resizeState) return;
  // On the right dock, derive the width from the viewport-anchored splitter
  // position. This makes the draggable range explicit: it cannot cross the
  // 240px file sidebar plus 320px document minimum, or shrink below 320px.
  const size = innerWidth - event.clientX - 8;
  const value = clampChatSize(size);
  chatSettings.rightSize = value;
  applyChatLayout();
});
chatUi.splitter.addEventListener('pointerup', () => { resizeState = null; });
chatUi.splitter.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const delta = event.shiftKey ? 32 : 12; const direction = event.key === 'ArrowLeft' ? delta : -delta; chatSettings.rightSize = clampChatSize(chatSize() + direction); applyChatLayout(); });
addEventListener('focus', refreshGitStatus);
setInterval(() => { if (document.visibilityState === 'visible') void refreshDirtyStatus(); }, 20_000);
addEventListener('resize', applyChatLayout);
document.documentElement.dataset.diffPalette = chatSettings.diffPalette;
chatUi.diffLayout.textContent = chatSettings.diffLayout === 'side-by-side' ? 'Side by side' : 'Inline';
chatUi.diffPalette.textContent = chatSettings.diffPalette === 'green' ? 'Red / green' : 'Red / blue';
applyThinkingVisibility();
applyChatLayout();
