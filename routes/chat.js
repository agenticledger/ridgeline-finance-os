const { Router } = require('express');
const prisma = require('../services/db');
const { buildContext } = require('../services/contextBuilder');
const { getProviderForModel } = require('../services/llm');
const { streamWithTools, executeWithTools, registerToolHandler } = require('../services/toolExecutor');
const { DEEP_TOOLS } = require('../services/deepTools');
const { MEMORY_TOOLS } = require('../services/memoryTools');
const { FOS_TOOLS } = require('../services/fosSupervisorTools');

// A process owner agent gets the supervisor tool surface (read run state + trigger steps).
function isProcessSupervisor(agent) {
  return !!(agent && agent.features && agent.features.processSupervisor);
}
const { encrypt, decrypt } = require('../services/encryption');
const { listTools, callTool } = require('../services/mcpClient');

const router = Router();

// Load MCP tools from agent capabilities
async function loadMcpToolsForAgent(agentId) {
  const agentCaps = await prisma.agentCapability.findMany({
    where: { agentId },
    include: { capability: true },
  });

  const mcpTools = [];

  for (const ac of agentCaps) {
    const cap = ac.capability;
    if (!cap.isActive || !cap.serverUrl) continue;

    const bearerToken = ac.config?.bearerToken || cap.config?.bearerToken || null;
    const prefix = `mcp_${cap.slug}__`;

    try {
      const tools = await listTools(cap.serverUrl, bearerToken);

      for (const tool of tools) {
        mcpTools.push({
          name: `${prefix}${tool.name}`,
          description: `[${cap.name}] ${tool.description || tool.name}`,
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        });
      }

      // Register handler for this capability's tools
      registerToolHandler(prefix, async (toolName, input) => {
        const originalName = toolName.slice(prefix.length);
        try {
          return await callTool(cap.serverUrl, originalName, input, bearerToken);
        } catch (err) {
          return JSON.stringify({ error: `MCP tool failed: ${err.message}` });
        }
      });
    } catch (err) {
      console.error(`Failed to load MCP tools for ${cap.name}:`, err.message);
    }
  }

  return mcpTools;
}

// Resolve API key for a provider
async function resolveApiKey(provider) {
  const stored = await prisma.llmApiKey.findUnique({
    where: { provider },
  });
  if (stored) {
    return decrypt(stored.encryptedKey);
  }

  const envMap = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
  };
  const envVar = envMap[provider];
  return envVar ? (process.env[envVar] ?? null) : null;
}

// Resolve current LLM config
async function resolveLlmConfig(agent) {
  const config = await prisma.llmConfig.findFirst({
    orderBy: { updatedAt: 'desc' },
  });

  const provider = config?.provider ?? 'anthropic';
  const model = agent?.defaultModel ?? config?.model ?? 'claude-sonnet-4-6';
  const apiKey = await resolveApiKey(provider);

  return { provider, model, apiKey };
}

// POST /api/chat/start — start a conversation
router.post('/start', async (req, res, next) => {
  try {
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ ok: false, error: 'agentId is required' });
    }

    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
    });

    if (!agent || !agent.isActive) {
      return res.status(404).json({ ok: false, error: 'Agent not found' });
    }

    const conversation = await prisma.conversation.create({
      data: { agentId },
    });

    res.status(201).json({
      ok: true,
      data: {
        conversationId: conversation.publicId,
        agent: {
          id: agent.id,
          name: agent.name,
          slug: agent.slug,
          description: agent.description,
          branding: agent.branding,
        },
      },
    });
  } catch (err) { next(err); }
});

