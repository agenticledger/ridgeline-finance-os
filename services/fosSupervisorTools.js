// Supervisor tool surface (fos__*) — how a Process Owner Agent observes and acts.
//
// These are the tools that make the owner agent a real supervisor rather than a
// chatbot: it reads live run state and can trigger steps (run / sign-off / freeze /
// reconcile) through the same runService the UI and REST API use, so the agent and
// the humans never operate on different state. The agent resolves WHICH process it
// owns from its own features.processSupervisor, set at provisioning time.
//
// Registered against the toolExecutor with the `fos__` prefix. The chat route only
// hands these tools to agents that are process supervisors.

const prisma = require('./db');
const { registerToolHandler } = require('./toolExecutor');
const runService = require('./accrual/runService');

const round = (n) => (n == null ? null : Math.round(n));
const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));

// The tool catalog handed to the LLM for supervisor agents.
const FOS_TOOLS = [
  {
    name: 'fos__run_status',
    description: 'Headline state of the latest run for the process you own: period, status, point estimate, confidence band, comparison to the Denise trailing-average benchmark, and gate dispositions. Call this first for any "what is the status / where do we stand" question.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fos__list_runs',
    description: 'List the run history for the process you own (period, status, total, frozen). Use to answer "how many runs / show history".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fos__run_detail',
    description: 'Full detail of a run: per-step executions, per-carrier estimate and band, the materiality gate matrix, exceptions, and the event ledger. Omit runId for the latest run.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'Run id; omit for latest.' } } },
  },
  {
    name: 'fos__trigger_run',
    description: 'Start a NEW run of the process for a period (executes the deterministic engine). Returns the new run id and its gate outcome. Use when asked to "run the accrual" or "rerun".',
    inputSchema: { type: 'object', properties: { period: { type: 'string', description: 'e.g. "April 2026". Defaults to April 2026.' } } },
  },
  {
    name: 'fos__sign_off',
    description: 'IRREVERSIBLE: post the staged journal entry and advance a paused run. Only call this when the human in THIS conversation has explicitly told you to sign off / post. Otherwise explain what it would do and ask them to confirm first. Omit runId for the latest run.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, note: { type: 'string', description: 'Sign-off note for the audit ledger.' } } },
  },
  {
    name: 'fos__freeze',
    description: 'Lock a run immutable for period close. Omit runId for the latest run.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } } },
  },
  {
    name: 'fos__improvements',
    description: 'The reconcile-and-learn evidence and proposed policy changes from the latest run (the Improve loop). Use for "what would you change / how can we improve accuracy".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fos__explain_variance',
    description: 'Structured variance of the latest estimate vs the Denise trailing-average benchmark, by carrier, for narrating "why is the number what it is" or "how do we compare to the old method".',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Resolve the process this agent owns from its features (set at provisioning).
async function resolveProcessSlug(context) {
  const agentId = context && context.agentId;
  if (!agentId) return runService.PROCESS_SLUG;
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { features: true } });
  const sup = agent && agent.features && agent.features.processSupervisor;
  return (sup && sup.processSlug) || runService.PROCESS_SLUG;
}

async function latestRunId(slug) {
  const runs = await runService.listRuns(slug);
  return runs[0] ? runs[0].id : null;
}

function statusView(run) {
  const s = run.summary || {};
  const disp = s.dispositions || {};
  return {
    period: run.period,
    status: run.status,
    frozen: run.frozen,
    pointEstimate: round(s.point),
    confidenceBand: { low: round(s.low), high: round(s.high), confidence: '90%' },
    contractual: round(s.contractual),
    deniseBenchmark: round(s.denise),
    vsDenise: round(s.vsDenise),
    vsDeniseNarrative: s.vsDenise != null ? `Our estimate is ${money(Math.abs(s.vsDenise))} ${s.vsDenise >= 0 ? 'above' : 'below'} the trailing-3-month average.` : null,
    gate: { autoPost: disp.auto_post || 0, review: disp.review || 0, escalate: disp.escalate || 0 },
    autoPosted: !!s.autoPosted,
    journalEntry: s.je || null,
    needsHuman: run.status === 'awaiting_human' || run.status === 'needs_review',
    runId: run.id,
  };
}

