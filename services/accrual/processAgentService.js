// Process Owner Agent provisioning.
//
// The generalized capability: every Process is owned by exactly one Agent. When a
// process is created, the platform auto-provisions its Owner Agent. The agent is a
// SUPERVISOR, not in the critical path: the deterministic engine does the math; the
// agent observes live run state, explains it, can trigger steps (run / sign-off /
// freeze / reconcile) through the fos__ tool surface, and with the scheduler can act
// proactively. The freight accrual is the first process to get a fully wired owner.
//
//   provisionOwnerAgent(process)  -> creates/links the agent (idempotent by slug)
//   backfillOwnerAgents()         -> provisions owners for every process missing one
//   buildSupervisorPrompt(process)-> the process-aware system prompt (regenerable)

const prisma = require('../db');

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function agentSlugFor(processSlug) {
  return `${processSlug}-agent`;
}

// Load a process with everything the supervisor needs to reason about it.
async function loadProcessForAgent(processId) {
  return prisma.process.findUnique({
    where: { id: processId },
    include: {
      org: true,
      legalEntity: true,
      function: true,
      steps: { orderBy: { order: 'asc' } },
      policies: { orderBy: { key: 'asc' } },
      tools: { include: { tool: true } },
    },
  });
}

// Build the supervisor system prompt from the process spine. Pure function of the
// process so it can be regenerated whenever the definition changes.
function buildSupervisorPrompt(process) {
  const org = process.org ? process.org.name : 'the organization';
  const fn = process.function ? process.function.name : 'Finance';
  const engineBound = process.slug === 'freight-accrual';

  const stepLines = (process.steps || [])
    .map((s) => {
      const gate = s.isGate ? ' [GATE]' : '';
      const pause = s.pauseAfter ? ' [pauses for human]' : '';
      return `  ${s.order}. ${s.name} (${s.decisionType.replace('_', '-')})${gate}${pause} — ${s.description || ''}`.trimEnd();
    })
    .join('\n');

  const policyLines = (process.policies || [])
    .map((p) => {
      const params = p.params && Object.keys(p.params).length
        ? '  params: ' + JSON.stringify(p.params)
        : '';
      return `  - ${p.name} (key: ${p.key}, v${p.version})\n    ${p.definition || ''}\n  ${params}`.trimEnd();
    })
    .join('\n');

  const je = (process.policies || []).find((p) => p.key === 'je_accounts');
  const jeLine = je && je.params
    ? `Journal entry: Debit ${je.params.debitAccount || '?'} / Credit ${je.params.creditAccount || '?'}.`
    : '';
  const gatePolicy = (process.policies || []).find((p) => p.key === 'materiality_gate');
  const gateLine = gatePolicy && gatePolicy.params
    ? `Materiality gate: a carrier auto-posts only if its half-band is under $${gatePolicy.params.materialityThreshold} AND its CV is under ${Math.round((gatePolicy.params.maxCv || 0) * 100)}%; otherwise it routes to review/escalate.`
    : '';

  return `You are the ${process.name} Owner Agent for ${org} (${fn}).

WHO YOU ARE
You are the single accountable supervisor for ONE process: ${process.name}. You are NOT a generic assistant and you do not speak for any advisory firm. Your entire expertise is this process and the runs underneath it.

YOUR POSTURE — SUPERVISE, DO NOT COMPUTE
You are a supervisor, never in the critical path. A deterministic engine does the math (pricing, calibration, the estimate, the gate, the journal entry). You observe live run state, explain it in plain language to the controller, can trigger steps, and with the scheduler can act proactively. You never re-derive or invent numbers. Every figure you state must come from a tool call against the live run, not from memory.

THE PROCESS YOU OWN
${process.description || ''}
Frequency: ${process.frequency}. Mode: ${process.mode}.

Steps (the auditable spine):
${stepLines || '  (no steps defined yet)'}

${gateLine}
${jeLine}

Policies (the tunable knobs — params are versioned objects, algorithms are code):
${policyLines || '  (no policies defined yet)'}

YOUR THREE JOBS
1. Overview — keep situational awareness of the latest run: status, the estimate vs the confidence band, how it compares to the Denise trailing-average benchmark, what escalated, what is waiting on a human.
2. Execute — narrate and, when asked, orchestrate the run: trigger a new run, walk a step, and surface the materiality gate's dispositions.
3. Improve — after actuals arrive, surface the reconcile-and-learn evidence and the proposed policy changes; explain what each change would do, never apply silently.

YOUR TOOLS (use them before answering anything factual)
- fos__run_status — the latest run's headline state for this process.
- fos__list_runs — run history.
- fos__run_detail — a specific run's steps, carriers, gate matrix, exceptions, ledger.
- fos__trigger_run — start a new run for a period.
- fos__sign_off — post the staged journal entry (IRREVERSIBLE). Only do this when a human has explicitly told you to sign off in this conversation; otherwise explain what signing off would do and ask them to confirm.
- fos__freeze — lock a run for period close.
- fos__improvements — the reconcile-and-learn proposals.
- fos__explain_variance — the structured variance vs benchmark for narration.

HOW YOU BEHAVE
- Open factual answers with a tool call; ground claims in the returned data.
- Lead with the number the controller cares about, then the why.
- Flag materiality, confidence, and any escalations honestly. Auditability over optimism.
- For anything irreversible (posting the JE, freezing), confirm intent first.
- Be concise and CFO-ready. No hype.${engineBound ? '\n- This process is engine-bound: runs execute the validated freight estimation engine. April 2026 is the live period.' : '\n- This process is defined but not yet engine-bound: you can explain its design and definition, but runs will not execute until an engine is bound.'}`;
}

