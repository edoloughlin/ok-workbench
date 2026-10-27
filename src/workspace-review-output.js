'use strict';

// Model-facing contract. Canonical stored reviews keep their existing shape.
const CONTRACT_VERSION = 1;
const NARRATIVE_FIELDS = Object.freeze({ headline: 160, summary: 600, outcome: 200, assessment: 500, blocker: 300, cadenceReason: 200, priorityReason: 400, title: 140, observation: 400, inference: 400, 'change text': 300, 'question text': 240, 'question reason': 300, 'question option': 100 });
const hardLimit = target => Math.min(4 * target, 4096);
const string = (max, narrative = null) => ({ type: 'string', minLength: 1, maxLength: narrative ? hardLimit(max) : Math.floor(max * 1.2), ...(narrative ? { displayTarget: max } : {}) });
const prose = name => string(NARRATIVE_FIELDS[name], name);
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const enumeration = values => ({ type: 'string', enum: values.split('|') });
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const id = string(80);
const ids = array({ type: 'string', minLength: 1, maxLength: 256 }, 8, 1);
const quote = object({ sourceId: { type: 'string', minLength: 1, maxLength: 256 }, excerpt: string(500) });
const claims = array(object({ claim: enumeration('waiting|parked|complete|improvement|consequence'), ...quote.properties }), 3);
const assessment = object({ projectId: id, confidence: enumeration('high|medium|low'), trajectory: enumeration('on_course|watch|at_risk|drifting|unknown'), lifecycle: enumeration('active|waiting|parked|complete|unknown'), outcome: prose('outcome'), assessment: prose('assessment'), nextAction: nullable(string(300)), blocker: nullable(prose('blocker')), cadence: enumeration('daily|weekly|monthly'), cadenceReason: prose('cadenceReason'), evidenceIds: ids, claimEvidence: claims });
const attention = stage => object({ projectId: id, kind: enumeration(`decision|blocker|deadline|drift|prevent_drift|update${stage === 'synthesis' ? '|allocation' : ''}`), topic: string(120), urgency: enumeration('now|soon|watch'), title: prose('title'), observation: prose('observation'), inference: prose('inference'), action: string(300), firstStep: string(140), evidenceIds: ids, dueDate: nullable({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), dueDateEvidence: nullable(quote), claimEvidence: claims });
const schemas = {
  project: object({ assessment, attentionCandidates: array(attention('project'), 3) }),
  synthesis: object({ headline: prose('headline'), summary: prose('summary'), focusProjectId: nullable(id), evidenceIds: ids, changes: array(object({ text: prose('change text'), evidenceIds: ids, claimEvidence: claims }), 3), priorities: array(object({ projectId: id, priority: enumeration('focus|next|maintain|parked'), priorityReason: prose('priorityReason') }), 20, 1), attention: array(attention('synthesis'), 3), question: nullable(object({ kind: enumeration('allocation|clarification'), projectId: nullable(id), text: prose('question text'), reason: prose('question reason'), options: array(prose('question option'), 3, 2), evidenceIds: ids })) })
};
function stageSchema(stage) { if (!schemas[stage]) throw new Error('Unknown review output stage'); return schemas[stage]; }
function toolName(stage) { return stage === 'project' ? 'submit_project_assessment' : 'submit_workspace_overview'; }
function toolDefinition(stage) { return { name: toolName(stage), description: 'Submit exactly one complete read-only review result. No side effects. All evidence and semantic rules still apply.', parameters: JSON.parse(JSON.stringify(stageSchema(stage), (key, value) => key === 'displayTarget' ? undefined : value)), constrainedSampling: false }; }
function contractPrompt(stage) { return `Output contract version ${CONTRACT_VERSION}. JSON Schema: ${JSON.stringify(stageSchema(stage))}. displayTarget is a preferred concise length, not a hard limit; maxLength is the hard limit. All required fields must appear. Never supply server-owned ranks; priorities array order is the global ranking, highest first.`; }
const RULES = Object.freeze({ TYPE: 'Use the required JSON type.', REQUIRED: 'Include every required field.', UNKNOWN_FIELD: 'Use only the declared fields.', LIMIT: 'Respect the hard field or collection limit.', ENUM: 'Use a declared enum value.', CONTROL_CHARACTER: 'Use plain text without control characters.', UNKNOWN_EVIDENCE_ID: 'Use distinct evidence IDs supplied to this stage and owned by the cited project.', EVIDENCE: 'Use exact original evidence, valid dates, matching lifecycle claims, and current project sources.', ACTION: 'Use one concrete startable action without chained steps.', FOCUS_NOT_CURRENT: 'Set focusProjectId to null or an ID in eligibility.focusProjectIds. Preserve priority overrides in priorities; they do not make stale assessments current.', STALE_EVIDENCE: 'Use only IDs in eligibility.evidenceIds for new synthesis citations, claims, and dates. Keep stale project assessments as context and preserve their priority overrides without citing their original sources.', MEMBERSHIP: 'Cover every selected project exactly once and choose focus only from current projects.', SCHEMA: 'Follow the complete stage contract and its cross-field rules.', JSON: 'Return exactly one complete JSON object without fences or surrounding prose.' });
function issue(path, code, extra = {}) { return { path, code, rule: RULES[code] || RULES.SCHEMA, ...extra }; }
function feedback(issues) {
  const result = { accepted: false, issues: [], truncated: false };
  for (const value of issues) {
    if (result.issues.length >= 20 || Buffer.byteLength(JSON.stringify({ ...result, issues: [...result.issues, value] })) > 8000) { result.truncated = true; break; }
    result.issues.push(value);
  }
  return result;
}
const SAFE_PATH_SEGMENTS = new Set(['assessment', 'attentionCandidates', 'priorities', 'changes', 'attention', 'question', ...Object.keys(assessment.properties), ...Object.keys(attention('synthesis').properties), ...Object.keys(schemas.synthesis.properties), 'text', 'reason', 'options', 'priority', 'priorityReason', 'claim', 'sourceId', 'excerpt']);
function safeIssues(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).filter(item => item && Object.hasOwn(RULES, item.code) && typeof item.path === 'string' && item.path.length <= 256 && (item.path === '' || (item.path.startsWith('/') && item.path.slice(1).split('/').every(part => SAFE_PATH_SEGMENTS.has(part) || /^\d{1,3}$/.test(part))))).map(({ path, code }) => ({ path, code }));
}
function outputError(issues, diagnostic = 'schema_mismatch') { const error = Object.assign(new Error('Review output failed validation'), { code: 'INVALID_REVIEW', validationDiagnostic: diagnostic, validationFeedback: feedback(issues) }); return error; }
function inspectOutput(stage, raw) {
  const issues = []; const warnings = [];
  function visit(schema, value, path) {
    if (issues.length > 20) return;
    if (schema.anyOf) { const choice = schema.anyOf.find(item => item.type === (value === null ? 'null' : typeof value)); if (!choice) { issues.push(issue(path, 'TYPE')); return; } return visit(choice, value, path); }
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (schema.type !== type) { issues.push(issue(path, 'TYPE')); return; }
    if (type === 'object') {
      if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) issues.push(issue(path, 'UNKNOWN_FIELD'));
      for (const [key, child] of Object.entries(schema.properties)) { const pointer = `${path}/${key}`; if (!Object.hasOwn(value, key)) issues.push(issue(pointer, 'REQUIRED')); else visit(child, value[key], pointer); }
    } else if (type === 'array') {
      if (value.length < schema.minItems || value.length > schema.maxItems) issues.push(issue(path, 'LIMIT', { limit: schema.maxItems, actual: value.length }));
      value.slice(0, schema.maxItems).forEach((item, index) => visit(schema.items, item, `${path}/${index}`));
    } else if (type === 'string') {
      const text = value.trim(); const length = [...text].length;
      if ((schema.minLength && length < schema.minLength) || (schema.maxLength && length > schema.maxLength)) issues.push(issue(path, 'LIMIT', { limit: schema.maxLength, actual: length }));
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) issues.push(issue(path, 'CONTROL_CHARACTER'));
      if ((schema.enum && !schema.enum.includes(value)) || (schema.pattern && !new RegExp(schema.pattern).test(value))) issues.push(issue(path, 'ENUM'));
      if (schema.displayTarget && length > schema.displayTarget) warnings.push({ path, code: 'DISPLAY_TARGET_EXCEEDED', target: schema.displayTarget, actual: length });
    }
  }
  visit(stageSchema(stage), raw, '');
  return { ...feedback(issues), accepted: issues.length === 0, warnings: warnings.slice(0, 100) };
}
function canonicalCandidate(stage, raw) { return stage === 'synthesis' ? { ...raw, priorities: raw.priorities.map((item, index) => ({ ...item, rank: index + 1 })) } : raw; }

