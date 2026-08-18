const documentPane = document.querySelector('#document');
const nav = document.querySelector('#file-nav');
const picker = document.querySelector('#project-select');
let displayedDocument = null;

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
  result = result.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => `<a href="${linkHref(href, sourcePath)}">${label}</a>`);
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>').replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');
  return result.replace(/\u0000(\d+)\u0000/g, (_, index) => codeParts[index]);
}

function linkHref(href, sourcePath, asset = false) {
  if (/^(?:https?:|mailto:|#)/i.test(href)) return href;
  const [raw, hash] = href.split('#');
  const source = sourcePath.split('/').slice(0, -1);
  const output = raw.startsWith('/') ? raw.split('/') : [...source, ...raw.split('/')].reduce((parts, part) => part === '..' ? (parts.pop(), parts) : part !== '.' && part ? (parts.push(part), parts) : parts, []);
  const resolved = `/${output.filter(Boolean).map(encodeURIComponent).join('/')}`.replace(/^\/workspace\/workspace/, '/workspace');
  const target = asset ? `/asset${resolved}` : resolved;
  return `${target}${hash ? `#${encodeURIComponent(hash)}` : ''}`;
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
  '!': { name: 'Blocked', className: 'blocked', icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M8 4.8v3.5M8 10.8h.01" />' },
  '-': { name: 'Canceled', className: 'canceled', icon: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="m5.5 5.5 5 5m0-5-5 5" />' }
};

function taskListItem(value, sourcePath) {
  const marker = value.match(/^\[([ xX!-])\]\s*/);
  if (!marker) return { isTask: false, html: `<li>${inline(value, sourcePath)}</li>` };

  const state = TASK_STATES[marker[1].toLowerCase()];
  const icon = `<svg class="task-marker" viewBox="0 0 16 16" role="img" aria-label="${state.name}" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${state.icon}</svg>`;
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
  const lines = markdown.replace(/^---[\s\S]*?---\s*/,'').replace(/\r/g, '').split('\n');
  const output = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) { const lang = line.slice(3).trim() || 'plaintext'; const block = []; while (++i < lines.length && !/^```/.test(lines[i])) block.push(lines[i]); i++; output.push(`<pre><code class="language-${escapeHtml(lang)}">${highlightCode(block.join('\n'), lang)}</code></pre>`); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/); if (heading) { const level = heading[1].length; const id = heading[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); output.push(`<h${level} id="${id}">${inline(heading[2], sourcePath)}</h${level}>`); i++; continue; }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) { const tableLines = [line]; while (++i < lines.length && /^\s*\|/.test(lines[i])) tableLines.push(lines[i]); output.push(table(tableLines, sourcePath)); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { output.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) { const quote = []; while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, '')); output.push(`<blockquote><p>${inline(quote.join(' '), sourcePath)}</p></blockquote>`); continue; }
    if (/^\s*[-*+]\s+/.test(line)) { const items = []; let hasTask = false; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { const item = [lines[i++].replace(/^\s*[-*+]\s+/, '')]; while (i < lines.length && /^\s{2,}\S/.test(lines[i])) item.push(lines[i++].trim()); const rendered = taskListItem(item.join(' '), sourcePath); hasTask ||= rendered.isTask; items.push(rendered.html); } output.push(`<ul${hasTask ? ' class="task-list"' : ''}>${items.join('')}</ul>`); continue; }
    if (/^\s*\d+\.\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { const item = [lines[i++].replace(/^\s*\d+\.\s+/, '')]; while (i < lines.length && /^\s{2,}\S/.test(lines[i])) item.push(lines[i++].trim()); items.push(`<li>${inline(item.join(' '), sourcePath)}</li>`); } output.push(`<ol>${items.join('')}</ol>`); continue; }
    const paragraph = [line]; while (++i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i])) paragraph.push(lines[i]); output.push(`<p>${inline(paragraph.join(' '), sourcePath)}</p>`);
  }
  return output.join('\n');
}

function normalizedRoute(path) { return path.replace(/\/index\.md$/i, '').replace(/\/$/, ''); }
function active(path) { return normalizedRoute(path) === normalizedRoute(routePath()); }
function navLink(item) { return `<a class="nav-link ${active(item.path) ? 'active' : ''}" href="${item.path}">${escapeHtml(item.label)}</a>`; }
function containsCurrent(path) { const directory = normalizedRoute(path); const current = normalizedRoute(routePath()); return current === directory || current.startsWith(`${directory}/`); }
function treeNode(item) {
  if (item.type === 'file') return `<a class="nav-link tree-link ${active(item.path) ? 'active' : ''}" href="${item.path}">${escapeHtml(item.label)}</a>`;
  return `<details class="tree-directory" ${containsCurrent(item.path) ? 'open' : ''}><summary><a href="${item.path}">${escapeHtml(item.label)}</a></summary><div class="tree-children">${item.children.length ? item.children.map(treeNode).join('') : '<span class="tree-empty">Empty</span>'}</div></details>`;
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
  const route = routePath();
  const [projectResponse, documentResponse] = await Promise.all([fetch(`/api/project?path=${encodeURIComponent(route)}`), fetch(`/api/document?path=${encodeURIComponent(route)}`)]);
  if (!projectResponse.ok || !documentResponse.ok) throw new Error('That document could not be found.');
  const data = await projectResponse.json(); const documentData = await documentResponse.json();
  displayedDocument = { path: documentData.path, project: data.project.name };
  document.title = `${documentData.title || documentData.name} / workspace`;
  document.querySelector('#project-name').textContent = data.project.title;
  document.querySelector('#stats').textContent = `${data.stats.documents} docs · ${data.stats.folders} folders · ${data.stats.indexed} indexed`;
  picker.innerHTML = data.projects.map(item => `<option value="${item.path}" ${item.path === data.project.path ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
  const navigation = data.catalog.length
    ? `<p class="nav-label">Projects</p>${data.catalog.map(navLink).join('')}`
    : `<p class="nav-label">Project tree</p><div class="project-tree">${data.tree.map(treeNode).join('')}</div>`;
  nav.innerHTML = `<div class="breadcrumbs" aria-label="Current directory">${data.context.breadcrumbs.map((item, index) => `<a href="${item.path}" ${index === data.context.breadcrumbs.length - 1 ? 'aria-current="location"' : ''}>${escapeHtml(item.label)}</a>`).join('<span>/</span>')}</div><p class="nav-label">Core documents</p>${data.common.map(navLink).join('')}<hr class="nav-rule">${navigation}`;
  const contextLabel = data.context.name === data.project.name ? data.project.name : `${data.project.name} / ${data.context.name}`;
  const kicker = `${contextLabel} / ${documentData.name}`;
  documentPane.innerHTML = documentData.kind === 'markdown' ? `<p class="doc-kicker">${escapeHtml(kicker)}</p>${renderMarkdown(documentData.text, documentData.path)}` : renderFile(documentData, kicker);
  if (typeof chatProjectChanged === 'function') chatProjectChanged(data.project).catch(error => setChatStatus(error.message));
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'start' }); else { documentPane.scrollTop = 0; scrollTo(0, 0); }
}

function navigate(event) { const anchor = event.target.closest('a'); const href = anchor?.getAttribute('href') || ''; if (!anchor || anchor.target || /^(?:mailto:|https?:)/i.test(href)) return; const url = new URL(anchor.href); if (url.origin !== location.origin || !url.pathname.startsWith('/workspace')) return; event.preventDefault(); history.pushState({}, '', `${url.pathname}${url.hash}`); loadPage().catch(showError); }
function showError(error) { documentPane.innerHTML = `<h1>Not found</h1><p>${escapeHtml(error.message)}</p>`; }

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
addEventListener('popstate', () => loadPage().catch(showError));
loadPage().catch(showError);

// Project chat ---------------------------------------------------------------
// The UI intentionally speaks only to same-origin APIs. Provider credentials,
// project paths, and tool execution never enter browser state.
const chatUi = {
  layout: document.querySelector('#app-layout'), pane: document.querySelector('#chat-pane'),
  toggle: document.querySelector('#chat-toggle'), collapse: document.querySelector('#chat-collapse'),
  restore: document.querySelector('#chat-restore'), restoreBadge: document.querySelector('#chat-restore-badge'),
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
let chatAbort = null;
let titleModels = [];
let diffFiles = [];
let selectedDiffFile = 0;
let chatTurnId = null;
let chatUnread = 0;
let chatTurnUnread = false;
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
function renderAssistantMarkdown(element, content) {
  // renderMarkdown escapes source text before creating markup; chat replies do
  // not accept raw HTML from a model.
  element.classList.add('chat-markdown');
  const sourcePath = !chatProjectId || chatProjectId === 'workspace' ? '/workspace/index.md' : `/workspace/${encodeURIComponent(chatProjectId)}/index.md`;
  element.innerHTML = renderMarkdown(content, sourcePath);
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
function messageHeader(role, error, createdAt) {
  const header = document.createElement('header'); header.className = 'chat-message-header';
  const meta = document.createElement('span'); meta.className = 'message-meta'; meta.textContent = role === 'user' ? 'You' : error ? 'Error' : 'Agent';
  const timestamp = document.createElement('time'); timestamp.className = 'message-time'; timestamp.dateTime = createdAt || ''; timestamp.textContent = formatThreadTime(createdAt);
  header.append(meta, timestamp); return header;
}
function renderChatMessages(messages = []) {
  chatUi.messages.replaceChildren();
  if (!messages.length) { const empty = document.createElement('p'); empty.className = 'chat-empty'; empty.textContent = 'Start a project-scoped conversation. Files are available only when the agent requests them.'; chatUi.messages.append(empty); return; }
  for (const message of messages) {
    const node = document.createElement('article'); node.className = `chat-message ${message.role === 'user' ? 'user' : message.error ? 'error' : 'assistant'}`;
    const content = document.createElement('div');
    if (message.role === 'assistant' && !message.error) renderAssistantMarkdown(content, message.content || '');
    else content.textContent = message.content || '';
    node.append(messageHeader(message.role, message.error, message.createdAt), content); chatUi.messages.append(node);
  }
  scrollChatToLatest({ force: true });
}
function addChatMessage(role, content, error = false, createdAt = new Date().toISOString()) { const existing = [...chatUi.messages.querySelectorAll('.chat-empty')]; existing.forEach(node => node.remove()); const node = document.createElement('article'); node.className = `chat-message ${role === 'user' ? 'user' : error ? 'error' : 'assistant'}`; node.dataset.streamMessage = role === 'assistant' && !error ? 'true' : ''; const body = document.createElement('div'); if (role === 'assistant' && !error) renderAssistantMarkdown(body, content); else body.textContent = content; node.append(messageHeader(role, error, createdAt), body); chatUi.messages.append(node); scrollChatToLatest({ force: true }); return body; }

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
  const data = await response.json(); chatThreadId = data.id; renderChatMessages(data.messages || []);
}
async function createChatThread() {
  const response = await chatApi('/api/chat/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: chatProjectId, provider: chatUi.provider.value, model: chatUi.model.value, effort: chatUi.effort.value, titleProvider: chatSettings.titleProvider, titleModel: chatSettings.titleModel, titleEffort: chatSettings.titleEffort }) });
  if (!response.ok) throw new Error((await response.json()).error || 'Could not create chat thread');
  const thread = await response.json(); chatThreads.unshift(thread); chatThreadId = thread.id; renderThreadSelect(); renderChatMessages([]); return thread;
}
async function loadChatThreads() {
  if (!chatProjectId) return;
  try { const response = await chatApi(`/api/chat/threads?project=${encodeURIComponent(chatProjectId)}`); if (!response.ok) throw new Error('Could not list chat threads'); chatThreads = await response.json(); if (!chatThreadId || !chatThreads.some(thread => thread.id === chatThreadId)) chatThreadId = chatThreads[0]?.id || null; if (!chatThreadId) await createChatThread(); else { renderThreadSelect(); await loadChatThread(chatThreadId); } } catch (error) { renderChatMessages([{ role: 'assistant', content: error.message, error: true }]); }
}
async function refreshGitStatus() {
  if (!chatProjectId) return;
  try { const response = await chatApi(`/api/projects/${encodeURIComponent(chatProjectId)}/git/status`); if (!response.ok) throw new Error(); const status = await response.json(); chatUi.changeCount.textContent = String(status.changedFiles || 0); } catch { chatUi.changeCount.textContent = '–'; }
}
async function chatProjectChanged(project) {
  if (!project?.name || project.name === chatProjectId) return;
  if (chatAbort && !confirm('Switching projects will stop the active chat turn. Continue?')) return;
  if (chatAbort) await cancelChatTurn();
  chatProjectId = project.name; chatThreadId = null; chatUi.project.textContent = project.title || project.name; setChatStatus('Loading project chat…');
  await Promise.all([loadChatStatus(), loadChatThreads(), refreshGitStatus()]);
}
async function cancelChatTurn() {
  const abort = chatAbort; const turnId = chatTurnId;
  if (turnId && chatThreadId) {
    try { await chatApi(`/api/chat/threads/${encodeURIComponent(chatThreadId)}/turns/${encodeURIComponent(turnId)}`, { method: 'DELETE' }); } catch { /* Closing the local stream still aborts the turn. */ }
  }
  abort?.abort();
}
async function streamChatTurn(message) {
  saveProjectChatPreference();
  if (!chatThreadId) await createChatThread();
  chatAbort = new AbortController(); chatTurnId = null; chatTurnUnread = false; chatUi.send.disabled = true; chatUi.stop.hidden = false; setChatStatus('Thinking…');
  const assistantBody = addChatMessage('assistant', ''); let assistantText = ''; let projectCreated = false;
  try {
    const requestTurn = () => fetch(`/api/chat/threads/${encodeURIComponent(chatThreadId)}/turns`, { method: 'POST', signal: chatAbort.signal, headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', 'x-ok-workbench-csrf': chatCsrf }, body: JSON.stringify({ message, provider: chatUi.provider.value, model: chatUi.model.value, effort: chatUi.effort.value, titleProvider: chatSettings.titleProvider, titleModel: chatSettings.titleModel, titleEffort: chatSettings.titleEffort }) });
    let response = await requestTurn();
    if (await invalidChatToken(response)) { await refreshChatCsrf(); response = await requestTurn(); }
    if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error || 'Could not start chat turn');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffered = '';
    for (;;) { const { value, done } = await reader.read(); if (done) break; buffered += decoder.decode(value, { stream: true }); const lines = buffered.split('\n'); buffered = lines.pop(); for (const line of lines) { if (!line) continue; const event = JSON.parse(line); if (event.type === 'turn.started') chatTurnId = event.turn_id || null; else if (event.type === 'message.delta') { assistantText += event.delta || ''; renderAssistantMarkdown(assistantBody, assistantText); scrollChatToLatest(); if (chatSettings.collapsed && !chatTurnUnread) { chatTurnUnread = true; chatUnread++; applyChatLayout(); } } else if (event.type === 'tool.completed') { const activity = document.createElement('p'); activity.className = 'chat-tool-activity'; if (event.tool === 'create_project' && event.result?.location) { projectCreated = true; activity.append('Created project: '); const link = document.createElement('a'); link.href = event.result.location; link.textContent = event.result.title || event.result.id || event.result.location; activity.append(link); } else activity.textContent = `Used ${event.tool || 'workspace tool'}`; chatUi.messages.append(activity); scrollChatToLatest(); } else if (event.type === 'scope.granted') { const activity = document.createElement('p'); activity.className = 'chat-tool-activity'; activity.textContent = `Attached ${event.grants?.map(grant => `@${grant.project}/${grant.path}`).join(', ') || 'project context'}`; chatUi.messages.append(activity); scrollChatToLatest(); } else if (event.type === 'turn.failed') throw new Error(event.error || 'Turn failed'); else if (event.type === 'workspace.changed') { refreshGitStatus(); reloadChangedDocument(event); } else if (event.type === 'usage.updated') setChatStatus(event.usage || 'Working…'); } }
    if (!assistantText) { renderAssistantMarkdown(assistantBody, 'No response returned.'); scrollChatToLatest(); }
    setChatStatus('Ready'); if (projectCreated) await loadPage(); else await loadChatThreads();
  } catch (error) { assistantBody.parentElement.classList.add('error'); assistantBody.parentElement.querySelector('.message-meta').textContent = 'Error'; assistantBody.textContent = error.name === 'AbortError' ? 'Stopped.' : error.message; setChatStatus(error.name === 'AbortError' ? 'Stopped' : 'Error'); }
  finally { chatAbort = null; chatTurnId = null; chatUi.send.disabled = false; chatUi.stop.hidden = true; }
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
chatUi.titleModel.addEventListener('change', () => { const model = titleModels.find(item => titleModelKey(item) === chatUi.titleModel.value); if (!model) return; chatSettings.titleProvider = model.provider; chatSettings.titleModel = model.id; loadTitleEfforts(chatSettings.titleEffort); persistChatSettings(); });
chatUi.titleEffort.addEventListener('change', () => { chatSettings.titleEffort = chatUi.titleEffort.value; persistChatSettings(); });
chatUi.codexLogin.addEventListener('click', () => signInToProvider('openai-codex'));
chatUi.copilotLogin.addEventListener('click', () => signInToProvider('github-copilot'));
chatUi.newThread.addEventListener('click', () => createChatThread().catch(error => setChatStatus(error.message)));
chatUi.thread.addEventListener('change', () => loadChatThread(chatUi.thread.value).catch(error => setChatStatus(error.message)));
chatUi.composer.addEventListener('submit', event => { event.preventDefault(); const message = chatUi.input.value.trim(); if (!message || chatAbort) return; chatUi.input.value = ''; addChatMessage('user', message); streamChatTurn(message); });
chatUi.input.addEventListener('keydown', event => { if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return; event.preventDefault(); chatUi.composer.requestSubmit(); });
chatUi.stop.addEventListener('click', () => cancelChatTurn());
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
