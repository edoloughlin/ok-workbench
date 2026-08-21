const documentPane = document.querySelector('#document');
const nav = document.querySelector('#file-nav');
const picker = document.querySelector('#project-select');
const createProjectUi = {
  button: document.querySelector('#create-project-button'), dialog: document.querySelector('#create-project-dialog'), form: document.querySelector('#create-project-form'),
  name: document.querySelector('#create-project-name'), id: document.querySelector('#create-project-id'), description: document.querySelector('#create-project-description'),
  cancel: document.querySelector('#create-project-cancel'), close: document.querySelector('.create-project-header button'), submit: document.querySelector('#create-project-submit'), error: document.querySelector('#create-project-error')
};
let displayedDocument = null;
let pageLoadSequence = 0;
let pendingEntryRename = null;

function routePath() {
  const clean = decodeURIComponent(location.pathname).replace(/\/+$/, '');
  return clean === '' || clean === '/' ? '/workspace' : clean;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function inline(value, sourcePath) {
  const codeParts = [];
  let result = escapeHtml(value).replace(/`([^`]+)`/g, (_, code) => {
    codeParts.push(`<code>${code}</code>`); return `\u0000${codeParts.length - 1}\u0000`;
  });
  result = result.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => `<img alt="${label}" src="${linkHref(href, sourcePath, true)}">`);
  result = result.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => `<a href="${linkHref(href, sourcePath)}"${externalLinkAttributes(href)}>${label}</a>`);
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>').replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');
  return result.replace(/\u0000(\d+)\u0000/g, (_, index) => codeParts[index]);
}

function linkHref(href, sourcePath, asset = false) {
  if (/^(?:https?:|mailto:|#)/i.test(href)) return href;
  const [raw, hash] = href.split('#');
  const source = sourcePath.split('/').slice(0, -1);
  const output = raw.startsWith('/') ? raw.split('/') : [...source, ...raw.split('/')].reduce((parts, part) => part === '..' ? (parts.pop(), parts) : part !== '.' && part ? (parts.push(part), parts) : parts, []);
  const encodePathPart = part => { try { return encodeURIComponent(decodeURIComponent(part)); } catch { return encodeURIComponent(part); } };
  const resolved = `/${output.filter(Boolean).map(encodePathPart).join('/')}`.replace(/^\/workspace\/workspace/, '/workspace');
  const target = asset ? `/asset${resolved}` : resolved;
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

function table(lines, sourcePath) {
  const rows = lines.filter(line => !/^\s*\|?\s*:?-{3,}/.test(line)).map(line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
  if (!rows.length) return '';
  return `<table><thead><tr>${rows[0].map(cell => `<th scope="col" tabindex="0" data-sortable="true" aria-sort="none">${inline(cell, sourcePath)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(row => `<tr>${row.map(cell => `<td>${inline(cell, sourcePath)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

const TASK_STATES = {
  ' ': { name: 'To do', className: 'todo', icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" />' },
  x: { name: 'Completed', className: 'completed', icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="m5.25 8 1.8 1.8 3.7-3.7" />' },
  '~': { name: 'In progress', className: 'in-progress', icon: '<circle cx="8" cy="8" r="5.5" /><path d="M8 4.7v3.5l2.3 1.4" />' },
  '!': { name: 'Blocked', className: 'blocked', icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M8 4.8v3.5M8 10.8h.01" />' },
  '-': { name: 'Canceled', className: 'canceled', icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="m5.5 5.5 5 5m0-5-5 5" />' }
};

function taskListItem(value, sourcePath, location = {}) {
  const marker = value.match(/^\[([ xX!~\-])\]\s*/);
  if (!marker) return { isTask: false, html: `<li>${inline(value, sourcePath)}</li>` };

  const state = TASK_STATES[marker[1].toLowerCase()];
  const icon = `<button class="task-marker" type="button" title="Edit task: ${state.name}" aria-label="Edit task: ${state.name}" data-task-start-line="${location.startLine || ''}" data-task-end-line="${location.endLine || ''}" data-task-source-path="${escapeHtml(sourcePath)}"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${state.icon}</svg></button>`;
  return { isTask: true, html: `<li class="task-item task-${state.className}" data-task-state="${state.name.toLowerCase()}">${icon}<span class="task-content">${inline(value.slice(marker[0].length), sourcePath)}</span></li>` };
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
  const blockBoundary = line => /^(?:#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\s*([-*_])(?:\s*\1){2,}\s*$)/.test(line);
  const output = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) { const lang = line.slice(3).trim() || 'plaintext'; const block = []; while (++i < lines.length && !/^```/.test(lines[i])) block.push(lines[i]); i++; output.push(`<pre><code class="language-${escapeHtml(lang)}">${highlightCode(block.join('\n'), lang)}</code></pre>`); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/); if (heading) { const level = heading[1].length; const id = heading[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); output.push(`<h${level} id="${id}">${inline(heading[2], sourcePath)}</h${level}>`); i++; continue; }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) { const tableLines = [line]; while (++i < lines.length && /^\s*\|/.test(lines[i])) tableLines.push(lines[i]); output.push(table(tableLines, sourcePath)); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { output.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) { const quote = []; while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, '')); output.push(`<blockquote><p>${inline(quote.join(' '), sourcePath)}</p></blockquote>`); continue; }
    if (/^\s*[-*+]\s+/.test(line)) { const items = []; let hasTask = false; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { const start = i; const item = [lines[i++].replace(/^\s*[-*+]\s+/, '')]; while (i < lines.length && lines[i].trim() && !blockBoundary(lines[i])) item.push(lines[i++].trim()); const rendered = taskListItem(item.join(' '), sourcePath, { startLine: start + 1 + sourceLineOffset, endLine: i + sourceLineOffset }); hasTask ||= rendered.isTask; items.push(rendered.html); } output.push(`<ul${hasTask ? ' class="task-list"' : ''}>${items.join('')}</ul>`); continue; }
    if (/^\s*\d+\.\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { const item = [lines[i++].replace(/^\s*\d+\.\s+/, '')]; while (i < lines.length && lines[i].trim() && !blockBoundary(lines[i])) item.push(lines[i++].trim()); items.push(`<li>${inline(item.join(' '), sourcePath)}</li>`); } output.push(`<ol>${items.join('')}</ol>`); continue; }
    const paragraph = [line]; while (++i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i])) paragraph.push(lines[i]); output.push(`<p>${inline(paragraph.join(' '), sourcePath)}</p>`);
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
  if (file.kind === 'code') return `${header}<pre class="source-view" data-language="${escapeHtml(file.language)}"><code>${highlightCode(file.text, file.language)}</code></pre>`;
  if (file.kind === 'media' && file.mediaType === 'image') return `${header}<figure class="media-view"><a href="${file.url}" target="_blank" rel="noopener"><img src="${file.url}" alt="${escapeHtml(file.name)}"></a></figure>`;
  if (file.kind === 'media' && file.mediaType === 'pdf') return `${header}<iframe class="document-view" src="${file.url}" title="${escapeHtml(file.name)}"></iframe>`;
  if (file.kind === 'media' && file.mediaType === 'audio') return `${header}<div class="media-view"><audio controls src="${file.url}"></audio></div>`;
  if (file.kind === 'media' && file.mediaType === 'video') return `${header}<div class="media-view"><video controls src="${file.url}"></video></div>`;
  return `${header}<div class="binary-view"><p>This file cannot be previewed safely in the browser.</p><a href="${file.url}" target="_blank" rel="noopener">Open or download file ↗</a></div>`;
}

