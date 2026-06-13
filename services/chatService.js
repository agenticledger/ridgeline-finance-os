const crypto = require('crypto');
const prisma = require('./db');

async function startConversation(params) {
  const sessionToken = crypto.randomBytes(32).toString('hex');

  const conversation = await prisma.conversation.create({
    data: {
      agentId: params.agentId,
      title: params.title || null,
      sessionToken,
    },
    include: {
      agent: { select: { id: true, name: true, slug: true, defaultModel: true } },
    },
  });

  return { ...conversation, sessionToken };
}

async function validateConversation(publicId, sessionToken) {
  const conversation = await prisma.conversation.findUnique({
    where: { publicId },
    include: {
      agent: { select: { id: true, name: true, slug: true, defaultModel: true, instructions: true, features: true } },
    },
  });

  if (!conversation || !conversation.isActive) return null;
  if (sessionToken && conversation.sessionToken !== sessionToken) return null;

  return conversation;
}

async function getConversationHistory(conversationId, limit = 50) {
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

async function appendMessage(params) {
  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId: params.conversationId,
        role: params.role,
        content: params.content,
        metadata: params.metadata || {},
      },
    }),
    prisma.conversation.update({
      where: { id: params.conversationId },
      data: {
        messageCount: { increment: 1 },
        lastMessageAt: new Date(),
      },
    }),
  ]);

  return message;
}

async function listConversations(params) {
  const where = { isActive: true };
  if (params.agentId) where.agentId = params.agentId;

  return prisma.conversation.findMany({
    where,
    include: {
      agent: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { lastMessageAt: 'desc' },
    take: params.limit || 50,
  });
}

module.exports = {
  startConversation,
  validateConversation,
  getConversationHistory,
  appendMessage,
  listConversations,
};