registerToolHandler('fos__', async (toolName, input, context) => {
  try {
    const slug = await resolveProcessSlug(context);

    switch (toolName) {
      case 'fos__run_status': {
        const id = await latestRunId(slug);
        if (!id) return JSON.stringify({ message: 'No runs yet for this process. Use fos__trigger_run to start one.' });
        const run = await runService.getRun(id);
        return JSON.stringify(statusView(run));
      }

      case 'fos__list_runs': {
        const runs = await runService.listRuns(slug);
        return JSON.stringify({
          count: runs.length,
          runs: runs.map((r) => ({ runId: r.id, period: r.period, status: r.status, mode: r.mode, frozen: r.frozen, total: round(r.totalAccrual), createdAt: r.createdAt })),
        });
      }

      case 'fos__run_detail': {
        const id = input.runId || (await latestRunId(slug));
        if (!id) return JSON.stringify({ error: 'No run found.' });
        const run = await runService.getRun(id);
        if (!run) return JSON.stringify({ error: 'Run not found.' });
        const s = run.summary || {};
        return JSON.stringify({
          ...statusView(run),
          carriers: (s.carriers || []).map((c) => ({ carrier: c.key || c.carrier, point: round(c.point), low: round(c.low), high: round(c.high), baseline: round(c.baseline), disposition: c.disposition })),
          gateMatrix: (s.control && s.control.gateMatrix) || null,
          overseerQueue: (s.control && s.control.overseerQueue) || [],
          steps: (run.steps || []).map((st) => ({ order: st.order, key: st.key, name: st.name, status: st.status, decisionType: st.decisionType })),
          exceptions: (run.exceptions || []).map((e) => ({ shipmentId: e.shipmentId, type: e.type, severity: e.severity, message: e.message })),
          recentEvents: (run.events || []).slice(0, 10).map((e) => ({ actor: e.actor, action: e.action, message: e.detail && e.detail.message })),
        });
      }

      case 'fos__trigger_run': {
        if (slug !== runService.PROCESS_SLUG) {
          return JSON.stringify({ error: 'This process is not engine-bound yet, so a run cannot execute. Only freight-accrual runs today.' });
        }
        const r = await runService.executeRun({ period: input.period || 'April 2026', mode: 'adhoc', actor: 'Owner Agent' });
        return JSON.stringify({ ok: true, runId: r.runId, status: r.status, pointEstimate: round(r.point), autoPosted: r.autoPosted, message: r.autoPosted ? 'Run complete and auto-posted (all carriers within tolerance).' : `Run complete and PAUSED at the gate (${r.status}). A human must sign off before the JE posts.` });
      }

      case 'fos__sign_off': {
        const id = input.runId || (await latestRunId(slug));
        if (!id) return JSON.stringify({ error: 'No run to sign off.' });
        const r = await runService.signOff(id, { actor: 'Owner Agent (on human instruction)', note: input.note || 'Signed off via process owner agent.' });
        return JSON.stringify({ ok: true, runId: r.runId, status: r.status, posted: true, message: `Journal entry posted: ${money(r.point)} accrued freight. Run advanced to ${r.status}.` });
      }

      case 'fos__freeze': {
        const id = input.runId || (await latestRunId(slug));
        if (!id) return JSON.stringify({ error: 'No run to freeze.' });
        const r = await runService.freezeRun(id, { actor: 'Owner Agent (on human instruction)' });
        return JSON.stringify({ ok: true, runId: r.runId, frozen: true, message: 'Run frozen for period close — now immutable.' });
      }

      case 'fos__improvements': {
        const id = await latestRunId(slug);
        if (!id) return JSON.stringify({ message: 'No runs yet.' });
        const run = await runService.getRun(id);
        const learn = (run.summary && run.summary.learning) || {};
        return JSON.stringify({
          coverage: learn.coverage,
          monthsReplayed: learn.monthsReplayed,
          maeByCarrier: learn.maeByCarrier,
          proposals: learn.proposals || [],
          note: 'These are proposed policy-parameter changes. The next run recomputes derived values under any change applied. Nothing is applied automatically.',
        });
      }

      case 'fos__explain_variance': {
        const id = await latestRunId(slug);
        if (!id) return JSON.stringify({ message: 'No runs yet.' });
        const run = await runService.getRun(id);
        const s = run.summary || {};
        return JSON.stringify({
          period: run.period,
          pointEstimate: round(s.point),
          deniseBenchmark: round(s.denise),
          vsDenise: round(s.vsDenise),
          byCarrier: (s.carriers || []).map((c) => ({ carrier: c.key || c.carrier, estimate: round(c.point), benchmark: round(c.baseline), diff: round((c.point || 0) - (c.baseline || 0)) })),
          method: 'Inverse-variance ensemble of the contractual rate-card price and the trailing baseline, with a mix-shift lift and a 90% confidence band. The benchmark is the trailing-3-month average (the Denise method).',
        });
      }

      default:
        return JSON.stringify({ error: `Unknown fos tool: ${toolName}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message || String(err) });
  }
});

module.exports = { FOS_TOOLS };