// Create (or find) the owner agent for a process and link it. Idempotent.
async function provisionOwnerAgent(processId, { regeneratePrompt = true } = {}) {
  const process = await loadProcessForAgent(processId);
  if (!process) throw new Error('Process not found for owner-agent provisioning.');

  const slug = agentSlugFor(process.slug);
  const instructions = buildSupervisorPrompt(process);
  const description = `Process Owner Agent — the accountable supervisor for ${process.name}. Observes runs, explains state, and can trigger steps. Not in the critical path.`;

  let agent = await prisma.agent.findUnique({ where: { slug } });
  if (agent) {
    if (regeneratePrompt) {
      agent = await prisma.agent.update({
        where: { id: agent.id },
        data: {
          name: `${process.name} Agent`,
          description,
          instructions,
          isActive: true,
          features: { ...(agent.features || {}), processSupervisor: { processId: process.id, processSlug: process.slug } },
        },
      });
    }
  } else {
    agent = await prisma.agent.create({
      data: {
        name: `${process.name} Agent`,
        slug,
        description,
        instructions,
        defaultModel: DEFAULT_MODEL,
        features: { processSupervisor: { processId: process.id, processSlug: process.slug } },
        branding: { kind: 'process-owner' },
      },
    });
  }

  // Link the process to its owner (both directions are now resolvable).
  if (process.agentId !== agent.id) {
    await prisma.process.update({ where: { id: process.id }, data: { agentId: agent.id } });
  }

  return agent;
}

// Provision owners for every process that lacks one (or refresh prompts for all).
async function backfillOwnerAgents({ refresh = false } = {}) {
  const processes = await prisma.process.findMany({ where: { isActive: true }, select: { id: true, agentId: true, name: true } });
  const out = [];
  for (const p of processes) {
    if (p.agentId && !refresh) { out.push({ process: p.name, status: 'already-owned' }); continue; }
    const agent = await provisionOwnerAgent(p.id, { regeneratePrompt: true });
    out.push({ process: p.name, agent: agent.name, slug: agent.slug, status: p.agentId ? 'refreshed' : 'provisioned' });
  }
  return out;
}

module.exports = {
  provisionOwnerAgent,
  backfillOwnerAgents,
  buildSupervisorPrompt,
  loadProcessForAgent,
  agentSlugFor,
};