async function loadPage() {
  const request = ++pageLoadSequence; const route = routePath();
  documentPane.setAttribute('aria-busy', 'true'); nav.setAttribute('aria-busy', 'true'); picker.disabled = true;
  documentPane.innerHTML = '<p class="loading">Loading workspace…</p>';
  try {
    const [projectResponse, documentResponse] = await Promise.all([fetch(`/api/project?path=${encodeURIComponent(route)}`), fetch(`/api/document?path=${encodeURIComponent(route)}`)]);
    if (!projectResponse.ok || !documentResponse.ok) throw new Error('That document could not be found.');
    const data = await projectResponse.json(); const documentData = await documentResponse.json();
    if (request !== pageLoadSequence) return;
  displayedDocument = { path: documentData.path, project: data.project.name, text: documentData.text || '' };
  document.title = `${documentData.title || documentData.name} / workspace`;
  document.querySelector('#project-name').textContent = data.project.title;
  document.querySelector('#stats').textContent = `${data.stats.documents} docs · ${data.stats.folders} folders · ${data.stats.indexed} indexed`;
  picker.innerHTML = data.projects.map(item => `<option value="${item.path}" ${item.path === data.project.path ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
  const navigation = data.catalog.length
    ? `<p class="nav-label">Projects</p><div class="project-list">${data.catalog.map(projectLink).join('')}</div>`
    : `<div class="nav-section-heading"><p class="nav-label">Project pages</p>${data.project.name === 'workspace' ? '' : entryCreationActions(data.project.path)}</div><div class="project-tree">${data.tree.map(treeNode).join('')}</div>`;
  nav.innerHTML = `<div class="breadcrumbs" aria-label="Current directory">${data.context.breadcrumbs.map((item, index) => `<a href="${item.path}" ${index === data.context.breadcrumbs.length - 1 ? 'aria-current="location"' : ''}>${escapeHtml(item.label)}</a>`).join('<span>/</span>')}</div><p class="nav-label">Core documents</p><div class="core-documents">${data.common.map(coreDocumentLink).join('')}</div><hr class="nav-rule">${navigation}`;
  if (pendingEntryRename) requestAnimationFrame(() => { const input = nav.querySelector('.tree-inline-rename input'); input?.focus(); input?.select(); });
  const contextLabel = data.context.name === data.project.name ? data.project.name : `${data.project.name} / ${data.context.name}`;
  const kicker = `${contextLabel} / ${documentData.name}`;
  documentPane.innerHTML = documentData.kind === 'markdown' ? `<p class="doc-kicker">${escapeHtml(kicker)}</p>${renderMarkdown(documentData.text, documentData.path)}` : renderFile(documentData, kicker);
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
documentPane.addEventListener('click', handleTableInteraction);
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
  const button = event.target.closest('[data-create-entry]');
  if (button) { event.preventDefault(); event.stopPropagation(); void createProjectEntry(button); return; }
  const entry = event.target.closest('[data-entry-type].active');
  if (entry) { event.preventDefault(); event.stopPropagation(); void beginEntryRename(entry); }
});
nav.addEventListener('submit', event => { const form = event.target.closest('.tree-inline-rename'); if (!form) return; event.preventDefault(); void commitEntryRename(form); });
nav.addEventListener('keydown', event => { if (event.key !== 'Escape') return; const form = event.target.closest('.tree-inline-rename'); if (!form) return; event.preventDefault(); form.dataset.saving = 'true'; pendingEntryRename = null; void loadPage(); });
nav.addEventListener('focusout', event => { const form = event.target.closest('.tree-inline-rename'); if (!form || form.dataset.saving === 'true' || event.relatedTarget && form.contains(event.relatedTarget)) return; void commitEntryRename(form); });
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
  codexLogin: document.querySelector('#chat-codex-login'), copilotLogin: document.querySelector('#chat-copilot-login'), settings: document.querySelector('#chat-settings'), settingsMenu: document.querySelector('#chat-settings-menu'),
  titleModel: document.querySelector('#chat-title-model'), titleEffort: document.querySelector('#chat-title-effort'),
  thread: document.querySelector('#chat-thread'), newThread: document.querySelector('#chat-new-thread'),
  messages: document.querySelector('#chat-messages'), composer: document.querySelector('#chat-composer'),
  input: document.querySelector('#chat-input'), send: document.querySelector('#chat-send'), stop: document.querySelector('#chat-stop'), authCode: document.querySelector('#chat-auth-code'), authDialog: document.querySelector('#chat-auth-dialog'), authDialogCode: document.querySelector('#chat-auth-dialog-code'),
  status: document.querySelector('#chat-status'), changes: document.querySelector('#chat-changes'), changeCount: document.querySelector('#chat-change-count'),
  changesDialog: document.querySelector('#changes-dialog'), diffSummary: document.querySelector('#diff-summary'),
  diffFiles: document.querySelector('#diff-files'), diffFileTitle: document.querySelector('#diff-file-title'), diffContent: document.querySelector('#diff-content'), diffTabs: document.querySelector('#diff-source-tabs'),
  diffLayout: document.querySelector('#diff-layout'), diffPalette: document.querySelector('#diff-palette'),
  diffRevert: document.querySelector('#diff-revert'), diffUnstage: document.querySelector('#diff-unstage'), diffUndo: document.querySelector('#diff-undo')
};
const todoUi = { popover: document.querySelector('#todo-popover'), form: document.querySelector('#todo-form'), close: document.querySelector('#todo-close'), cancel: document.querySelector('#todo-cancel'), states: document.querySelector('#todo-states'), markdown: document.querySelector('#todo-markdown'), useLlm: document.querySelector('#todo-use-llm'), llmFields: document.querySelector('#todo-llm-fields'), prompt: document.querySelector('#todo-prompt'), model: document.querySelector('#todo-model'), apply: document.querySelector('#todo-apply') };
let activeTodo = null;
function smallModel(models) { return models.find(model => /(?:mini|small|haiku|flash)/i.test(model.label || model.id))?.id || models[0]?.id || ''; }
function todoModels() {
  if (chatModels.length) return chatModels;
  return [...chatUi.model.options].filter(option => option.value).map(option => ({ id: option.value, label: option.textContent }));
}
function closeTodo() { todoUi.popover.hidden = true; activeTodo = null; }
function openTodo(button) {
  if (!displayedDocument?.text || !button.dataset.taskStartLine) return;
  const startLine = Number(button.dataset.taskStartLine), endLine = Number(button.dataset.taskEndLine); const lines = displayedDocument.text.replace(/\r/g, '').split('\n');
  const original = lines.slice(startLine - 1, endLine).join('\n'); if (!original) return;
  activeTodo = { path: button.dataset.taskSourcePath, startLine, endLine, original, state: (original.match(/^\s*[-*+]\s+\[([ xX!~\-])\]/)?.[1] || ' ').toLowerCase() };
  todoUi.markdown.value = original; todoUi.prompt.value = ''; todoUi.useLlm.checked = true; todoUi.llmFields.hidden = false;
  const models = todoModels(); setOptions(todoUi.model, models.length ? models : [{ id: '', label: 'No configured model' }], smallModel(models)); todoUi.model.disabled = false;
  for (const state of todoUi.states.querySelectorAll('[data-todo-state]')) { const current = state.dataset.todoState === activeTodo.state; state.hidden = current; state.setAttribute('aria-pressed', String(current)); }
  const rect = button.getBoundingClientRect(); todoUi.popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 368))}px`; todoUi.popover.style.top = `${Math.min(rect.bottom + 8, innerHeight - 80)}px`; todoUi.popover.hidden = false;
  requestAnimationFrame(() => { todoUi.popover.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - todoUi.popover.offsetHeight - 8))}px`; todoUi.markdown.focus(); });
}
function todoMarkdown(state) {
  const source = todoUi.markdown.value.replace(/\r/g, '').trimEnd(); const marker = state === ' ' ? '[ ]' : `[${state}]`;
  return /^\s*[-*+]\s+\[[ xX!~\-]\]\s*/.test(source) ? source.replace(/^(\s*[-*+]\s+)\[[ xX!~\-]\]\s*/, `$1${marker} `) : `* ${marker} ${source}`;
}
async function applyTodo() {
  if (!activeTodo) return; const replacement = todoMarkdown(activeTodo.state); todoUi.apply.disabled = true;
  try {
    const response = await chatApi(`/api/projects/${encodeURIComponent(displayedDocument.project)}/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...activeTodo, replacement }) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not update task');
    const sideEffectCheck = todoUi.useLlm.checked;
    const prompt = `I updated the task in ${activeTodo.path} (lines ${activeTodo.startLine}-${activeTodo.endLine}) to:\n\n${replacement}\n\nBriefly check this project for related side effects. Update only any task, status, or log items that genuinely need to stay consistent, then summarize what you found.${todoUi.prompt.value.trim() ? `\n\nAdditional instruction: ${todoUi.prompt.value.trim()}` : ''}`;
    closeTodo(); await loadPage(); refreshGitStatus();
    if (sideEffectCheck) { addChatMessage('user', prompt, false, new Date().toISOString(), { initiator: 'system' }); await streamChatTurn(prompt, { model: todoUi.model.value, initiator: 'system' }); }
  } catch (error) { alert(error.message || 'Could not update task'); }
  finally { todoUi.apply.disabled = false; }
}
documentPane.addEventListener('click', event => { const marker = event.target.closest('.task-marker'); if (!marker) return; event.preventDefault(); openTodo(marker); });
todoUi.states.addEventListener('click', event => { const button = event.target.closest('[data-todo-state]'); if (!button || !activeTodo) return; activeTodo.state = button.dataset.todoState; for (const state of todoUi.states.querySelectorAll('[data-todo-state]')) { const current = state === button; state.hidden = current; state.setAttribute('aria-pressed', String(current)); } });
todoUi.useLlm.addEventListener('change', () => { todoUi.llmFields.hidden = !todoUi.useLlm.checked; });
todoUi.close.addEventListener('click', closeTodo); todoUi.cancel.addEventListener('click', closeTodo);
todoUi.form.addEventListener('submit', event => { event.preventDefault(); void applyTodo(); });
document.addEventListener('pointerdown', event => { if (!todoUi.popover.hidden && !todoUi.popover.contains(event.target) && !event.target.closest('.task-marker')) closeTodo(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !todoUi.popover.hidden) closeTodo(); });
const chatStorageKey = 'ok-workbench.chat-pane.v1';
const chatProjectPreferencesKey = 'ok-workbench.chat-project-preferences.v1';
const defaultChatSettings = { collapsed: false, rightSize: 420, diffLayout: 'side-by-side', diffPalette: 'green', titleProvider: '', titleModel: '', titleEffort: '' };
let chatSettings = { ...defaultChatSettings };
try { chatSettings = { ...defaultChatSettings, ...JSON.parse(localStorage.getItem(chatStorageKey) || '{}') }; } catch { /* ignore corrupt local preference */ }
let chatProjectPreferences = {};
try { chatProjectPreferences = JSON.parse(localStorage.getItem(chatProjectPreferencesKey) || '{}'); } catch { /* ignore corrupt local preference */ }
let chatProjectId = null;
let chatThreadId = null;
let chatThreads = [];
// A turn belongs to the project and thread that started it. Turns may continue
// independently while the user visits another project or conversation.
const activeChatTurns = new Set();
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