// Protocol support is independent of login type and measured model quality.
// Unknown adapter/runtime families remain on text; exact failures are scoped to
// the endpoint/model/runtime tuple. Live evaluation is optional, not a switch.
const RESULT_TOOL_APIS = new Set(['openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages']);
function supportedProtocol(selection) {
  return selection.adapter === 'pi' && /^1\.4\./.test(selection.runtimeVersion || '') && typeof selection.model === 'string' && selection.model.length > 0 && RESULT_TOOL_APIS.has(String(selection.endpoint || '').split(':').at(-1));
}
function createCapabilityResolver(verified = []) {
  const unsupported = new Set();
  const key = value => JSON.stringify([value.adapter, value.endpoint, value.model, value.runtimeVersion]);
  const records = new Map(verified.filter(item => item.source).map(item => [key(item), item]));
  return {
    resolve(selection, override) {
      const record = records.get(key(selection));
      const resultTool = unsupported.has(key(selection)) ? 'unsupported' : record ? 'verified' : supportedProtocol(selection) ? 'supported' : 'unknown';
      return { resultTool, transport: override === 'json_text' ? 'json_text' : ['supported', 'verified'].includes(resultTool) ? 'result_tool' : 'json_text', source: record?.source || (resultTool === 'supported' ? 'Pi 1.4 protocol support; live model quality not measured' : null) };
    },
    markUnsupported(selection) { unsupported.add(key(selection)); }
  };
}
module.exports = { CONTRACT_VERSION, NARRATIVE_FIELDS, hardLimit, stageSchema, toolName, toolDefinition, contractPrompt, inspectOutput, canonicalCandidate, issue, feedback, safeIssues, outputError, supportedProtocol, createCapabilityResolver };
