import { fetchWebPage, createWebFetchBudget } from '../../../dist/web-fetch.mjs';
export const piRuntimeVersion = 'test';
export async function refreshPiCatalog() {}
export async function configuredPiProviders() { return [{ id: 'openai', label: 'OpenAI', models: [{ id: 'fixture', label: 'Fixture' }] }]; }
export async function runPiTurn({ confirmWebFetch, signal, onDelta, onTool }) {
  const name = 'web_fetch';
  await onTool?.({ phase: 'started', name, targets: ['https://example.com'] });
  try {
    const result = await fetchWebPage({ url: 'https://example.com/path?token=visible' }, {
      budget: createWebFetchBudget(), signal,
      confirmRequest: request => confirmWebFetch('fixture-tool-call', request),
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: async () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('fixture source') }),
    });
    await onTool?.({ phase: 'completed', name, targets: ['https://example.com'], result });
    onDelta(result.text);
  } catch (error) {
    await onTool?.({ phase: 'failed', name, targets: ['https://example.com'], error: error.message });
    onDelta(error.message);
  }
}
