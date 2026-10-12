// Extract local definition candidates once on the server; no workspace files or
// glossary text are sent to a model or an external service.
const ID = /^[A-Z]+-[0-9]+$/;
const MAX_ENTRIES = 500;
const MAX_DEFINITION = 1200;

function clean(value) {
  return value.trim().replace(/^\*\*(.+)\*\*$/, '$1').replace(/^`(.+)`$/, '$1').replace(/:$/, '').trim();
}
function plainDefinition(value) {
  return value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*]+)\*/g, (_match, a, b, c, d) => a || b || c || d)
    .replace(/[ \t]+\n/g, '\n').trim();
}
function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}
function termAndText(text, glossary) {
  const match = text.match(/^(?:\*\*([^*]+)\*\*|`([^`]+)`|([^:–—]+?))\s*(?:\s+[-–—]\s+|\s*:\s+)(.+)$/);
  if (match) return { key: clean(match[1] || match[2] || match[3]), definition: match[4].trim() };
  const id = text.match(/^([A-Z]+-[0-9]+)(?=\s|$)\s*(?:[-–—:]\s*)?(.*)$/);
  if (id) return { key: id[1], definition: id[2].trim() };
  const strong = text.match(/^(?:\*\*([^*]+)\*\*|`([^`]+)`)(?:\s+(.+))?$/);
  if (strong && (glossary || ID.test(clean(strong[1] || strong[2])))) return { key: clean(strong[1] || strong[2]), definition: (strong[3] || '').replace(/^[:–—-]\s*/, '').trim() };
  return null;
}
function documentDefinitions(markdown) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const entries = []; const sources = [];
  const known = new Set();
  let glossaryLevel = 0; let fence = null; let frontmatter = lines[0] === '---';
  const add = (candidate, line) => {
    if (!candidate) return;
    const key = clean(candidate.key);
    const definition = plainDefinition(candidate.definition);
    if (!key || key.length > 100 || !definition || !ID.test(key) && !glossaryLevel || entries.length >= MAX_ENTRIES) return;
    // First definition wins; ambiguous later definitions do not silently replace it.
    sources.push({ line, key });
    if (!known.has(key.toLowerCase())) {
      known.add(key.toLowerCase());
      entries.push({ key, definition: definition.slice(0, MAX_DEFINITION) });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (frontmatter) { if (i > 0 && line === '---') frontmatter = false; continue; }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null; continue; }
    if (marker) { fence = marker[1]; continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (/^(?:\d+(?:\.\d+)*[.)]?\s+)?(?:glossary|definitions)\s*$/i.test(heading[2].trim())) glossaryLevel = heading[1].length;
      else if (glossaryLevel && heading[1].length <= glossaryLevel) glossaryLevel = 0;
      continue;
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
        const cells = tableCells(lines[j]); const key = clean(cells[0]);
        if ((ID.test(key) || glossaryLevel) && cells.slice(1).some(Boolean)) add({ key, definition: cells.slice(1).filter(Boolean).join(' · ') }, j + 1);
        j++;
      }
      i = j - 1;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      const candidate = termAndText(bullet[1], Boolean(glossaryLevel));
      if (candidate && (ID.test(candidate.key) || glossaryLevel)) {
        const following = [];
        for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && following.length < 8; j++) following.push(lines[j].trim());
        add({ key: candidate.key, definition: [candidate.definition, ...following].filter(Boolean).join(' ') }, i + 1);
      }
    }
  }
  return { entries, sources };
}
module.exports = { documentDefinitions };
