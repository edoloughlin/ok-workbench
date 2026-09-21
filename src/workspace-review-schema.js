'use strict';

const crypto = require('node:crypto');

const PRIORITIES = new Set(['focus', 'next', 'maintain', 'parked']);
const TRAJECTORIES = new Set(['on_course', 'watch', 'at_risk', 'drifting', 'unknown']);
const LIFECYCLES = new Set(['active', 'waiting', 'parked', 'complete', 'unknown']);
const URGENCIES = new Set(['now', 'soon', 'watch']);
const CADENCES = new Set(['daily', 'weekly', 'monthly']);
const ISSUE_KINDS = new Set(['decision', 'blocker', 'deadline', 'drift', 'prevent_drift', 'update', 'allocation']);
const priorityOrder = { focus: 0, next: 1, maintain: 2, parked: 3 };
const urgencyOrder = { now: 0, soon: 1, watch: 2 };

function error(message, code = 'INVALID_REVIEW') { const value = new Error(message); value.code = code; return value; }
function plain(value, name, max, { nullable = false, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw error(`${name} must be a string`);
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw error(`${name} must be 1 to ${max} plain-text characters`);
  return text;
}
function firstStep(value) { const text = plain(value, 'firstStep', 140); if (/^(?:work on|make progress(?: on)?|advance|continue|address|handle|review)(?:\s+(?:the|this|it|project|work))*[.!]?$/i.test(text) || /(?:;|\bthen\b|\band\b|\bafter that\b)/i.test(text)) throw error(`firstStep must be one concrete, startable action: ${JSON.stringify(text)} is either a vague directive or chains steps; rewrite it as one short imperative clause naming a single physical action, without "and", "then", ";", or "after that"`); return text; }
function enumValue(value, values, name) { if (!values.has(value)) throw error(`${name} is invalid`); return value; }
function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(`${name} must be an object`); return value; }
function array(value, name, max, min = 0) { if (!Array.isArray(value) || value.length < min || value.length > max) throw error(`${name} must contain ${min} to ${max} items`); return value; }
function exactKeys(value, keys, name) { for (const key of Object.keys(value)) if (!keys.has(key)) throw error(`${name} has unsupported field ${key}`); }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function stableIssueId(item, source) { return hash([item.projectId, item.kind, source?.path || '', source?.heading || item.topic || ''].join('\0')).slice(0, 32); }
function validDate(value, name) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) throw error(`${name} must be an ISO calendar date`); return value; }
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
function claimEvidence(value, sourceMap, allowed = new Set(['waiting', 'parked', 'complete', 'improvement', 'consequence'])) {
  if (value === undefined) return undefined;
  return array(value, 'claimEvidence', 3).map(item => {
    exactKeys(object(item, 'claimEvidence item'), new Set(['claim', 'sourceId', 'excerpt']), 'claimEvidence item');
    if (!allowed.has(item.claim) || !sourceMap.has(item.sourceId)) throw error('claimEvidence is invalid');
    const excerpt = plain(item.excerpt, 'claimEvidence excerpt', 300);
    const source = sourceMap.get(item.sourceId); if (source.generated || !source.excerpt || !source.excerpt.includes(excerpt)) throw error(`claimEvidence excerpt is not in its cited source (${JSON.stringify({ projectId: source.projectId, path: source.path })})`);
    return { claim: item.claim, sourceId: item.sourceId, excerpt };
  });
}
function validateReview(raw, { projects, sources }) {
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
    return { text: plain(item.text, 'change text', 300), evidenceIds: evidenceIds(item.evidenceIds, known, 'change evidenceIds', null, sourceMap), claimEvidence: claimEvidence(item.claimEvidence, sourceMap) || [] };
  });
  const ranks = new Set(); const assessed = new Set();
  if (!Array.isArray(data.projects) || data.projects.length !== projects.length) throw error(`projects must contain exactly ${projects.length} items; received ${Array.isArray(data.projects) ? data.projects.length : 'non-array'}`);
  result.projects = data.projects.map(item => {
    exactKeys(object(item, 'project assessment'), new Set(['projectId', 'priority', 'rank', 'priorityReason', 'confidence', 'trajectory', 'lifecycle', 'outcome', 'assessment', 'nextAction', 'blocker', 'cadence', 'cadenceReason', 'evidenceIds', 'claimEvidence']), 'project assessment');
    const projectId = plain(item.projectId, 'projectId', 80); if (!projectIds.has(projectId) || assessed.has(projectId)) throw error('project assessments must cover every collected project once'); assessed.add(projectId);
    if (!Number.isInteger(item.rank) || item.rank < 1 || ranks.has(item.rank)) throw error(`project ranks must be unique positive integers: rank ${JSON.stringify(item.rank)} for project ${JSON.stringify(projectId)} ${!Number.isInteger(item.rank) || item.rank < 1 ? 'is not a positive integer' : 'is already used by another project'}; assign one global ordering of distinct integers 1..${projects.length} across all projects, never restarting numbering within a priority tier`); ranks.add(item.rank);
    const lifecycle = enumValue(item.lifecycle, LIFECYCLES, 'lifecycle'); const claims = claimEvidence(item.claimEvidence, sourceMap) || [];
    if (lifecycle !== 'active' && lifecycle !== 'unknown' && !claims.some(claim => claim.claim === lifecycle)) throw error(`non-active lifecycle needs supporting claimEvidence for project ${JSON.stringify(projectId)}`);
    return { projectId, priority: enumValue(item.priority, PRIORITIES, 'priority'), rank: item.rank, priorityReason: plain(item.priorityReason, 'priorityReason', 400), confidence: enumValue(item.confidence, new Set(['high', 'medium', 'low']), 'confidence'), trajectory: enumValue(item.trajectory, TRAJECTORIES, 'trajectory'), lifecycle, outcome: plain(item.outcome, 'outcome', 200), assessment: plain(item.assessment, 'assessment', 500), nextAction: item.nextAction === null ? null : plain(item.nextAction, 'nextAction', 300), blocker: item.blocker === null ? null : plain(item.blocker, 'blocker', 300), cadence: enumValue(item.cadence, CADENCES, 'cadence'), cadenceReason: plain(item.cadenceReason, 'cadenceReason', 200), evidenceIds: evidenceIds(item.evidenceIds, known, 'project evidenceIds', projectId, sourceMap), claimEvidence: claims };
  });
  result.attention = array(data.attention, 'attention', 10).map(item => {
    exactKeys(object(item, 'attention item'), new Set(['projectId', 'kind', 'topic', 'urgency', 'title', 'observation', 'inference', 'action', 'firstStep', 'evidenceIds', 'dueDate', 'dueDateEvidence', 'claimEvidence']), 'attention item');
    const projectId = plain(item.projectId, 'attention projectId', 80); if (!projectIds.has(projectId)) throw error('attention item has unknown project');
    const dueDate = item.dueDate === null ? null : validDate(item.dueDate, 'dueDate');
    if ((dueDate === null) !== (item.dueDateEvidence === null)) throw error('dueDate and dueDateEvidence must appear together');
    let dueDateEvidence = null;
    if (dueDate) { exactKeys(object(item.dueDateEvidence, 'dueDateEvidence'), new Set(['sourceId', 'excerpt']), 'dueDateEvidence'); const source = sourceMap.get(item.dueDateEvidence.sourceId); const excerpt = plain(item.dueDateEvidence.excerpt, 'dueDate excerpt', 300); if (!source || source.projectId !== projectId || !source.excerpt?.includes(excerpt) || !excerpt.includes(dueDate)) throw error('dueDateEvidence must cite the explicit date'); dueDateEvidence = { sourceId: item.dueDateEvidence.sourceId, excerpt }; }
    const sourceIds = evidenceIds(item.evidenceIds, known, 'attention evidenceIds', projectId, sourceMap);
    const source = sourceMap.get(sourceIds[0]); const resultItem = { projectId, kind: enumValue(item.kind, ISSUE_KINDS, 'kind'), topic: plain(item.topic, 'topic', 120), urgency: enumValue(item.urgency, URGENCIES, 'urgency'), title: plain(item.title, 'title', 140), observation: plain(item.observation, 'observation', 400), inference: plain(item.inference, 'inference', 400), action: plain(item.action, 'action', 300), firstStep: firstStep(item.firstStep), evidenceIds: sourceIds, dueDate, dueDateEvidence, claimEvidence: claimEvidence(item.claimEvidence, sourceMap) || [] };
    resultItem.id = stableIssueId(resultItem, source); resultItem.evidenceSignature = hash(sourceIds.map(id => sourceMap.get(id).hash || id).join('|') + `|${dueDate || ''}`).slice(0, 32); return resultItem;
  });
  if (data.question !== null) { const item = object(data.question, 'question'); exactKeys(item, new Set(['projectId', 'text', 'reason', 'options', 'evidenceIds']), 'question'); const projectId = item.projectId === null ? null : plain(item.projectId, 'question projectId', 80); if (projectId && !projectIds.has(projectId)) throw error('question project is unknown'); const options = array(item.options, 'question options', 3, 2).map(option => plain(option, 'question option', 100)); if (new Set(options).size !== options.length) throw error('question options must be distinct'); result.question = { projectId, text: plain(item.text, 'question text', 240), reason: plain(item.reason, 'question reason', 300), options, evidenceIds: evidenceIds(item.evidenceIds, known, 'question evidenceIds', projectId, sourceMap) }; }
  return result;
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

module.exports = { PRIORITIES, TRAJECTORIES, LIFECYCLES, URGENCIES, CADENCES, ISSUE_KINDS, priorityOrder, urgencyOrder, hash, stableIssueId, validateReview, effectivePriority, runway, publicReview, error };
