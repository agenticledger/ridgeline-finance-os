const prisma = require('./db');
const { getRagContext } = require('./ragService');
const { getMemoryRecall } = require('./memoryService');

async function buildContext(params) {
  const agent = await prisma.agent.findUnique({
    where: { id: params.agentId },
    include: {
      agentDocuments: {
        where: { docType: 'soul' },
        take: 1,
      },
    },
  });

  if (!agent) throw new Error('Agent not found');

  const features = agent.features || {};
  let systemPrompt;

  if (features.memoryEnabled && agent.agentDocuments.length > 0) {
    systemPrompt = agent.agentDocuments[0].content;
  } else if (agent.instructions) {
    systemPrompt = agent.instructions;
  } else {
    systemPrompt = `You are ${agent.name}, an AI assistant. Be helpful, concise, and accurate.`;
  }

  const supervisor = features.processSupervisor || null;

  if (supervisor) {
    // Process Owner Agent — inject live run state so the supervisor has situational
    // awareness on every turn (it still calls fos__ tools for anything it acts on).
    systemPrompt += '\n\n--- Live process state (refreshed each turn) ---';
    try {
      const runService = require('./accrual/runService');
      const slug = supervisor.processSlug || runService.PROCESS_SLUG;
      const runs = await runService.listRuns(slug);
      if (!runs.length) {
        systemPrompt += `\nNo runs have executed yet for ${slug}. Offer to trigger one.`;
      } else {
        const run = await runService.getRun(runs[0].id);
        const s = run.summary || {};
        const disp = s.dispositions || {};
        const m = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
        systemPrompt += `\nLatest run: ${run.period} — status ${run.status}${run.frozen ? ' (frozen)' : ''}.`;
        systemPrompt += `\nPoint estimate ${m(s.point)} (90% band ${m(s.low)}–${m(s.high)}). Denise trailing-avg benchmark ${m(s.denise)}; delta ${s.vsDenise >= 0 ? '+' : ''}${m(s.vsDenise)}.`;
        systemPrompt += `\nMateriality gate: ${disp.auto_post || 0} auto-post, ${disp.review || 0} review, ${disp.escalate || 0} escalate.`;
        const openItems = (run.actionItems || []).filter((i) => i.status === 'open').length;
        const totalItems = (run.actionItems || []).length;
        if (totalItems) systemPrompt += `\nAction items: ${openItems} of ${totalItems} still open (each must be cleared — approved or marked N/A — before sign-off). Use fos__action_items to list them and fos__clear_action to clear one.`;
        if (run.status === 'awaiting_human') systemPrompt += `\nACTION NEEDED: the run is paused awaiting human sign-off before the journal entry posts.${openItems ? ` Sign-off is blocked until the ${openItems} open action item${openItems === 1 ? '' : 's'} are cleared.` : ''}`;
        systemPrompt += `\nRun count: ${runs.length}. Always confirm specifics with a fos__ tool call before stating numbers.`;
      }
    } catch (err) {
      systemPrompt += `\n(Live state unavailable: ${err.message})`;
    }
  } else {
    systemPrompt += '\n\n--- Platform Context ---';
    systemPrompt += '\nYou are running inside the Ridgeline Finance OS platform.';
  }

  // RAG context injection
  if (features.ragEnabled && params.openaiApiKey) {
    try {
      const ragContext = await getRagContext(params.agentId, params.userMessage, params.openaiApiKey);
      if (ragContext) {
        systemPrompt += ragContext;
      }
    } catch (err) {
      console.error('RAG context injection error:', err.message);
    }
  }

  // Memory recall injection
  if (features.memoryEnabled && params.openaiApiKey) {
    try {
      const memoryContext = await getMemoryRecall(params.agentId, params.userMessage, params.openaiApiKey);
      if (memoryContext) {
        systemPrompt += memoryContext;
      }
    } catch (err) {
      console.error('Memory recall error:', err.message);
    }
  }

  // Load conversation history
  const history = await prisma.message.findMany({
    where: { conversationId: params.conversationId },
    orderBy: { createdAt: 'asc' },
    take: params.historyLimit || 50,
  });

  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of history) {
    if (msg.role === 'system') continue;
    const metadata = msg.metadata || {};
    messages.push({
      role: msg.role,
      content: msg.content,
      toolCallId: metadata.toolCallId,
      toolCalls: metadata.toolCalls,
    });
  }

  messages.push({
    role: 'user',
    content: params.userMessage,
    ...(params.images && params.images.length > 0 ? { images: params.images } : {}),
  });

  return {
    messages,
    model: agent.defaultModel || 'claude-sonnet-4-6',
  };
}

module.exports = { buildContext };
