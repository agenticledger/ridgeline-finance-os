const { Router } = require('express');
const prisma = require('../services/db');
const { requireAdmin } = require('../middleware/adminAuth');
const { ingestDocument, searchSimilar } = require('../services/ragService');
const { decrypt } = require('../services/encryption');

const router = Router();

async function getOpenAIKey() {
  const stored = await prisma.llmApiKey.findUnique({ where: { provider: 'openai' } });
  if (stored) return decrypt(stored.encryptedKey);
  return process.env.OPENAI_API_KEY ?? null;
}

// GET /api/agents/:agentId/documents
router.get('/:agentId/documents', requireAdmin, async (req, res, next) => {
  try {
    const documents = await prisma.kBDocument.findMany({
      where: { agentId: req.params.agentId, isActive: true },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { chunks: true } },
      },
    });

    const data = documents.map(d => ({
      id: d.id,
      name: d.name,
      sourceType: d.sourceType,
      metadata: d.metadata,
      chunkCount: d._count.chunks,
      createdAt: d.createdAt,
    }));

    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// POST /api/agents/:agentId/documents
router.post('/:agentId/documents', requireAdmin, async (req, res, next) => {
  try {
    const agentId = req.params.agentId;
    const { name, content, sourceType, metadata } = req.body;

    if (!name || !content) {
      return res.status(400).json({ ok: false, error: 'name and content are required' });
    }

    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return res.status(404).json({ ok: false, error: 'Agent not found' });
    }

    const document = await prisma.kBDocument.create({
      data: {
        agentId,
        name,
        content,
        sourceType: sourceType ?? 'text',
        metadata: metadata ?? {},
      },
    });

    let ingested = false;
    try {
      const apiKey = await getOpenAIKey();
      if (apiKey) {
        await ingestDocument(document.id, agentId, content, apiKey);
        ingested = true;
      }
    } catch (err) {
      console.error('Document ingestion failed:', err.message || err);
    }

    res.status(201).json({
      ok: true,
      data: {
        id: document.id,
        name: document.name,
        sourceType: document.sourceType,
        ingested,
        createdAt: document.createdAt,
      },
    });
  } catch (err) { next(err); }
});

// DELETE /api/agents/:agentId/documents/:docId
router.delete('/:agentId/documents/:docId', requireAdmin, async (req, res, next) => {
  try {
    await prisma.kBDocumentChunk.deleteMany({
      where: { documentId: req.params.docId, agentId: req.params.agentId },
    });

    await prisma.kBDocument.delete({
      where: { id: req.params.docId },
    });

    res.json({ ok: true, data: null });
  } catch (err) { next(err); }
});

// GET /api/agents/:agentId/documents/search
router.get('/:agentId/documents/search', requireAdmin, async (req, res, next) => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ ok: false, error: 'q query parameter is required' });
    }

    const apiKey = await getOpenAIKey();
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: 'No OpenAI API key configured for embeddings' });
    }

    const results = await searchSimilar(req.params.agentId, q, apiKey);
    res.json({ ok: true, data: results });
  } catch (err) { next(err); }
});

module.exports = router;
