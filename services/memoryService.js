const crypto = require('crypto');
const prisma = require('./db');
const { generateEmbedding, splitTextIntoChunks } = require('./ragService');

async function getDocument(agentId, docKey) {
  return prisma.agentDocument.findFirst({
    where: { agentId, docKey },
  });
}

async function upsertDocument(agentId, docType, docKey, content) {
  const existing = await prisma.agentDocument.findFirst({
    where: { agentId, docType, docKey },
  });

  if (existing) {
    return prisma.agentDocument.update({
      where: { id: existing.id },
      data: { content, docType },
    });
  }

  return prisma.agentDocument.create({
    data: { agentId, docType, docKey, content },
  });
}

async function deleteDocument(agentId, docKey) {
  const doc = await prisma.agentDocument.findFirst({
    where: { agentId, docKey },
  });
  if (!doc) return null;

  await prisma.agentMemoryEmbedding.deleteMany({
    where: { docId: doc.id },
  });
  return prisma.agentDocument.delete({
    where: { id: doc.id },
  });
}

async function searchMemory(agentId, query, apiKey, topK = 5) {
  try {
    const queryEmbedding = await generateEmbedding(query, apiKey);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const results = await prisma.$queryRawUnsafe(
      `SELECT chunk_text, 1 - (embedding <=> $1::vector) as similarity, doc_id
       FROM agent_memory_embeddings
       WHERE agent_id = $2::uuid
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      embeddingStr,
      agentId,
      topK,
    );

    return results.map((r) => ({
      chunkText: r.chunk_text,
      similarity: r.similarity,
      docId: r.doc_id,
    }));
  } catch (err) {
    console.error('Memory search error:', err.message);
    return [];
  }
}

async function embedDocument(agentId, docId, content, apiKey) {
  await prisma.agentMemoryEmbedding.deleteMany({
    where: { docId },
  });

  const chunks = splitTextIntoChunks(content, 800, 150);

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await generateEmbedding(chunks[i], apiKey);
    const embeddingStr = `[${embedding.join(',')}]`;
    const contentHash = crypto.createHash('md5').update(chunks[i]).digest('hex');

    await prisma.$executeRawUnsafe(
      `INSERT INTO agent_memory_embeddings (id, doc_id, agent_id, chunk_text, embedding, line_start, line_end, content_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::vector, $5, $6, $7)`,
      docId,
      agentId,
      chunks[i],
      embeddingStr,
      i * 10,
      (i + 1) * 10,
      contentHash,
    );
  }

  return chunks.length;
}

async function getMemoryRecall(agentId, userMessage, apiKey) {
  try {
    const results = await searchMemory(agentId, userMessage, apiKey, 5);
    const relevant = results.filter((r) => r.similarity > 0.3);
    if (relevant.length === 0) return null;

    const parts = relevant.map(
      (r, i) => `[Memory ${i + 1}, relevance: ${(r.similarity * 100).toFixed(1)}%]\n${r.chunkText}`,
    );

    return `\n--- Memory Recall ---\nRelevant memories:\n\n${parts.join('\n\n')}`;
  } catch {
    return null;
  }
}

module.exports = {
  getDocument,
  upsertDocument,
  deleteDocument,
  searchMemory,
  embedDocument,
  getMemoryRecall,
};
