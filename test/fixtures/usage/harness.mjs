export const piRuntimeVersion = 'test';
export async function refreshPiCatalog() {}
export async function configuredPiProviders() { return [{ id: 'openai', label: 'OpenAI', models: [{ id: 'fixture', label: 'Fixture' }] }]; }
export async function runPiTurn({ onInferenceAttempt, onSteerReady, onDelta, noWorkspaceTools }) {
  const attempt = await onInferenceAttempt({ provider: 'openai', model: 'fixture', attempt: 1 });
  if (!noWorkspaceTools) await new Promise(resolve => onSteerReady(async () => resolve()));
  await attempt.onUsage({ usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }, format: 'openai-completions' });
  await attempt.onFinish({ status: 'completed' }); onDelta('fixture response');
}
