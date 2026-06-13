const OpenAI = require('openai');
const prisma = require('./db');

function splitTextIntoChunks(text, maxChunkSize = 1000, overlap = 200) {
  if (text.length <= maxChunkSize) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length + 2 > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      const overlapText = currentChunk.slice(-overlap);
      currentChunk = overlapText + '\n\n' + paragraph;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChunkSize) {
      finalChunks.push(chunk);
      continue;
    }
    const sentences = chunk.match(/[^.!?]+[.!?]+\s*/g) || [chunk];
    let subChunk = '';
    for (const sentence of sentences) {
      if (subChunk.length + sentence.length > maxChunkSize && subChunk.length > 0) {
        finalChunks.push(subChunk.trim());
        const overlapText = subChunk.slice(-overlap);
        subChunk = overlapText + sentence;
      } else {
        subChunk += sentence;
      }
    }
    if (subChunk.trim()) {
      finalChunks.push(subChunk.trim());
    }
  }

  return finalChunks;
}

async function generateEmbedding(text, apiKey) {
  const openai = new OpenAI({ apiKey });
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

async function searchSimilar(agentId, query, apiKey, maxResults = 5) {
  const queryEmbedding = await generateEmbedding(query, apiKey);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  const results = await prisma.$queryRawUnsafe(
    `SELECT content, 1 - (embedding <=> $1::vector) as similarity, document_id, chunk_index
     FROM kb_document_chunks
     WHERE agent_id = $2::uuid
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    embeddingStr,
    agentId,
    maxResults,
  );

  return results.map((r) => ({
    content: r.content,
    similarity: r.similarity,
    documentId: r.document_id,
    chunkIndex: r.chunk_index,
  }));
}

async function ingestDocument(documentId, agentId, content, apiKey) {
  const chunks = splitTextIntoChunks(content);

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await generateEmbedding(chunks[i], apiKey);
    const embeddingStr = `[${embedding.join(',')}]`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO kb_document_chunks (id, document_id, agent_id, chunk_index, content, embedding, token_count)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::vector, $6)`,
      documentId,
      agentId,
      i,
      chunks[i],
      embeddingStr,
      Math.ceil(chunks[i].length / 4),
    );
  }

  return chunks.length;
}

async function getRagContext(agentId, userMessage, apiKey, maxResults = 5) {
  try {
    const docCount = await prisma.kBDocument.count({
      where: { agentId, isActive: true },
    });
    if (docCount === 0) return null;

    const results = await searchSimilar(agentId, userMessage, apiKey, maxResults);
    if (results.length === 0) return null;

    const relevant = results.filter((r) => r.similarity > 0.3);
    if (relevant.length === 0) return null;

    const contextParts = relevant.map(
      (r, i) => `[Source ${i + 1}, relevance: ${(r.similarity * 100).toFixed(1)}%]\n${r.content}`,
    );

    return `\n--- Knowledge Base Context ---\nThe following excerpts from the knowledge base are relevant to the user's query:\n\n${contextParts.join('\n\n')}`;
  } catch (err) {
    console.error('RAG context error:', err.message);
    return null;
  }
}

module.exports = {
  splitTextIntoChunks,
  generateEmbedding,
  searchSimilar,
  ingestDocument,
  getRagContext,
};
