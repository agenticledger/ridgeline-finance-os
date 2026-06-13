const { Router } = require('express');
const prisma = require('../services/db');
const { requireAdmin } = require('../middleware/adminAuth');
const { encrypt, decrypt } = require('../services/encryption');

const router = Router();

const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'o3-mini', name: 'o3-mini' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    ],
  },
];

router.use(requireAdmin);

// GET /api/llm-config
router.get('/', async (req, res, next) => {
  try {
    const config = await prisma.llmConfig.findFirst({
      orderBy: { updatedAt: 'desc' },
    });

    const provider = config?.provider ?? 'anthropic';
    const apiKey = await prisma.llmApiKey.findUnique({
      where: { provider },
    });

    res.json({
      ok: true,
      data: {
        provider,
        model: config?.model ?? 'claude-sonnet-4-6',
        hasApiKey: !!apiKey,
        keyPrefix: apiKey?.keyPrefix ?? null,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/llm-config/providers
router.get('/providers', async (req, res, next) => {
  try {
    const storedKeys = await prisma.llmApiKey.findMany();
    const keyMap = new Map(storedKeys.map(k => [k.provider, k.keyPrefix]));

    const data = PROVIDERS.map(p => ({
      ...p,
      hasKey: keyMap.has(p.id),
      keyPrefix: keyMap.get(p.id) ?? null,
    }));

    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// PUT /api/llm-config
router.put('/', async (req, res, next) => {
  try {
    const { provider, model } = req.body;

    if (!provider || !model) {
      return res.status(400).json({ ok: false, error: 'provider and model are required' });
    }

    const validProviders = PROVIDERS.map(p => p.id);
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ ok: false, error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
    }

    await prisma.llmConfig.deleteMany({});
    const config = await prisma.llmConfig.create({
      data: { provider, model },
    });

    res.json({
      ok: true,
      data: { provider: config.provider, model: config.model },
    });
  } catch (err) { next(err); }
});

// PUT /api/llm-config/api-key
router.put('/api-key', async (req, res, next) => {
  try {
    const { provider, apiKey } = req.body;

    if (!provider || !apiKey) {
      return res.status(400).json({ ok: false, error: 'provider and apiKey are required' });
    }

    const encryptedKey = encrypt(apiKey);
    const keyPrefix = apiKey.slice(0, 8) + '...';

    await prisma.llmApiKey.upsert({
      where: { provider },
      update: { encryptedKey, keyPrefix },
      create: { provider, encryptedKey, keyPrefix },
    });

    res.json({ ok: true, data: { provider, keyPrefix } });
  } catch (err) { next(err); }
});

// DELETE /api/llm-config/api-key/:provider
router.delete('/api-key/:provider', async (req, res, next) => {
  try {
    await prisma.llmApiKey.deleteMany({
      where: { provider: req.params.provider },
    });

    res.json({ ok: true, data: null });
  } catch (err) { next(err); }
});

module.exports = router;
