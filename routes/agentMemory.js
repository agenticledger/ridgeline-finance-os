const { Router } = require('express');
const prisma = require('../services/db');
const { requireAdmin } = require('../middleware/adminAuth');

const router = Router();

// GET /api/agents/:agentId/memory
router.get('/:agentId/memory', requireAdmin, async (req, res, next) => {
  try {
    const documents = await prisma.agentDocument.findMany({
      where: { agentId: req.params.agentId },
      orderBy: { updatedAt: 'desc' },
    });

    const data = documents.map(d => ({
      id: d.id,
      docType: d.docType,
      docKey: d.docKey,
      contentPreview: d.content.slice(0, 200),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));

    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// GET /api/agents/:agentId/memory/:docKey
router.get('/:agentId/memory/:docKey', requireAdmin, async (req, res, next) => {
  try {
    const document = await prisma.agentDocument.findFirst({
      where: { agentId: req.params.agentId, docKey: req.params.docKey },
    });

    if (!document) {
      return res.status(404).json({ ok: false, error: 'Memory document not found' });
    }

    res.json({
      ok: true,
      data: {
        id: document.id,
        docType: document.docType,
        docKey: document.docKey,
        content: document.content,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      },
    });
  } catch (err) { next(err); }
});

// PUT /api/agents/:agentId/memory/:docKey
router.put('/:agentId/memory/:docKey', requireAdmin, async (req, res, next) => {
  try {
    const { content, docType } = req.body;

    if (!content) {
      return res.status(400).json({ ok: false, error: 'content is required' });
    }

    const agent = await prisma.agent.findUnique({ where: { id: req.params.agentId } });
    if (!agent) {
      return res.status(404).json({ ok: false, error: 'Agent not found' });
    }

    const resolvedDocType = docType ?? 'memory';

    const document = await prisma.agentDocument.upsert({
      where: {
        agentId_docType_docKey: {
          agentId: req.params.agentId,
          docType: resolvedDocType,
          docKey: req.params.docKey,
        },
      },
      update: { content },
      create: {
        agentId: req.params.agentId,
        docType: resolvedDocType,
        docKey: req.params.docKey,
        content,
      },
    });

    res.json({
      ok: true,
      data: {
        id: document.id,
        docType: document.docType,
        docKey: document.docKey,
        content: document.content,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      },
    });
  } catch (err) { next(err); }
});

// DELETE /api/agents/:agentId/memory/:docKey
router.delete('/:agentId/memory/:docKey', requireAdmin, async (req, res, next) => {
  try {
    const document = await prisma.agentDocument.findFirst({
      where: { agentId: req.params.agentId, docKey: req.params.docKey },
    });

    if (!document) {
      return res.status(404).json({ ok: false, error: 'Memory document not found' });
    }

    await prisma.agentMemoryEmbedding.deleteMany({
      where: { docId: document.id },
    });

    await prisma.agentDocument.delete({
      where: { id: document.id },
    });

    res.json({ ok: true, data: null });
  } catch (err) { next(err); }
});

module.exports = router;