function persistChatSettings() { localStorage.setItem(chatStorageKey, JSON.stringify(chatSettings)); }
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
function activeTurnsFor(projectId = chatProjectId, threadId = chatThreadId) { return [...activeChatTurns].filter(turn => turn.projectId === projectId && turn.threadId === threadId); }
function activeTurnFor(projectId = chatProjectId, threadId = chatThreadId) { return activeTurnsFor(projectId, threadId).at(-1) || null; }
function currentChatTurn() { return activeTurnFor(); }
function syncChatTurnControls() { chatUi.send.disabled = false; chatUi.stop.hidden = !currentChatTurn(); }
function renderTurnNotifications() {
  chatUi.notificationsCount.hidden = turnNotifications.length === 0;
  chatUi.notificationsCount.textContent = turnNotifications.length > 9 ? '9+' : String(turnNotifications.length);
  chatUi.notificationsList.replaceChildren();
  if (!turnNotifications.length) { const empty = document.createElement('p'); empty.className = 'turn-notifications-empty'; empty.textContent = 'No completed turns yet.'; chatUi.notificationsList.append(empty); return; }
  for (const notification of turnNotifications) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'turn-notification'; button.dataset.turnNotification = notification.id;
    const title = document.createElement('strong'); title.textContent = notification.projectTitle;
    const detail = document.createElement('span'); detail.textContent = 'Chat turn complete · Open project';
    button.append(title, detail); chatUi.notificationsList.append(button);
  }
}
function closeTurnNotifications() { chatUi.notificationsMenu.hidden = true; chatUi.notificationsButton.setAttribute('aria-expanded', 'false'); }
function toggleTurnNotifications() { const open = chatUi.notificationsMenu.hidden; chatUi.notificationsMenu.hidden = !open; chatUi.notificationsButton.setAttribute('aria-expanded', String(open)); if (open) renderTurnNotifications(); }
function addTurnNotification(turn) { turnNotifications.unshift({ id: crypto.randomUUID(), projectId: turn.projectId, projectTitle: turn.projectTitle, threadId: turn.threadId }); renderTurnNotifications(); }
async function openTurnNotification(id) {
  const notification = turnNotifications.find(item => item.id === id); if (!notification) return;
  turnNotifications.splice(turnNotifications.indexOf(notification), 1); renderTurnNotifications(); closeTurnNotifications();
  if (notification.projectId === chatProjectId) { chatThreadId = notification.threadId; renderThreadSelect(); await loadChatThread(chatThreadId); syncChatTurnControls(); return; }
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
function applyChatLayout() {
  chatUi.layout.classList.toggle('chat-collapsed', Boolean(chatSettings.collapsed));
  chatUi.layout.style.setProperty('--chat-size', `${chatSize()}px`);
  chatUi.toggle.setAttribute('aria-expanded', String(!chatSettings.collapsed));
  chatUi.restore.hidden = !chatSettings.collapsed;
  chatUi.restoreBadge.textContent = chatUnread ? String(chatUnread) : '';
  chatUi.splitter.setAttribute('aria-orientation', 'vertical');
  const bounds = chatSizeBounds();
  chatUi.splitter.setAttribute('aria-valuemin', String(bounds.min));
  chatUi.splitter.setAttribute('aria-valuemax', String(bounds.max));
  chatUi.splitter.setAttribute('aria-valuenow', String(chatSize()));
  chatUi.splitter.setAttribute('aria-label', 'Resize right-docked chat pane');
  persistChatSettings();
}
function setChatCollapsed(collapsed) { chatSettings.collapsed = Boolean(collapsed); if (!collapsed) chatUnread = 0; applyChatLayout(); }

function setOptions(select, values, selected) {
  select.replaceChildren(...values.map(value => {
    const option = document.createElement('option'); option.value = value.id || value; option.textContent = value.label || value.id || value; option.selected = option.value === selected; return option;
  }));
}
function closeChatSettings() { chatUi.settingsMenu.hidden = true; chatUi.settings.setAttribute('aria-expanded', 'false'); }
function toggleChatSettings() { const open = chatUi.settingsMenu.hidden; chatUi.settingsMenu.hidden = !open; chatUi.settings.setAttribute('aria-expanded', String(open)); }
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
    button.textContent = connected ? `${label} connected` : `Sign in to ${label}`;
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
function messageHeader(role, error, createdAt, { model = '', effort = '', initiator = 'user' } = {}) {
  const header = document.createElement('header'); header.className = 'chat-message-header';
  const meta = document.createElement('span'); meta.className = 'message-meta'; meta.textContent = role === 'user' ? (initiator === 'system' ? 'System' : 'You') : error ? 'Error' : `${model || 'Model unavailable'} · ${effort || 'Default effort'}`;
  const timestamp = document.createElement('time'); timestamp.className = 'message-time'; timestamp.dateTime = createdAt || ''; timestamp.textContent = formatThreadTime(createdAt);
  header.append(meta, timestamp); return header;
}
function renderChatMessages(messages = [], threadSettings = {}) {
  chatUi.messages.replaceChildren();
  if (!messages.length) { const empty = document.createElement('p'); empty.className = 'chat-empty'; empty.textContent = 'Start a project-scoped conversation. Files are available only when the agent requests them.'; chatUi.messages.append(empty); return; }
  for (const message of messages) {
    const node = document.createElement('article'); node.className = `chat-message ${message.role === 'user' ? 'user' : message.error ? 'error' : 'assistant'}`;
    const content = document.createElement('div');
    if (!message.error && message.role === 'assistant') renderAssistantMarkdown(content, message.content || '');
    else if (!message.error && message.role === 'user') renderUserMarkdown(content, message.content || '');
    else content.textContent = message.content || '';
    node.append(messageHeader(message.role, message.error, message.createdAt, { model: message.model || threadSettings.model, effort: message.effort || threadSettings.effort, initiator: message.initiator }), content); chatUi.messages.append(node);
  }
  scrollChatToLatest({ force: true });
}
function addChatMessage(role, content, error = false, createdAt = new Date().toISOString(), settings = {}) { const existing = [...chatUi.messages.querySelectorAll('.chat-empty')]; existing.forEach(node => node.remove()); const node = document.createElement('article'); node.className = `chat-message ${role === 'user' ? 'user' : error ? 'error' : 'assistant'}`; node.dataset.streamMessage = role === 'assistant' && !error ? 'true' : ''; const body = document.createElement('div'); if (!error && role === 'assistant') renderAssistantMarkdown(body, content); else if (!error && role === 'user') renderUserMarkdown(body, content); else body.textContent = content; node.append(messageHeader(role, error, createdAt, settings), body); chatUi.messages.append(node); scrollChatToLatest({ force: true }); return body; }

async function loadChatStatus() {
  try {
    const response = await chatApi('/api/chat/status'); if (!response.ok) throw new Error('Chat unavailable');
    const data = await response.json(); const providers = data.providers || [];
    setProviderLoginState(providers);
    loadTitleModels(providers);
    const preference = projectChatPreference();
    setOptions(chatUi.provider, providers, providers.some(item => item.id === preference.provider) ? preference.provider : (chatUi.provider.value || data.defaultProvider));
    await loadChatModels();
    setChatStatus(data.enabled ? 'Ready' : (data.message || 'Configure a provider'));
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
function renderThreadSelect() { setOptions(chatUi.thread, chatThreads.map(thread => { const title = thread.title || 'New conversation'; return { id: thread.id, label: title === 'New conversation' ? title : `${title} · ${formatThreadTime(thread.updatedAt || thread.createdAt)}` }; }), chatThreadId); }
async function loadChatThread(threadId) {
  if (!threadId) { renderChatMessages([]); return; }
  const response = await chatApi(`/api/chat/threads/${encodeURIComponent(threadId)}`); if (!response.ok) throw new Error('Could not load chat thread');
  const data = await response.json(); chatThreadId = data.id; renderChatMessages(data.messages || [], data); syncChatTurnControls();
}
async function createChatThread() {
  const response = await chatApi('/api/chat/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: chatProjectId, provider: chatUi.provider.value, model: chatUi.model.value, effort: chatUi.effort.value, titleProvider: chatSettings.titleProvider, titleModel: chatSettings.titleModel, titleEffort: chatSettings.titleEffort }) });
  if (!response.ok) throw new Error((await response.json()).error || 'Could not create chat thread');
  const thread = await response.json(); chatThreads.unshift(thread); chatThreadId = thread.id; renderThreadSelect(); renderChatMessages([]); syncChatTurnControls(); return thread;
}
async function loadChatThreads() {
  if (!chatProjectId) return;
  try { const response = await chatApi(`/api/chat/threads?project=${encodeURIComponent(chatProjectId)}`); if (!response.ok) throw new Error('Could not list chat threads'); chatThreads = await response.json(); const requested = pendingChatThread?.projectId === chatProjectId ? pendingChatThread.threadId : null; if (requested && chatThreads.some(thread => thread.id === requested)) chatThreadId = requested; else if (!chatThreadId || !chatThreads.some(thread => thread.id === chatThreadId)) chatThreadId = chatThreads[0]?.id || null; if (requested) pendingChatThread = null; if (!chatThreadId) await createChatThread(); else { renderThreadSelect(); await loadChatThread(chatThreadId); } } catch (error) { renderChatMessages([{ role: 'assistant', content: error.message, error: true }]); }
}
async function refreshGitStatus() {
  if (!chatProjectId) return;
  try { const response = await chatApi(`/api/projects/${encodeURIComponent(chatProjectId)}/git/status`); if (!response.ok) throw new Error(); const status = await response.json(); chatUi.changeCount.textContent = String(status.changedFiles || 0); } catch { chatUi.changeCount.textContent = '–'; }
}
async function chatProjectChanged(project) {
  if (!project?.name || project.name === chatProjectId) return;
  chatProjectId = project.name; chatThreadId = null; chatUi.project.textContent = project.title || project.name; setChatStatus('Loading project chat…');
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
  if (turn.id) {
    try { await chatApi(`/api/chat/threads/${encodeURIComponent(turn.threadId)}/turns/${encodeURIComponent(turn.id)}`, { method: 'DELETE' }); } catch { /* Closing the local stream still aborts the turn. */ }
  }
  turn.abort.abort();
}
async function streamChatTurn(message, { model = chatUi.model.value, initiator = 'user' } = {}) {
  saveProjectChatPreference();
  if (!chatThreadId) await createChatThread();
  const turn = { abort: new AbortController(), id: null, projectId: chatProjectId, projectTitle: chatUi.project.textContent || chatProjectId, threadId: chatThreadId, unread: false };
  activeChatTurns.add(turn); syncChatTurnControls(); setChatStatus('Thinking…');
  const isVisible = () => activeChatTurns.has(turn) && chatProjectId === turn.projectId && chatThreadId === turn.threadId;
  const assistantBody = addChatMessage('assistant', '', false, new Date().toISOString(), { model, effort: chatUi.effort.value }); let assistantText = ''; let projectCreated = false; let completed = false;
  try {
    const requestTurn = () => fetch(`/api/chat/threads/${encodeURIComponent(turn.threadId)}/turns`, { method: 'POST', signal: turn.abort.signal, headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', 'x-ok-workbench-csrf': chatCsrf }, body: JSON.stringify({ message, initiator, provider: chatUi.provider.value, model, effort: chatUi.effort.value, titleProvider: chatSettings.titleProvider, titleModel: chatSettings.titleModel, titleEffort: chatSettings.titleEffort }) });
    let response = await requestTurn();
    if (await invalidChatToken(response)) { await refreshChatCsrf(); response = await requestTurn(); }
    if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error || 'Could not start chat turn');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffered = '';
    for (;;) { const { value, done } = await reader.read(); if (done) break; buffered += decoder.decode(value, { stream: true }); const lines = buffered.split('\n'); buffered = lines.pop(); for (const line of lines) { if (!line) continue; const event = JSON.parse(line); if (event.type === 'turn.started') turn.id = event.turn_id || null; else if (event.type === 'message.delta') { assistantText += event.delta || ''; if (isVisible()) { renderAssistantMarkdown(assistantBody, assistantText); scrollChatToLatest(); if (chatSettings.collapsed && !turn.unread) { turn.unread = true; chatUnread++; applyChatLayout(); } } } else if (event.type === 'tool.completed') { if (event.tool === 'create_project' && event.result?.location) projectCreated = true; if (!isVisible()) continue; const activity = document.createElement('p'); activity.className = 'chat-tool-activity'; if (event.tool === 'create_project' && event.result?.location) { activity.append('Created project: '); const link = document.createElement('a'); link.href = event.result.location; link.textContent = event.result.title || event.result.id || event.result.location; activity.append(link); } else activity.textContent = `Used ${event.tool || 'workspace tool'}`; chatUi.messages.append(activity); scrollChatToLatest(); } else if (event.type === 'scope.granted') { if (!isVisible()) continue; const activity = document.createElement('p'); activity.className = 'chat-tool-activity'; activity.textContent = `Attached ${event.grants?.map(grant => `@${grant.project}/${grant.path}`).join(', ') || 'project context'}`; chatUi.messages.append(activity); scrollChatToLatest(); } else if (event.type === 'turn.failed') throw new Error(event.error || 'Turn failed'); else if (event.type === 'workspace.changed') { if (event.project === chatProjectId) refreshGitStatus(); reloadChangedDocument(event); } else if (event.type === 'usage.updated' && isVisible()) setChatStatus(event.usage || 'Working…'); } }
    completed = true;
    if (!assistantText && isVisible()) { renderAssistantMarkdown(assistantBody, 'No response returned.'); scrollChatToLatest(); }
    if (isVisible()) { setChatStatus('Ready'); if (projectCreated) await loadPage(); else await loadChatThreads(); }
  } catch (error) { if (isVisible()) { assistantBody.parentElement.classList.add('error'); assistantBody.parentElement.querySelector('.message-meta').textContent = 'Error'; assistantBody.textContent = error.name === 'AbortError' ? 'Stopped.' : error.message; setChatStatus(error.name === 'AbortError' ? 'Stopped' : 'Error'); } }
  finally { const visible = isVisible(); activeChatTurns.delete(turn); if (completed) addTurnNotification(turn); if (visible) { syncChatTurnControls(); if (completed) setChatStatus('Ready'); } }
}
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

chatUi.toggle.addEventListener('click', () => setChatCollapsed(!chatSettings.collapsed));
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
document.addEventListener('click', event => { if (!event.target.closest('.chat-menu')) closeChatSettings(); });
document.addEventListener('click', event => { if (!event.target.closest('.turn-notifications')) closeTurnNotifications(); });
chatUi.titleModel.addEventListener('change', () => { const model = titleModels.find(item => titleModelKey(item) === chatUi.titleModel.value); if (!model) return; chatSettings.titleProvider = model.provider; chatSettings.titleModel = model.id; loadTitleEfforts(chatSettings.titleEffort); persistChatSettings(); });
chatUi.titleEffort.addEventListener('change', () => { chatSettings.titleEffort = chatUi.titleEffort.value; persistChatSettings(); });
chatUi.codexLogin.addEventListener('click', () => signInToProvider('openai-codex'));
chatUi.copilotLogin.addEventListener('click', () => signInToProvider('github-copilot'));
chatUi.newThread.addEventListener('click', () => createChatThread().catch(error => setChatStatus(error.message)));
chatUi.thread.addEventListener('change', () => loadChatThread(chatUi.thread.value).catch(error => setChatStatus(error.message)));
chatUi.composer.addEventListener('submit', event => { event.preventDefault(); const message = chatUi.input.value.trim(); if (!message) return; chatUi.input.value = ''; addChatMessage('user', message); streamChatTurn(message); });
chatUi.input.addEventListener('keydown', event => { if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return; event.preventDefault(); chatUi.composer.requestSubmit(); });
chatUi.stop.addEventListener('click', () => cancelChatTurn());
chatUi.notificationsButton.addEventListener('click', toggleTurnNotifications);
chatUi.notificationsList.addEventListener('click', event => { const button = event.target.closest('[data-turn-notification]'); if (button) openTurnNotification(button.dataset.turnNotification).catch(error => setChatStatus(error.message)); });
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
addEventListener('resize', applyChatLayout);
document.documentElement.dataset.diffPalette = chatSettings.diffPalette;
chatUi.diffLayout.textContent = chatSettings.diffLayout === 'side-by-side' ? 'Side by side' : 'Inline';
chatUi.diffPalette.textContent = chatSettings.diffPalette === 'green' ? 'Red / green' : 'Red / blue';
applyChatLayout();