// GET /api/chat/conversations — list conversations
router.get('/conversations', async (req, res, next) => {
  try {
    const { agentId, limit } = req.query;

    const conversations = await prisma.conversation.findMany({
      where: {
        isActive: true,
        ...(agentId ? { agentId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit ? parseInt(limit, 10) : 50,
      include: {
        agent: { select: { id: true, name: true, slug: true } },
      },
    });

    const data = conversations.map(c => ({
      id: c.publicId,
      agentId: c.agentId,
      agentName: c.agent.name,
      agentSlug: c.agent.slug,
      title: c.title,
      messageCount: c.messageCount,
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt,
    }));

    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// GET /api/chat/:conversationId — get conversation + messages
router.get('/:conversationId', async (req, res, next) => {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { publicId: req.params.conversationId },
      include: {
        agent: { select: { id: true, name: true, slug: true, branding: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!conversation) {
      return res.status(404).json({ ok: false, error: 'Conversation not found' });
    }

    res.json({
      ok: true,
      data: {
        id: conversation.publicId,
        agent: conversation.agent,
        title: conversation.title,
        messageCount: conversation.messageCount,
        messages: conversation.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          metadata: m.metadata,
          createdAt: m.createdAt,
        })),
        createdAt: conversation.createdAt,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/chat/:conversationId/stream — SSE streaming chat
router.post('/:conversationId/stream', async (req, res, next) => {
  try {
    const { content, images } = req.body;

    if (!content) {
      return res.status(400).json({ ok: false, error: 'content is required' });
    }

    const llmImages = Array.isArray(images) && images.length > 0
      ? images.filter((img) => img.data && img.mimeType).map((img) => ({
          data: img.data,
          mimeType: img.mimeType,
        }))
      : undefined;

    const conversation = await prisma.conversation.findUnique({
      where: { publicId: req.params.conversationId },
      include: {
        agent: true,
        messages: { orderBy: { createdAt: 'asc' }, take: 50 },
      },
    });

    if (!conversation) {
      return res.status(404).json({ ok: false, error: 'Conversation not found' });
    }

    // Save user message
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content,
      },
    });

    // Resolve LLM config
    const llmConfig = await resolveLlmConfig(conversation.agent);

    if (!llmConfig.apiKey) {
      return res.status(500).json({ ok: false, error: 'No API key configured for provider: ' + llmConfig.provider });
    }

    // Build context with RAG + memory
    const ctx = await buildContext({
      agentId: conversation.agentId,
      conversationId: conversation.id,
      userMessage: content,
      images: llmImages,
      openaiApiKey: await resolveApiKey('openai') ?? undefined,
    });

    // Load built-in tools + MCP tools from agent capabilities
    const mcpTools = await loadMcpToolsForAgent(conversation.agentId).catch(() => []);
    const supervisorTools = isProcessSupervisor(conversation.agent) ? FOS_TOOLS : [];
    const tools = [...DEEP_TOOLS, ...MEMORY_TOOLS, ...supervisorTools, ...mcpTools];

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('start', { conversationId: conversation.publicId, model: ctx.model });

    let fullResponse = '';

    try {
      const { result } = await streamWithTools({
        messages: ctx.messages,
        tools,
        model: ctx.model,
        apiKey: llmConfig.apiKey,
        context: {
          agentId: conversation.agentId,
          conversationId: conversation.id,
          apiKey: await resolveApiKey('openai') ?? undefined,
        },
        onChunk: (chunk) => {
          if (chunk.type === 'delta') {
            fullResponse += chunk.content;
            sendEvent('delta', { content: chunk.content });
          } else if (chunk.type === 'tool') {
            sendEvent('tool', { data: chunk.content });
          }
        },
      });

      if (!fullResponse && result.text) {
        fullResponse = result.text;
      }
    } catch (streamErr) {
      sendEvent('error', { message: streamErr.message || 'Stream error' });
    }

    // Save assistant message
    if (fullResponse) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: 'assistant',
          content: fullResponse,
        },
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          messageCount: { increment: 2 },
          lastMessageAt: new Date(),
        },
      });

      // Auto-title after first exchange
      if (conversation.messageCount === 0 && llmConfig.apiKey) {
        autoTitle(conversation.id, content, fullResponse, llmConfig).catch(() => {});
      }
    }

    sendEvent('end', { messageCount: (conversation.messageCount || 0) + 2 });
    res.end();
  } catch (err) { next(err); }
});

// Auto-title helper
async function autoTitle(conversationId, userMessage, assistantMessage, llmConfig) {
  if (!llmConfig.apiKey) return;

  try {
    const provider = getProviderForModel(llmConfig.model);
    const result = await provider.generate(
      [
        { role: 'system', content: 'Generate a short title (max 6 words) for this conversation. Return ONLY the title, no quotes.' },
        { role: 'user', content: userMessage },
        { role: 'assistant', content: assistantMessage.slice(0, 500) },
      ],
      llmConfig.model,
      llmConfig.apiKey,
    );

    const title = result.text.trim().slice(0, 255);
    if (title) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { title },
      });
    }
  } catch {
    // Non-critical
  }
}

// POST /api/chat/:conversationId/message — non-streaming fallback
router.post('/:conversationId/message', async (req, res, next) => {
  try {
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ ok: false, error: 'content is required' });
    }

    const conversation = await prisma.conversation.findUnique({
      where: { publicId: req.params.conversationId },
      include: {
        agent: true,
        messages: { orderBy: { createdAt: 'asc' }, take: 50 },
      },
    });

    if (!conversation) {
      return res.status(404).json({ ok: false, error: 'Conversation not found' });
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content,
      },
    });

    const llmConfig = await resolveLlmConfig(conversation.agent);

    if (!llmConfig.apiKey) {
      return res.status(500).json({ ok: false, error: 'No API key configured for provider: ' + llmConfig.provider });
    }

    const ctx = await buildContext({
      agentId: conversation.agentId,
      conversationId: conversation.id,
      userMessage: content,
      openaiApiKey: await resolveApiKey('openai') ?? undefined,
    });

    const mcpTools = await loadMcpToolsForAgent(conversation.agentId).catch(() => []);
    const supervisorTools = isProcessSupervisor(conversation.agent) ? FOS_TOOLS : [];
    const tools = [...DEEP_TOOLS, ...MEMORY_TOOLS, ...supervisorTools, ...mcpTools];

    const { result } = await executeWithTools({
      messages: ctx.messages,
      tools,
      model: ctx.model,
      apiKey: llmConfig.apiKey,
      context: {
        agentId: conversation.agentId,
        conversationId: conversation.id,
        apiKey: await resolveApiKey('openai') ?? undefined,
      },
    });

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: result.text,
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        messageCount: { increment: 2 },
        lastMessageAt: new Date(),
      },
    });

    if (conversation.messageCount === 0) {
      autoTitle(conversation.id, content, result.text, llmConfig).catch(() => {});
    }

    res.json({
      ok: true,
      data: {
        role: 'assistant',
        content: result.text,
        model: ctx.model,
      },
    });
  } catch (err) { next(err); }
});

// DELETE /api/chat/:conversationId — archive conversation
router.delete('/:conversationId', async (req, res, next) => {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { publicId: req.params.conversationId },
    });

    if (!conversation) {
      return res.status(404).json({ ok: false, error: 'Conversation not found' });
    }

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { isActive: false },
    });

    res.json({ ok: true, data: null });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.resolveApiKey = resolveApiKey;
