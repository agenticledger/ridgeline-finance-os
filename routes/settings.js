const { Router } = require('express');
const prisma = require('../services/db');
const { requireAdmin } = require('../middleware/adminAuth');
const { encrypt, decrypt } = require('../services/encryption');

const router = Router();

const SETTING_META = {
  RESEND_API_KEY: {
    label: 'Resend API Key',
    description: 'Used to send emails (contact form, notifications)',
  },
  BRAVE_SEARCH_API_KEY: {
    label: 'Brave Search API Key',
    description: 'Used by the agent for web search',
  },
};

// GET /api/settings
router.get('/', requireAdmin, async (req, res) => {
  const stored = await prisma.platformSetting.findMany({
    orderBy: { key: 'asc' },
  });

  const dbKeys = new Set(stored.map((s) => s.key));
  const envOnlyKeys = Object.keys(SETTING_META).filter(
    (k) => !dbKeys.has(k) && process.env[k]
  );

  const settings = [
    ...stored.map((s) => ({
      key: s.key,
      label: SETTING_META[s.key]?.label ?? s.key,
      description: SETTING_META[s.key]?.description ?? '',
      keyPrefix: s.keyPrefix,
      configured: true,
      source: 'db',
    })),
    ...envOnlyKeys.map((k) => ({
      key: k,
      label: SETTING_META[k]?.label ?? k,
      description: SETTING_META[k]?.description ?? '',
      keyPrefix: (process.env[k] ?? '').slice(0, 8) + '...',
      configured: true,
      source: 'env',
    })),
    ...Object.keys(SETTING_META)
      .filter((k) => !dbKeys.has(k) && !process.env[k])
      .map((k) => ({
        key: k,
        label: SETTING_META[k].label,
        description: SETTING_META[k].description,
        keyPrefix: null,
        configured: false,
        source: null,
      })),
  ];

  res.json({ ok: true, data: settings });
});

// PUT /api/settings/:key
router.put('/:key', requireAdmin, async (req, res) => {
  const key = req.params.key;
  const { value } = req.body;

  if (!value || typeof value !== 'string') {
    return res.status(400).json({ ok: false, error: 'value is required' });
  }

  const encryptedValue = encrypt(value);
  const keyPrefix = value.slice(0, 8) + '...';

  await prisma.platformSetting.upsert({
    where: { key },
    update: { encryptedValue, keyPrefix },
    create: { key, encryptedValue, keyPrefix },
  });

  res.json({ ok: true, data: { key, keyPrefix, configured: true } });
});

// DELETE /api/settings/:key
router.delete('/:key', requireAdmin, async (req, res) => {
  const key = req.params.key;

  const existing = await prisma.platformSetting.findUnique({ where: { key } });
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'Setting not found' });
  }

  await prisma.platformSetting.delete({ where: { key } });
  res.json({ ok: true, data: { key, deleted: true } });
});

// Internal helper
async function getSettingValue(key) {
  try {
    const stored = await prisma.platformSetting.findUnique({ where: { key } });
    if (stored) return decrypt(stored.encryptedValue);
  } catch {
    // fall through
  }
  return process.env[key] ?? null;
}

module.exports = router;
module.exports.getSettingValue = getSettingValue;
