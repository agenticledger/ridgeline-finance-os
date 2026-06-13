const { Router } = require('express');
const prisma = require('../services/db');
const { requireAdmin } = require('../middleware/adminAuth');

const router = Router();

// GET /api/capabilities
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const capabilities = await prisma.capability.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { agentCapabilities: true } },
        agentCapabilities: {
          include: { agent: { select: { id: true, name: true, slug: true } } },
        },
      },
    });

    const data = capabilities.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      type: c.type,
      serverUrl: c.serverUrl,
      config: c.config,
      isActive: c.isActive,
      agentCount: c._count.agentCapabilities,
      agents: c.agentCapabilities.map((ac) => ({
        id: ac.agent.id,
        name: ac.agent.name,
        slug: ac.agent.slug,
      })),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// POST /api/capabilities
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { name, description, type, serverUrl, config } = req.body;

    if (!name) {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const capability = await prisma.capability.create({
      data: {
        name,
        slug,
        description: description ?? null,
        type: type ?? 'external',
        serverUrl: serverUrl ?? null,
        config: config ?? {},
      },
    });

    res.status(201).json({ ok: true, data: capability });
  } catch (err) { next(err); }
});

// PATCH /api/capabilities/:id
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, description, serverUrl, config, isActive } = req.body;

    const updateData = {};
    if (name !== undefined) {
      updateData.name = name;
      updateData.slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
    if (description !== undefined) updateData.description = description;
    if (serverUrl !== undefined) updateData.serverUrl = serverUrl;
    if (config !== undefined) updateData.config = config;
    if (isActive !== undefined) updateData.isActive = isActive;

    const capability = await prisma.capability.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json({ ok: true, data: capability });
  } catch (err) { next(err); }
});

// DELETE /api/capabilities/:id
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.capability.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ ok: true, data: null });
  } catch (err) { next(err); }
});

// POST /api/capabilities/:id/test
router.post('/:id/test', requireAdmin, async (req, res, next) => {
  try {
    const capability = await prisma.capability.findUnique({ where: { id: req.params.id } });

    if (!capability) {
      return res.status(404).json({ ok: false, error: 'Capability not found' });
    }

    if (!capability.serverUrl) {
      return res.status(400).json({ ok: false, error: 'No server URL configured' });
    }

    const { testConnection, clearCache } = require('../services/mcpClient');
    const bearerToken = req.body?.bearerToken || capability.config?.bearerToken || null;

    clearCache(capability.serverUrl);
    const result = await testConnection(capability.serverUrl, bearerToken);

    res.json({
      ok: true,
      data: {
        reachable: result.ok,
        toolCount: result.tools?.length || 0,
        tools: (result.tools || []).map(t => ({ name: t.name, description: t.description })),
        error: result.error || null,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/capabilities/test-url — test an unsaved MCP server URL
router.post('/test-url', requireAdmin, async (req, res, next) => {
  try {
    const { serverUrl, bearerToken } = req.body;
    if (!serverUrl) {
      return res.status(400).json({ ok: false, error: 'serverUrl is required' });
    }

    const { testConnection } = require('../services/mcpClient');
    const result = await testConnection(serverUrl, bearerToken || null);

    res.json({
      ok: true,
      data: {
        reachable: result.ok,
        toolCount: result.tools?.length || 0,
        tools: (result.tools || []).map(t => ({ name: t.name, description: t.description })),
        error: result.error || null,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
