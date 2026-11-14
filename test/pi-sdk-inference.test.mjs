import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const adapter = async name => import(pathToFileURL(resolve(`node_modules/@earendil-works/pi-ai/dist/api/${name}.js`)));
const context = { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] };
const model = api => ({ id: 'gemini-test', api, provider: api, name: 'test', baseUrl: 'https://example.invalid/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 });
const body = 'data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } }) + '\n\n';

for (const api of ['google-generative-ai', 'google-vertex']) {
  test(`${api} observes physical fetches, usage, and retry lineage`, async () => {
    const { stream } = await adapter(api);
    const original = globalThis.fetch;
    const starts = [], finishes = [], usage = [];
    let dispatches = 0;
    globalThis.fetch = async () => {
      dispatches++;
      if (dispatches === 1) return new Response(JSON.stringify({ error: { code: 503, message: 'retry', status: 'UNAVAILABLE' } }), { status: 503 });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const result = await stream(model(api), context, {
        apiKey: 'test-key', maxRetries: 1, maxRetryDelayMs: 1,
        onInferenceAttempt: async metadata => {
          starts.push(metadata);
          return { requestId: `request-${starts.length}`, onUsage: async value => usage.push(value), onFinish: async value => finishes.push(value.status) };
        },
      }).result();
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      assert.equal(dispatches, 2);
      assert.equal(starts.length, dispatches);
      assert.equal(starts[1].retryOfRequestId, 'request-1');
      assert.deepEqual(finishes, ['failed', 'completed']);
      assert.equal(usage.at(-1).format, 'google');
      assert.equal(usage.at(-1).usage.totalTokenCount, 7);
    } finally { globalThis.fetch = original; }
  });
  test(`${api} stops before dispatch when accounting rejects`, async () => {
    const { stream } = await adapter(api);
    const original = globalThis.fetch;
    let dispatches = 0;
    globalThis.fetch = async () => { dispatches++; throw new Error('unexpected'); };
    try {
      const result = await stream(model(api), context, { apiKey: 'test-key', maxRetries: 2, onInferenceAttempt: async () => { throw new Error('storage failed'); } }).result();
      assert.equal(dispatches, 0);
      assert.equal(result.usageAccountingFailure, true);
    } finally { globalThis.fetch = original; }
  });
}

test('bedrock records a failed physical request and blocks rejected starts', async () => {
  const { NodeHttp2Handler } = await import('@smithy/node-http-handler');
  const { Readable } = await import('node:stream');
  const { stream } = await adapter('bedrock-converse-stream');
  const original = NodeHttp2Handler.prototype.handle;
  let dispatches = 0;
  NodeHttp2Handler.prototype.handle = async () => {
    dispatches++;
    return { response: { statusCode: 400, headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' }, body: Readable.from(['{"message":"invalid"}']) } };
  };
  const bedrockModel = { ...model('bedrock-converse-stream'), id: 'example-model', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' };
  const common = { region: 'us-east-1', env: { AWS_BEDROCK_SKIP_AUTH: '1' } };
  try {
    const finishes = [];
    const result = await stream(bedrockModel, context, { ...common, onInferenceAttempt: async () => ({ onFinish: async ({ status }) => finishes.push(status) }) }).result();
    assert.equal(result.stopReason, 'error');
    assert.equal(dispatches, 1);
    assert.deepEqual(finishes, ['failed']);
    const rejected = await stream(bedrockModel, context, { ...common, onInferenceAttempt: async () => { throw new Error('storage failed'); } }).result();
    assert.equal(dispatches, 1);
    assert.equal(rejected.usageAccountingFailure, true);
  } finally { NodeHttp2Handler.prototype.handle = original; }
});

test('Google SDK internal retries are separate physical attempts', async () => {
  const { stream } = await adapter('google-generative-ai');
  const original = globalThis.fetch;
  let dispatches = 0;
  const starts = [], statuses = [];
  globalThis.fetch = async () => ++dispatches === 1
    ? new Response('{"error":{"code":503,"message":"retry","status":"UNAVAILABLE"}}', { status: 503 })
    : new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await stream(model('google-generative-ai'), context, {
      apiKey: 'test-key', maxRetries: 0,
      onPayload: params => ({ ...params, config: { ...params.config, httpOptions: { retryOptions: { attempts: 2, initialDelay: 0, maxDelay: 0, jitter: 0 } } } }),
      onInferenceAttempt: async metadata => {
        starts.push(metadata);
        return { requestId: `sdk-${starts.length}`, onFinish: async ({ status }) => statuses.push(status) };
      },
    }).result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(dispatches, 2);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].retryOfRequestId, 'sdk-1');
    assert.deepEqual(statuses, ['failed', 'completed']);
  } finally { globalThis.fetch = original; }
});

test('Bedrock SDK retries each create a new attempt', async () => {
  const { NodeHttp2Handler } = await import('@smithy/node-http-handler');
  const { Readable } = await import('node:stream');
  const { stream } = await adapter('bedrock-converse-stream');
  const original = NodeHttp2Handler.prototype.handle;
  const previousMaxAttempts = process.env.AWS_MAX_ATTEMPTS;
  process.env.AWS_MAX_ATTEMPTS = '2';
  let dispatches = 0;
  const starts = [], statuses = [];
  NodeHttp2Handler.prototype.handle = async () => {
    dispatches++;
    return { response: { statusCode: dispatches === 1 ? 500 : 400, headers: { 'content-type': 'application/json', 'x-amzn-errortype': dispatches === 1 ? 'InternalServerException' : 'ValidationException' }, body: Readable.from(['{"message":"failure"}']) } };
  };
  try {
    const bedrockModel = { ...model('bedrock-converse-stream'), id: 'example-model', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' };
    const result = await stream(bedrockModel, context, { region: 'us-east-1', env: { AWS_BEDROCK_SKIP_AUTH: '1' }, onInferenceAttempt: async metadata => {
      starts.push(metadata);
      return { requestId: `aws-${starts.length}`, onFinish: async ({ status }) => statuses.push(status) };
    } }).result();
    assert.equal(result.stopReason, 'error');
    assert.equal(dispatches, 2);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].retryOfRequestId, 'aws-1');
    assert.deepEqual(statuses, ['failed', 'failed']);
  } finally {
    NodeHttp2Handler.prototype.handle = original;
    if (previousMaxAttempts === undefined) delete process.env.AWS_MAX_ATTEMPTS;
    else process.env.AWS_MAX_ATTEMPTS = previousMaxAttempts;
  }
});

test('Bedrock successful event stream checkpoints provider usage', async () => {
  const { NodeHttp2Handler } = await import('@smithy/node-http-handler');
  const { EventStreamCodec } = await import('@smithy/core/event-streams');
  const { Readable } = await import('node:stream');
  const { stream } = await adapter('bedrock-converse-stream');
  const original = NodeHttp2Handler.prototype.handle;
  const codec = new EventStreamCodec(value => Buffer.from(value).toString(), value => Buffer.from(value));
  const event = (type, payload) => codec.encode({ headers: {
    ':message-type': { type: 'string', value: 'event' },
    ':event-type': { type: 'string', value: type },
    ':content-type': { type: 'string', value: 'application/json' },
  }, body: Buffer.from(JSON.stringify(payload)) });
  NodeHttp2Handler.prototype.handle = async () => ({ response: { statusCode: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' }, body: Readable.from([
    event('messageStart', { role: 'assistant' }),
    event('metadata', { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }),
    event('messageStop', { stopReason: 'end_turn' }),
  ]) } });
  const usages = [], statuses = [];
  try {
    const bedrockModel = { ...model('bedrock-converse-stream'), id: 'example-model', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' };
    const result = await stream(bedrockModel, context, { region: 'us-east-1', env: { AWS_BEDROCK_SKIP_AUTH: '1' }, onInferenceAttempt: async () => ({ onUsage: async value => usages.push(value), onFinish: async ({ status }) => statuses.push(status) }) }).result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(usages[0].format, 'bedrock');
    assert.equal(usages[0].usage.totalTokens, 7);
    assert.deepEqual(statuses, ['completed']);
  } finally { NodeHttp2Handler.prototype.handle = original; }
});

