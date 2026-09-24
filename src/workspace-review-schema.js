'use strict';

const crypto = require('node:crypto');

const PRIORITIES = new Set(['focus', 'next', 'maintain', 'parked']);
const TRAJECTORIES = new Set(['on_course', 'watch', 'at_risk', 'drifting', 'unknown']);
const LIFECYCLES = new Set(['active', 'waiting', 'parked', 'complete', 'unknown']);
const URGENCIES = new Set(['now', 'soon', 'watch']);
const CADENCES = new Set(['daily', 'weekly', 'monthly']);
const ISSUE_KINDS = new Set(['decision', 'blocker', 'deadline', 'drift', 'prevent_drift', 'update', 'allocation']);
const MAX_EVIDENCE_EXCERPT = 500;
const priorityOrder = { focus: 0, next: 1, maintain: 2, parked: 3 };
const urgencyOrder = { now: 0, soon: 1, watch: 2 };

function error(message, code = 'INVALID_REVIEW') { const value = new Error(message); value.code = code; return value; }
function plain(value, name, max, { nullable = false, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw error(`${name} must be a string`);
  const text = value.trim();
  const acceptedMax = Math.floor(max * 1.2);
  if (!text || text.length > acceptedMax || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw error(`${name} must be 1 to ${acceptedMax} plain-text characters (target ${max})`);
  return text;
}
// Verbs that, directly after "and", mark a second chained action. A bare
// "and" inside a heading or title ("Gaps and inconsistencies") is not a chain.
const CHAIN_VERBS = /\band\s+(?:open|read|write|send|email|mail|call|phone|message|ping|text|draft|update|edit|create|add|remove|delete|check|review|run|schedule|book|ask|reply|answer|post|move|rename|list|file|mark|close|confirm|verify|record|note|copy|paste|log|start|stop|finish|complete|set|pick|choose|decide|compare|merge|commit|push|deploy|test|fix|install|search|find|look|summari[sz]e|outline|rewrite|reword|reorder|archive|tag|assign|approve|reject|submit|request|order|pay|sign|upload|download|export|import|attach|link|share|publish|announce|notify|contact|meet|talk|discuss|visit|take|bring|put|place|clear|clean|sort|split|combine|scan|measure|count|estimate|plan|prepare|gather|collect|fill|enter|type|save|restore|reset|restart|turn|switch|enable|disable|toggle|apply|revert|print|walk|go|get|make|do|tell|show|explain|describe|report|follow|prioriti[sz]e|then)\b/i;
function firstStep(value) { const text = plain(value, 'firstStep', 140); const unquoted = text.replace(/"[^"]*"|\u201c[^\u201d]*\u201d|'[^']*'|`[^`]*`/g, '""'); if (/^(?:work on|make progress(?: on)?|advance|continue|address|handle|review)(?:\s+(?:the|this|it|project|work))*[.!]?$/i.test(text) || /(?:;|\bthen\b|\bafter that\b)/i.test(unquoted) || CHAIN_VERBS.test(unquoted)) throw error(`firstStep must be one concrete, startable action: ${JSON.stringify(text)} is either a vague directive or chains steps; rewrite it as one short imperative clause naming a single physical action, without "and", "then", ";", or "after that"`); return text; }
function enumValue(value, values, name) { if (!values.has(value)) throw error(`${name} is invalid`); return value; }
function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(`${name} must be an object`); return value; }
function array(value, name, max, min = 0) { if (!Array.isArray(value) || value.length < min || value.length > max) throw error(`${name} must contain ${min} to ${max} items`); return value; }
function exactKeys(value, keys, name) { for (const key of Object.keys(value)) if (!keys.has(key)) throw error(`${name} has unsupported field ${key}`); }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function stableIssueId(item, source) { return hash([item.projectId, item.kind, source?.path || '', source?.heading || item.topic || ''].join('\0')).slice(0, 32); }
function validDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw error(`${name} must be an ISO calendar date`);
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw error(`${name} must be a real ISO calendar date`);
  return value;
}
function evidenceIds(value, known, name, projectId, sourceMap) {
  const ids = array(value, name, 8, 1);
  const unique = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !known.has(id) || unique.has(id)) throw error(`${name} contains an unknown or duplicate source`);
    const source = sourceMap.get(id); if (projectId && source?.projectId && source.projectId !== projectId) throw error(`${name} cites another project's source`);
    unique.add(id);
  }
  return ids;
}
const CLAIM_KINDS = new Set(['waiting', 'parked', 'complete', 'improvement', 'consequence']);
function claimEvidence(value, sourceMap, allowed = CLAIM_KINDS) {
  if (value === undefined) return undefined;
  return array(value, 'claimEvidence', 3).map(item => {
    exactKeys(object(item, 'claimEvidence item'), new Set(['claim', 'sourceId', 'excerpt']), 'claimEvidence item');
    if (!allowed.has(item.claim)) throw error(`claimEvidence claim ${JSON.stringify(item.claim)} is invalid; claim must be one of ${[...allowed].join(', ')}, and claimEvidence must be an empty array when no such claim is made`);
    if (typeof item.sourceId !== 'string' || !sourceMap.has(item.sourceId)) throw error(`claimEvidence sourceId ${JSON.stringify(item.sourceId)} is not a supplied source id`);
    const excerpt = plain(item.excerpt, 'claimEvidence excerpt', MAX_EVIDENCE_EXCERPT);
    const source = sourceMap.get(item.sourceId); if (source.generated || !source.excerpt || !source.excerpt.includes(excerpt)) throw error(`claimEvidence excerpt is not in its cited source (${JSON.stringify({ projectId: source.projectId, path: source.path })})`);
    return { claim: item.claim, sourceId: item.sourceId, excerpt };
  });
}
function validateProjectAssessment(raw, { project, sources }) {
  const data = object(raw, 'project assessment');
  exactKeys(data, new Set(['projectId', 'confidence', 'trajectory', 'lifecycle', 'outcome', 'assessment', 'nextAction', 'blocker', 'cadence', 'cadenceReason', 'evidenceIds', 'claimEvidence']), 'project assessment');
  const projectId = plain(data.projectId, 'projectId', 80);
  if (projectId !== project.id) throw error(`project assessment must match requested project ${JSON.stringify(project.id)}`);
  const projectSources = sources.filter(source => source.projectId === project.id);
  if (!projectSources.length) throw error('project assessment has no project evidence');
  if (!Array.isArray(data.claimEvidence)) throw error('project assessment claimEvidence must be an array');
  const sourceMap = new Map(projectSources.map(source => [source.id, source]));
  const claims = claimEvidence(data.claimEvidence, sourceMap) || [];
  const ids = evidenceIds(data.evidenceIds, new Set(sourceMap.keys()), 'project evidenceIds', project.id, sourceMap);
  if (claims.some(claim => !ids.includes(claim.sourceId))) throw error('claimEvidence source must also appear in evidenceIds');
  const lifecycle = enumValue(data.lifecycle, LIFECYCLES, 'lifecycle');
  if (lifecycle !== 'active' && lifecycle !== 'unknown' && !claims.some(claim => claim.claim === lifecycle)) throw error(`non-active lifecycle needs supporting claimEvidence for project ${JSON.stringify(projectId)}`);
  return { projectId, confidence: enumValue(data.confidence, new Set(['high', 'medium', 'low']), 'confidence'), trajectory: enumValue(data.trajectory, TRAJECTORIES, 'trajectory'), lifecycle, outcome: plain(data.outcome, 'outcome', 200), assessment: plain(data.assessment, 'assessment', 500), nextAction: data.nextAction === null ? null : plain(data.nextAction, 'nextAction', 300), blocker: data.blocker === null ? null : plain(data.blocker, 'blocker', 300), cadence: enumValue(data.cadence, CADENCES, 'cadence'), cadenceReason: plain(data.cadenceReason, 'cadenceReason', 200), evidenceIds: ids, claimEvidence: claims };
}
function validateAttentionItem(raw, { projectIds, sourceMap, known, allowedKinds = ISSUE_KINDS, allowGeneratedGap = false }) {
  exactKeys(object(raw, 'attention item'), new Set(['projectId', 'kind', 'topic', 'urgency', 'title', 'observation', 'inference', 'action', 'firstStep', 'evidenceIds', 'dueDate', 'dueDateEvidence', 'claimEvidence']), 'attention item');
  const projectId = plain(raw.projectId, 'attention projectId', 80);
  if (!projectIds.has(projectId)) throw error('attention item has unknown project');
  if (!Array.isArray(raw.claimEvidence)) throw error('attention item claimEvidence must be an array');
  const dueDate = raw.dueDate === null ? null : validDate(raw.dueDate, 'dueDate');
  if ((dueDate === null) !== (raw.dueDateEvidence === null)) throw error('dueDate and dueDateEvidence must appear together');
  let dueDateEvidence = null;
  if (dueDate) { exactKeys(object(raw.dueDateEvidence, 'dueDateEvidence'), new Set(['sourceId', 'excerpt']), 'dueDateEvidence'); const source = sourceMap.get(raw.dueDateEvidence.sourceId); const excerpt = plain(raw.dueDateEvidence.excerpt, 'dueDate excerpt', MAX_EVIDENCE_EXCERPT); if (!source || source.projectId !== projectId || source.generated || !source.excerpt?.includes(excerpt) || !excerpt.includes(dueDate)) throw error('dueDateEvidence must cite the explicit original project date'); dueDateEvidence = { sourceId: raw.dueDateEvidence.sourceId, excerpt }; }
  const sourceIds = evidenceIds(raw.evidenceIds, known, 'attention evidenceIds', projectId, sourceMap);
  const kind = enumValue(raw.kind, allowedKinds, 'kind');
  if (sourceIds.some(id => { const source = sourceMap.get(id); return source?.projectId !== projectId || (source?.generated && !(allowGeneratedGap && kind === 'update')); })) throw error('attention item must cite only its project original sources or an allowed generated evidence gap');
  const claims = claimEvidence(raw.claimEvidence, sourceMap) || [];
  if (claims.some(claim => !sourceIds.includes(claim.sourceId))) throw error('claimEvidence source must also appear in evidenceIds');
  const source = sourceMap.get(sourceIds[0]); const resultItem = { projectId, kind, topic: plain(raw.topic, 'topic', 120), urgency: enumValue(raw.urgency, URGENCIES, 'urgency'), title: plain(raw.title, 'title', 140), observation: plain(raw.observation, 'observation', 400), inference: plain(raw.inference, 'inference', 400), action: plain(raw.action, 'action', 300), firstStep: firstStep(raw.firstStep), evidenceIds: sourceIds, dueDate, dueDateEvidence, claimEvidence: claims };
  resultItem.id = stableIssueId(resultItem, source); resultItem.evidenceSignature = hash(sourceIds.map(id => sourceMap.get(id).hash || id).join('|') + `|${dueDate || ''}`).slice(0, 32);
  return resultItem;
}
function validateReview(raw, { projects, sources, allowGeneratedGap = false }) {
  const data = object(raw, 'review');
  exactKeys(data, new Set(['headline', 'summary', 'focusProjectId', 'evidenceIds', 'changes', 'projects', 'attention', 'question']), 'review');
  const projectIds = new Set(projects.map(project => project.id)); const sourceMap = new Map(sources.map(source => [source.id, source])); const known = new Set(sourceMap.keys());
  const result = {
    headline: plain(data.headline, 'headline', 160), summary: plain(data.summary, 'summary', 600),
    focusProjectId: data.focusProjectId === null ? null : plain(data.focusProjectId, 'focusProjectId', 80),
    evidenceIds: evidenceIds(data.evidenceIds, known, 'evidenceIds', null, sourceMap), changes: [], projects: [], attention: [], question: null
  };
  if (result.focusProjectId && !projectIds.has(result.focusProjectId)) throw error('focusProjectId is not a collected project');
  result.changes = array(data.changes, 'changes', 3).map(item => {
    exactKeys(object(item, 'change'), new Set(['text', 'evidenceIds', 'claimEvidence']), 'change');
    if (!Array.isArray(item.claimEvidence)) throw error('change claimEvidence must be an array');
    const ids = evidenceIds(item.evidenceIds, known, 'change evidenceIds', null, sourceMap); const claims = claimEvidence(item.claimEvidence, sourceMap) || [];
    if (claims.some(claim => !ids.includes(claim.sourceId))) throw error('claimEvidence source must also appear in evidenceIds');
    return { text: plain(item.text, 'change text', 300), evidenceIds: ids, claimEvidence: claims };
  });
  const ranks = new Set(); const assessed = new Set();
  if (!Array.isArray(data.projects) || data.projects.length !== projects.length) throw error(`projects must contain exactly ${projects.length} items; received ${Array.isArray(data.projects) ? data.projects.length : 'non-array'}`);
  result.projects = data.projects.map(item => {
    exactKeys(object(item, 'project assessment'), new Set(['projectId', 'priority', 'rank', 'priorityReason', 'confidence', 'trajectory', 'lifecycle', 'outcome', 'assessment', 'nextAction', 'blocker', 'cadence', 'cadenceReason', 'evidenceIds', 'claimEvidence']), 'project assessment');
    const projectId = plain(item.projectId, 'projectId', 80); if (!projectIds.has(projectId) || assessed.has(projectId)) throw error('project assessments must cover every collected project once'); assessed.add(projectId);
    if (!Number.isInteger(item.rank) || item.rank < 1 || ranks.has(item.rank)) throw error(`project ranks must be unique positive integers: rank ${JSON.stringify(item.rank)} for project ${JSON.stringify(projectId)} ${!Number.isInteger(item.rank) || item.rank < 1 ? 'is not a positive integer' : 'is already used by another project'}; assign one global ordering of distinct integers 1..${projects.length} across all projects, never restarting numbering within a priority tier`); ranks.add(item.rank);
    const { priority, rank, priorityReason, ...assessment } = item;
    return { ...validateProjectAssessment(assessment, { project: projects.find(project => project.id === projectId), sources }), priority: enumValue(priority, PRIORITIES, 'priority'), rank, priorityReason: plain(priorityReason, 'priorityReason', 400) };
  });
  result.attention = array(data.attention, 'attention', 10).map(item => validateAttentionItem(item, { projectIds, sourceMap, known, allowGeneratedGap }));
  if (data.question !== null) { const item = object(data.question, 'question'); exactKeys(item, new Set(['projectId', 'text', 'reason', 'options', 'evidenceIds', 'kind']), 'question'); const projectId = item.projectId === null ? null : plain(item.projectId, 'question projectId', 80); if (projectId && !projectIds.has(projectId)) throw error('question project is unknown'); const options = array(item.options, 'question options', 3, 2).map(option => plain(option, 'question option', 100)); if (new Set(options).size !== options.length) throw error('question options must be distinct'); const kind = item.kind === undefined ? 'clarification' : enumValue(item.kind, new Set(['allocation', 'clarification']), 'question kind'); const ids = evidenceIds(item.evidenceIds, known, 'question evidenceIds', projectId, sourceMap); if (ids.some(id => sourceMap.get(id)?.generated && !(allowGeneratedGap && kind === 'clarification'))) throw error('question may cite a generated evidence gap only for clarification'); result.question = { projectId, kind, text: plain(item.text, 'question text', 240), reason: plain(item.reason, 'question reason', 300), options, evidenceIds: ids }; }
  if (result.attention.filter(item => item.kind === 'allocation').length + Number(result.question?.kind === 'allocation') > 1) throw error('allocation evidence may support at most one allocation attention item or question');
  return result;
}
function validateProjectResult(raw, { project, sources }) {
  object(raw, 'project result'); exactKeys(raw, new Set(['assessment', 'attentionCandidates']), 'project result');
  const assessment = validateProjectAssessment(raw.assessment, { project, sources });
  const candidates = array(raw.attentionCandidates, 'attentionCandidates', 3);
  const projectSources = sources.filter(source => source.projectId === project.id);
  if (!projectSources.length) throw error('project result has no project evidence');
  const sourceMap = new Map(projectSources.map(source => [source.id, source])); const known = new Set(sourceMap.keys());
  const projectIds = new Set([project.id]); const allowedKinds = new Set([...ISSUE_KINDS].filter(kind => kind !== 'allocation'));
  const attentionCandidates = candidates.map(candidate => validateAttentionItem(candidate, { projectIds, sourceMap, known, allowedKinds }));
  return { assessment, attentionCandidates: attentionCandidates.map(({ id, evidenceSignature, ...candidate }) => candidate) };
}
function validateWorkspaceSynthesis(raw, { projects, sources, originalSources = sources, currentProjectIds = new Set(projects.map(project => project.id)) }) {
  object(raw, 'workspace synthesis');
  exactKeys(raw, new Set(['headline', 'summary', 'focusProjectId', 'evidenceIds', 'changes', 'priorities', 'attention', 'question']), 'workspace synthesis');
  const projectIds = new Set(projects.map(project => project.id));
  if (!Array.isArray(raw.priorities) || raw.priorities.length !== projects.length) throw error(`priorities must contain exactly ${projects.length} projects`);
  const byId = new Map(); const seen = new Set(); const ranks = new Set();
  for (const item of raw.priorities) {
    exactKeys(object(item, 'priority'), new Set(['projectId', 'priority', 'rank', 'priorityReason']), 'priority');
    const projectId = plain(item.projectId, 'priority projectId', 80);
    if (!projectIds.has(projectId) || seen.has(projectId)) throw error('priorities must cover each selected project once');
    if (!Number.isInteger(item.rank) || item.rank < 1 || item.rank > projects.length || ranks.has(item.rank)) throw error('priority ranks must be the distinct integers 1..N');
    seen.add(projectId); ranks.add(item.rank); byId.set(projectId, item);
  }
  if (raw.changes?.length > 3 || raw.attention?.length > 3) throw error('synthesis may contain at most three changes and three attention items');
  const ordered = [...projects].map(project => {
    const assessment = project.result.assessment;
    const priority = byId.get(project.id);
    return { ...assessment, projectId: project.id, priority: enumValue(priority.priority, PRIORITIES, 'priority'), rank: priority.rank, priorityReason: plain(priority.priorityReason, 'priorityReason', 400) };
  });
  const validated = validateReview({
    headline: raw.headline, summary: raw.summary, focusProjectId: raw.focusProjectId,
    evidenceIds: raw.evidenceIds, changes: raw.changes, projects: ordered,
    attention: raw.attention, question: raw.question
  }, { projects, sources, allowGeneratedGap: true });
  const originalMap = new Map(originalSources.map(source => [source.id, source]));
  for (const item of [...validated.changes, ...validated.attention, ...(validated.question ? [validated.question] : [])]) {
    if (item.claimEvidence?.some(claim => !originalMap.get(claim.sourceId)?.excerpt?.includes(claim.excerpt))) throw error('synthesis quote must also match the retained original source snapshot');
    if (item.dueDateEvidence && !originalMap.get(item.dueDateEvidence.sourceId)?.excerpt?.includes(item.dueDateEvidence.excerpt)) throw error('synthesis date quote must also match the retained original source snapshot');
  }
  if (validated.focusProjectId && !currentProjectIds.has(validated.focusProjectId)) throw error('focus must use a current project assessment');
  const currentSource = id => { const source = sources.find(item => item.id === id); return !source?.projectId || source.generated || currentProjectIds.has(source.projectId); };
  if (validated.evidenceIds.some(id => !currentSource(id))) throw error('synthesis cannot cite stale project evidence');
  for (const item of [...validated.changes, ...validated.attention, ...(validated.question ? [validated.question] : [])]) {
    if (item.evidenceIds.some(id => !currentSource(id))) throw error('synthesis cannot cite stale project evidence');
    if (item.claimEvidence?.some(claim => !currentSource(claim.sourceId))) throw error('synthesis cannot quote stale project evidence');
    if (item.dueDateEvidence && !currentSource(item.dueDateEvidence.sourceId)) throw error('synthesis cannot use a stale project date');
  }
  return validated;
}
function effectivePriority(assessment, controls, now = Date.now()) { const override = controls?.priorityOverrides?.[assessment.projectId]; if (override && (!override.expiresAt || Date.parse(override.expiresAt) > now)) return { priority: override.tier, source: 'user', override }; return { priority: assessment.priority, source: 'inferred', override: null }; }
function runway(dueDate, now = new Date(), timeZone = 'UTC') {
  if (!dueDate) return null;
  // A source date has no implied UTC time. Resolve its local end-of-day in the
  // saved workspace zone so it cannot become overdue during that local day.
  const [year, month, day] = dueDate.split('-').map(Number); const localEnd = Date.UTC(year, month - 1, day, 23, 59, 59);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(localEnd));
  const part = type => Number(parts.find(value => value.type === type)?.value || 0); const displayedAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  const target = new Date(localEnd - (displayedAsUtc - localEnd)); const nowParts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now); const nowPart = type => Number(nowParts.find(value => value.type === type)?.value || 0); const calendarDays = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(nowPart('year'), nowPart('month') - 1, nowPart('day'))) / 86400000); const overdue = target.getTime() < now.getTime(); const days = overdue ? -Math.max(1, Math.abs(calendarDays)) : calendarDays; const weekday = new Intl.DateTimeFormat('en-IE', { weekday: 'short', timeZone }).format(target);
  return { dueDate, days, label: overdue ? `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}` : calendarDays === 0 ? 'Due today' : calendarDays === 1 ? 'Due tomorrow' : `Due ${weekday} · ${calendarDays} days`, urgency: calendarDays <= 2 ? 'now' : calendarDays <= 7 ? 'soon' : null };
}
function publicReview(record, controls, { now = new Date(), timeZone = 'UTC' } = {}) {
  if (!record?.assessment) return null; const feedback = Object.values(controls?.issueFeedback || {}); const hidden = new Map(); for (const item of feedback) if (item?.issueId && item?.evidenceSignature) hidden.set(`${item.issueId}:${item.evidenceSignature}`, item);
  const projects = record.assessment.projects.map(item => { const effective = effectivePriority(item, controls, now.getTime()); return { ...item, effectivePriority: effective, effectiveLifecycle: effective.priority === 'parked' && effective.source === 'user' ? 'parked' : item.lifecycle }; });
  const priorityFor = id => projects.find(item => item.projectId === id)?.effectivePriority.priority || 'maintain';
  const withFeedback = record.assessment.attention.map(item => { const range = runway(item.dueDate, now, timeZone); const urgency = range?.urgency && urgencyOrder[range.urgency] < urgencyOrder[item.urgency] ? range.urgency : item.urgency; return { ...item, urgency, runway: range, feedback: hidden.get(`${item.id}:${item.evidenceSignature}`) || null }; });
  const deferred = withFeedback.filter(item => item.feedback?.action === 'snooze' && Date.parse(item.feedback.until) > now.getTime()).sort((a, b) => Date.parse(a.feedback.until) - Date.parse(b.feedback.until));
  const attention = withFeedback.filter(item => !item.feedback || item.feedback.action === 'strip_dismiss' || (item.feedback.action === 'snooze' && Date.parse(item.feedback.until) <= now.getTime()));
  attention.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency] || priorityOrder[priorityFor(a.projectId)] - priorityOrder[priorityFor(b.projectId)] || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) || a.id.localeCompare(b.id));
  projects.sort((a, b) => (['active', 'waiting'].includes(a.effectiveLifecycle) ? 0 : 1) - (['active', 'waiting'].includes(b.effectiveLifecycle) ? 0 : 1) || priorityOrder[a.effectivePriority.priority] - priorityOrder[b.effectivePriority.priority] || a.rank - b.rank || a.projectId.localeCompare(b.projectId));
  return { ...record, projects, attention, deferred };
}

module.exports = { PRIORITIES, TRAJECTORIES, LIFECYCLES, CLAIM_KINDS, URGENCIES, CADENCES, ISSUE_KINDS, priorityOrder, urgencyOrder, hash, canonicalJSON, stableIssueId, validateReview, validateProjectAssessment, validateProjectResult, validateWorkspaceSynthesis, effectivePriority, runway, publicReview, error };
