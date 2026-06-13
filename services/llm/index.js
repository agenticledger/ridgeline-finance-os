const { ClaudeProvider } = require('./claudeProvider');
const { OpenAIProvider } = require('./openaiProvider');
const { GeminiProvider } = require('./geminiProvider');
const { AVAILABLE_MODELS } = require('./types');

const providers = {
  anthropic: new ClaudeProvider(),
  openai: new OpenAIProvider(),
  google: new GeminiProvider(),
};

function getProviderForModel(model) {
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return providers.openai;
  if (model.startsWith('gemini-')) return providers.google;
  return providers.anthropic;
}

function getProviderByName(name) {
  const p = providers[name];
  if (!p) throw new Error(`Unknown LLM provider: ${name}`);
  return p;
}

module.exports = { getProviderForModel, getProviderByName, AVAILABLE_MODELS };
