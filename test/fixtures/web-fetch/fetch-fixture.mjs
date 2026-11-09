export function createWebFetchBudget() { return { attempts: 0, requests: 0, bytes: 0 }; }
export async function fetchWebPage(params, { signal, budget, confirmRequest }) {
  budget.attempts++;
  if (!confirmRequest) throw new Error('CONFIRMATION_REQUIRED: Interactive confirmation is required');
  if (params.url.includes('failure')) throw new Error('NETWORK_ERROR: Web request failed');
  if (params.url === 'not-a-url') throw new Error('INVALID_ARGUMENT: Invalid web fetch URL');
  await confirmRequest({ url: params.url, hop: 0, signal });
  return { url: params.url, final_url: 'https://other.example.net/final?private=1', status: 200, content_type: 'text/plain', title: null, text: 'fixture content', truncated: false, fetched_at: '2026-11-09T12:00:00.000Z', untrusted: true };
}
