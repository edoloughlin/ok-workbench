export const observations = [];
export class ModelRuntime {
  static async create() { return new ModelRuntime(); }
  async setRuntimeApiKey() {}
  getModel(provider, model) { return { id: model, provider, maxTokens: 4096 }; }
}
export class DefaultResourceLoader {
  constructor(options) { this.options = options; }
  async reload() {}
}
export const SettingsManager = { inMemory: options => options };
export const SessionManager = { inMemory: root => ({ root }) };
export const defineTool = definition => definition;
export async function createAgentSession(options) {
  const observation = { tools: options.customTools, loader: options.resourceLoader, calls: [] }; observations.push(observation);
  const session = {
    agent: {}, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {}, async steer() {},
    async prompt() {
      const tool = options.customTools.find(item => item.name === 'web_fetch');
      if (!tool) return;
      const signal = new AbortController().signal;
      for (const url of ['https://example.com/path?secret=1', 'https://example.com/failure?secret=2', 'not-a-url']) {
        try { observation.calls.push({ result: await tool.execute('tool-call', { url }, signal) }); }
        catch (error) { observation.calls.push({ error: error.message }); }
      }
    },
  };
  return { session };
}