for (const api of ['google-generative-ai', 'google-vertex']) {
  test(`${api} preserves no-hook behavior and records abort`, async () => {
    const { stream } = await adapter(api);
    const original = globalThis.fetch;
    let dispatches = 0;
    globalThis.fetch = async () => { dispatches++; return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); };
    try {
      const plain = await stream(model(api), context, { apiKey: 'test-key' }).result();
      assert.equal(plain.stopReason, 'stop', plain.errorMessage);
      const controller = new AbortController();
      const statuses = [];
      globalThis.fetch = async () => { dispatches++; controller.abort(); const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
      const aborted = await stream(model(api), context, { apiKey: 'test-key', signal: controller.signal, maxRetries: 2,
        onInferenceAttempt: async () => ({ onFinish: async ({ status }) => statuses.push(status) }) }).result();
      assert.equal(aborted.stopReason, 'aborted');
      assert.equal(dispatches, 2);
      assert.deepEqual(statuses, ['aborted']);
    } finally { globalThis.fetch = original; }
  });
  for (const stage of ['onUsage', 'onFinish']) {
    test(`${api} stops after rejected ${stage}`, async () => {
      const { stream } = await adapter(api);
      const original = globalThis.fetch;
      let dispatches = 0, starts = 0;
      globalThis.fetch = async () => { dispatches++; return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); };
      try {
        const result = await stream(model(api), context, { apiKey: 'test-key', maxRetries: 3,
          onInferenceAttempt: async () => { starts++; return { [stage]: async () => { throw new Error('storage failed'); } }; } }).result();
        assert.equal(result.usageAccountingFailure, true);
        assert.equal(dispatches, 1);
        assert.equal(starts, 1);
      } finally { globalThis.fetch = original; }
    });
  }
}

