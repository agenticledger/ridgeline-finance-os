const { Router } = require('express');
const prisma = require('../services/db');
const { requireAdmin } = require('../middleware/adminAuth');

const router = Router();

// GET /api/agents/:agentId/capabilities
router.get('/:agentId/capabilities', requireAdmin, async (req, res, next) => {
  try {
    const agentCaps = await prisma.agentCapability.findMany({
      where: { agentId: req.params.agentId },
      include: { capability: true },
    });

    const data = agentCaps.map((ac) => ({
      id: ac.id,
      capabilityId: ac.capabilityId,
      name: ac.capability.name,
      slug: ac.capability.slug,
      type: ac.capability.type,
      description: ac.capability.description,
      config: ac.config,
      createdAt: ac.createdAt,
    }));

    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// PUT /api/agents/:agentId/capabilities/:capId
router.put('/:agentId/capabilities/:capId', requireAdmin, async (req, res, next) => {
  try {
    const { config } = req.body || {};

    const agentCap = await prisma.agentCapability.upsert({
      where: {
        agentId_capabilityId: {
          agentId: req.params.agentId,
          capabilityId: req.params.capId,
        },
      },
      create: {
        agentId: req.params.agentId,
        capabilityId: req.params.capId,
        config: config ?? {},
      },
      update: {
        config: config ?? {},
      },
      include: { capability: true },
    });

    res.json({ ok: true, data: agentCap });
  } catch (err) { next(err); }
});

// DELETE /api/agents/:agentId/capabilities/:capId
router.delete('/:agentId/capabilities/:capId', requireAdmin, async (req, res, next) => {
  try {
    await prisma.agentCapability.delete({
      where: {
        agentId_capabilityId: {
          agentId: req.params.agentId,
          capabilityId: req.params.capId,
        },
      },
    });

    res.json({ ok: true, data: null });
  } catch (err) { next(err); }
});

module.exports = router;
