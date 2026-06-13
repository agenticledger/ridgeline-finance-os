const { registerToolHandler } = require('./toolExecutor');
const {
  getDocument,
  upsertDocument,
  deleteDocument,
  searchMemory,
} = require('./memoryService');

const MEMORY_TOOLS = [
  {
    name: 'memory__read',
    description: 'Read a memory document by its key. Returns the document content.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_key: {
          type: 'string',
          description: 'The key/name of the document to read (e.g. "soul.md", "user_prefs", "daily_log")',
        },
      },
      required: ['doc_key'],
    },
  },
  {
    name: 'memory__write',
    description: 'Write (create or replace) a memory document. Overwrites existing content.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_key: {
          type: 'string',
          description: 'The key/name of the document to write',
        },
        content: {
          type: 'string',
          description: 'The full content to write',
        },
        doc_type: {
          type: 'string',
          enum: ['soul', 'memory', 'context', 'daily'],
          description: 'Type of document (default: memory)',
        },
      },
      required: ['doc_key', 'content'],
    },
  },
  {
    name: 'memory__append',
    description: 'Append content to an existing memory document. Creates it if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_key: {
          type: 'string',
          description: 'The key/name of the document to append to',
        },
        content: {
          type: 'string',
          description: 'The content to append',
        },
      },
      required: ['doc_key', 'content'],
    },
  },
  {
    name: 'memory__delete',
    description: 'Delete a memory document and its embeddings.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_key: {
          type: 'string',
          description: 'The key/name of the document to delete',
        },
      },
      required: ['doc_key'],
    },
  },
  {
    name: 'memory__search',
    description: 'Search memory for relevant information using semantic similarity.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of results (default: 5)',
        },
      },
      required: ['query'],
    },
  },
];

registerToolHandler('memory__', async (toolName, input, context) => {
  const { agentId, apiKey } = context || {};
  if (!agentId) {
    return JSON.stringify({ error: 'No agentId in context' });
  }

  switch (toolName) {
    case 'memory__read': {
      const doc = await getDocument(agentId, input.doc_key);
      if (!doc) {
        return JSON.stringify({ error: `Document "${input.doc_key}" not found` });
      }
      return JSON.stringify({
        doc_key: doc.docKey,
        doc_type: doc.docType,
        content: doc.content,
        updated_at: doc.updatedAt,
      });
    }

    case 'memory__write': {
      const docType = input.doc_type || 'memory';
      const doc = await upsertDocument(agentId, docType, input.doc_key, input.content);
      return JSON.stringify({
        success: true,
        doc_key: doc.docKey,
        doc_type: doc.docType,
        updated_at: doc.updatedAt,
      });
    }

    case 'memory__append': {
      const existing = await getDocument(agentId, input.doc_key);
      const newContent = existing
        ? existing.content + '\n' + input.content
        : input.content;
      const docType = existing?.docType || 'memory';
      const doc = await upsertDocument(agentId, docType, input.doc_key, newContent);
      return JSON.stringify({
        success: true,
        doc_key: doc.docKey,
        appended: true,
        updated_at: doc.updatedAt,
      });
    }

    case 'memory__delete': {
      const deleted = await deleteDocument(agentId, input.doc_key);
      if (!deleted) {
        return JSON.stringify({ error: `Document "${input.doc_key}" not found` });
      }
      return JSON.stringify({
        success: true,
        doc_key: input.doc_key,
        deleted: true,
      });
    }

    case 'memory__search': {
      if (!apiKey) return JSON.stringify({ error: 'No API key for embeddings' });
      const results = await searchMemory(agentId, input.query, apiKey, input.top_k || 5);
      return JSON.stringify({
        results: results.map((r) => ({
          chunk: r.chunkText,
          similarity: r.similarity,
        })),
      });
    }

    default:
      return JSON.stringify({ error: `Unknown memory tool: ${toolName}` });
  }
});

module.exports = { MEMORY_TOOLS };