test('Bedrock strict-tool fallback counts both physical requests', async () => {
  const { NodeHttp2Handler } = await import('@smithy/node-http-handler');
  const { EventStreamCodec } = await import('@smithy/core/event-streams');
  const { Readable } = await import('node:stream');
  const { stream } = await adapter('bedrock-converse-stream');
  const original = NodeHttp2Handler.prototype.handle;
  const codec = new EventStreamCodec(value => Buffer.from(value).toString(), value => Buffer.from(value));
  const event = (type, payload) => codec.encode({ headers: { ':message-type': { type: 'string', value: 'event' }, ':event-type': { type: 'string', value: type }, ':content-type': { type: 'string', value: 'application/json' } }, body: Buffer.from(JSON.stringify(payload)) });
  let dispatches = 0;
  NodeHttp2Handler.prototype.handle = async () => {
    dispatches++;
    if (dispatches === 1) return { response: { statusCode: 400, headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' }, body: Readable.from(['{"message":"The compiled grammar is too large"}']) } };
    return { response: { statusCode: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' }, body: Readable.from([event('messageStart', { role: 'assistant' }), event('messageStop', { stopReason: 'end_turn' })]) } };
  };
  const statuses = [], starts = [];
  try {
    const bedrockModel = { ...model('bedrock-converse-stream'), id: 'example-model', compat: { supportsStrictMode: true }, baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' };
    const toolContext = { messages: [{ role: 'system', content: 'test', timestamp: 1, toolsAdded: [{ name: 'tool', description: 'test', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] }, ...context.messages] };
    const result = await stream(bedrockModel, toolContext, { region: 'us-east-1', env: { AWS_BEDROCK_SKIP_AUTH: '1' }, onInferenceAttempt: async metadata => { starts.push(metadata); return { requestId: `strict-${starts.length}`, onFinish: async ({ status }) => statuses.push(status) }; } }).result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(dispatches, 2);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].retryOfRequestId, 'strict-1');
    assert.deepEqual(statuses, ['failed', 'completed']);
  } finally { NodeHttp2Handler.prototype.handle = original; }
});

test('Bedrock preserves no-hook behavior and records abort', async () => {
  const { NodeHttp2Handler } = await import('@smithy/node-http-handler');
  const { Readable } = await import('node:stream');
  const { stream } = await adapter('bedrock-converse-stream');
  const original = NodeHttp2Handler.prototype.handle;
  let dispatches = 0;
  NodeHttp2Handler.prototype.handle = async () => { dispatches++; return { response: { statusCode: 400, headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' }, body: Readable.from(['{"message":"invalid"}']) } }; };
  const bedrockModel = { ...model('bedrock-converse-stream'), id: 'example-model', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' };
  const common = { region: 'us-east-1', env: { AWS_BEDROCK_SKIP_AUTH: '1' } };
  try {
    const plain = await stream(bedrockModel, context, common).result();
    assert.equal(plain.stopReason, 'error');
    assert.match(plain.errorMessage, /invalid/);
    const controller = new AbortController(), statuses = [];
    NodeHttp2Handler.prototype.handle = async () => { dispatches++; controller.abort(); const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
    const aborted = await stream(bedrockModel, context, { ...common, signal: controller.signal, onInferenceAttempt: async () => ({ onFinish: async ({ status }) => statuses.push(status) }) }).result();
    assert.equal(aborted.stopReason, 'aborted');
    assert.equal(dispatches, 2);
    assert.deepEqual(statuses, ['aborted']);
  } finally { NodeHttp2Handler.prototype.handle = original; }
});

test('Google SDK retry stops when a failure checkpoint rejects with retryable metadata', async () => {
  const { stream } = await adapter('google-generative-ai');
  const original = globalThis.fetch;
  let dispatches = 0;
  globalThis.fetch = async () => { dispatches++; return new Response('{"error":{"code":503,"message":"retry","status":"UNAVAILABLE"}}', { status: 503 }); };
  try {
    const accountingError = Object.assign(new Error('storage failed'), { usageAccountingFailure: true, status: 503, headers: new Headers() });
    const result = await stream(model('google-generative-ai'), context, { apiKey: 'test-key', maxRetries: 3,
      onPayload: params => ({ ...params, config: { ...params.config, httpOptions: { retryOptions: { attempts: 3, initialDelay: 0, maxDelay: 0, jitter: 0 } } } }),
      onInferenceAttempt: async () => ({ onFinish: async () => { throw accountingError; } }),
    }).result();
    assert.equal(result.usageAccountingFailure, true);
    assert.equal(dispatches, 1);
  } finally { globalThis.fetch = original; }
});

test('Bedrock does not retry accounting failures carrying retryable metadata', async () => {
  const { NodeHttp2Handler } = await import('@smithy/node-http-handler');
  const { StandardRetryStrategy } = await import('@smithy/core/retry');
  const { Readable } = await import('node:stream');
  const { stream } = await adapter('bedrock-converse-stream');
  const handle = NodeHttp2Handler.prototype.handle;
  const refresh = StandardRetryStrategy.prototype.refreshRetryTokenForRetry;
  const previousMaxAttempts = process.env.AWS_MAX_ATTEMPTS;
  process.env.AWS_MAX_ATTEMPTS = '2';
  let dispatches = 0, retryDecisions = 0;
  NodeHttp2Handler.prototype.handle = async () => { dispatches++; return { response: { statusCode: 500, headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'InternalServerException' }, body: Readable.from(['{"message":"failure"}']) } }; };
  StandardRetryStrategy.prototype.refreshRetryTokenForRetry = async function (...args) { retryDecisions++; return refresh.apply(this, args); };
  try {
    const bedrockModel = { ...model('bedrock-converse-stream'), id: 'example-model', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' };
    const accountingError = Object.assign(new Error('storage failed'), { usageAccountingFailure: true, $metadata: { httpStatusCode: 503 } });
    const result = await stream(bedrockModel, context, { region: 'us-east-1', env: { AWS_BEDROCK_SKIP_AUTH: '1' }, onInferenceAttempt: async () => ({ onFinish: async () => { throw accountingError; } }) }).result();
    assert.equal(result.usageAccountingFailure, true);
    assert.equal(dispatches, 1);
    assert.ok(retryDecisions <= 1, `AWS reconsidered the accounting failure ${retryDecisions} times`);
  } finally {
    NodeHttp2Handler.prototype.handle = handle;
    StandardRetryStrategy.prototype.refreshRetryTokenForRetry = refresh;
    if (previousMaxAttempts === undefined) delete process.env.AWS_MAX_ATTEMPTS;
    else process.env.AWS_MAX_ATTEMPTS = previousMaxAttempts;
  }
});

test('Bedrock credential resolution failure does not start an inference attempt', async () => {
  const { NodeHttp2Handler } = await import('@smithy/node-http-handler');
  const { stream } = await adapter('bedrock-converse-stream');
  const handle = NodeHttp2Handler.prototype.handle;
  const names = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_EC2_METADATA_DISABLED', 'AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  process.env.AWS_PROFILE = 'workbench-no-such-profile';
  process.env.AWS_SHARED_CREDENTIALS_FILE = '/tmp/workbench-no-such-credentials-file';
  process.env.AWS_CONFIG_FILE = '/tmp/workbench-no-such-config-file';
  let starts = 0, dispatches = 0;
  NodeHttp2Handler.prototype.handle = async () => { dispatches++; throw new Error('unexpected dispatch'); };
  try {
    const bedrockModel = { ...model('bedrock-converse-stream'), id: 'example-model', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' };
    const result = await stream(bedrockModel, context, { region: 'us-east-1', profile: 'workbench-no-such-profile', onInferenceAttempt: async () => { starts++; } }).result();
    assert.equal(result.stopReason, 'error');
    assert.equal(starts, 0);
    assert.equal(dispatches, 0);
  } finally {
    NodeHttp2Handler.prototype.handle = handle;
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
});
