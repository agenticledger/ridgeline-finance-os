const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-6', provider: 'anthropic', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', provider: 'anthropic', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', label: 'Claude Haiku 4.5' },
  { id: 'gpt-4o', provider: 'openai', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', provider: 'openai', label: 'GPT-4o Mini' },
  { id: 'o3-mini', provider: 'openai', label: 'o3-mini' },
  { id: 'gemini-2.5-pro', provider: 'google', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', provider: 'google', label: 'Gemini 2.5 Flash' },
];

module.exports = { AVAILABLE_MODELS };
