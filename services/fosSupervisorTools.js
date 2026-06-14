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
const { runProcess } = require('./runner/processRunner');
const builder = require('./builder/processBuilder');

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
    name: 'fos__action_items',
    description: 'List the per-item action queue for a run: each item the overseer must clear (approve or mark N/A) before the run can be signed off. Use this to answer "what is left / what needs clearing" and to get item ids for fos__clear_action. Omit runId for the latest run.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'Run id; omit for latest.' } } },
  },
  {
    name: 'fos__clear_action',
    description: 'Clear a single action item — approve it or mark it N/A, with an optional note. Every item must be cleared before fos__sign_off will post. Only call when the human in THIS conversation has told you how to dispose of the item. Get item ids from fos__action_items.',
    inputSchema: { type: 'object', properties: {
      itemId: { type: 'string', description: 'Action item id to clear.' },
      status: { type: 'string', enum: ['approved', 'na'], description: 'Disposition: approved or na (not applicable).' },
      note: { type: 'string', description: 'Optional note recorded on the item + audit ledger.' },
    }, required: ['itemId', 'status'] },
  },
  {
    name: 'fos__sign_off',
    description: 'IRREVERSIBLE: post the staged journal entry and advance a paused run. Only call this when the human in THIS conversation has explicitly told you to sign off / post. Otherwise explain what it would do and ask them to confirm first. Blocked until every action item is cleared (see fos__action_items / fos__clear_action). Omit runId for the latest run.',
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

  // ── Builder hat (SPEC §11) — engineer the process you own, agentically. ──
  // Every change is versioned at the object level and written to your build_log.
  {
    name: 'fos__create_step',
    description: 'BUILDER: add a new step to the process you own. Steps form a DAG via dependsOn (the steps whose output this step consumes) and an optional feedbackTo (an upstream step this one proposes changes back to — the improve loop). Set isGate for a materiality/approval gate and pauseAfter to halt for a human.',
    inputSchema: { type: 'object', properties: {
      key: { type: 'string', description: 'Short stable key, e.g. "normalize". Derived from name if omitted.' },
      name: { type: 'string', description: 'Human step name.' },
      description: { type: 'string' },
      decisionType: { type: 'string', enum: ['policy_based', 'judgment_based', 'mixed'] },
      dependsOn: { type: 'array', items: { type: 'string' }, description: 'Keys of upstream steps this consumes.' },
      feedbackTo: { type: 'string', description: 'Key of an upstream step this proposes changes back to.' },
      isGate: { type: 'boolean' }, pauseAfter: { type: 'boolean' },
    }, required: ['name'] },
  },
  {
    name: 'fos__update_step',
    description: 'BUILDER: edit an existing step (name, description, decisionType, dependsOn, feedbackTo, isGate, pauseAfter). Identified by its key. Bumps the step version and logs the diff.',
    inputSchema: { type: 'object', properties: {
      key: { type: 'string', description: 'Key of the step to edit.' },
      name: { type: 'string' }, description: { type: 'string' },
      decisionType: { type: 'string', enum: ['policy_based', 'judgment_based', 'mixed'] },
      dependsOn: { type: 'array', items: { type: 'string' } }, feedbackTo: { type: 'string' },
      isGate: { type: 'boolean' }, pauseAfter: { type: 'boolean' },
    }, required: ['key'] },
  },
  {
    name: 'fos__reorder_steps',
    description: 'BUILDER: set the execution order of the steps. Provide every step key exactly once in the desired order.',
    inputSchema: { type: 'object', properties: { order: { type: 'array', items: { type: 'string' } } }, required: ['order'] },
  },
  {
    name: 'fos__set_engine',
    description: 'BUILDER: bind a deterministic engine to a step. Writes an engine file under services/engines/{slug}/ and records it as the step\'s engineSource (the auditable "what computed this step"). Provide the engine body as code, or omit to scaffold a stub.',
    inputSchema: { type: 'object', properties: {
      stepKey: { type: 'string', description: 'Key of the step to bind.' },
      language: { type: 'string', enum: ['js', 'py'], description: 'Engine file language. Default js.' },
      code: { type: 'string', description: 'The engine source body.' },
      engineName: { type: 'string', description: 'Override the recorded engineSource label.' },
    }, required: ['stepKey'] },
  },
  {
    name: 'fos__create_policy',
    description: 'BUILDER: add a tunable policy to the process. params is a versioned JSON object (the knobs); the definition explains what it governs. Optionally bind it to a step via stepKey.',
    inputSchema: { type: 'object', properties: {
      key: { type: 'string' }, name: { type: 'string' }, definition: { type: 'string' },
      params: { type: 'object' }, scope: { type: 'string', enum: ['org', 'function', 'process', 'step'] },
      stepKey: { type: 'string' },
    }, required: ['name'] },
  },
  {
    name: 'fos__update_policy',
    description: 'BUILDER: edit a policy (name, definition, or params). A params patch merges by key. Bumps the policy version and writes an ObjectVersion + build_log entry.',
    inputSchema: { type: 'object', properties: {
      key: { type: 'string', description: 'Key of the policy to edit.' },
      name: { type: 'string' }, definition: { type: 'string' }, params: { type: 'object' },
    }, required: ['key'] },
  },
  {
    name: 'fos__attach_tool',
    description: 'BUILDER: attach a tool/skill to the process (and optionally a step). Reference an existing registry tool by toolSlug, or create one with type+name. Types: skill, mcp, agent, human, prompt, automation.',
    inputSchema: { type: 'object', properties: {
      toolSlug: { type: 'string', description: 'Existing registry tool slug.' },
      type: { type: 'string', enum: ['skill', 'mcp', 'agent', 'human', 'prompt', 'automation'] },
      name: { type: 'string' }, description: { type: 'string' }, config: { type: 'object' },
      stepKey: { type: 'string', description: 'Also attach to this step.' }, role: { type: 'string' },
    } },
  },
  {
    name: 'fos__snapshot_package',
    description: 'BUILDER: freeze the entire process package (steps, policies, tools) as a new package version. Bumps Process.version and writes a process_package ObjectVersion snapshot for rollback/audit. Call this after a coherent set of edits.',
    inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'What this version represents.' } } },
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
        const r = await runProcess({ processSlug: slug, period: input.period || 'April 2026', mode: 'adhoc', actor: 'Owner Agent' });
        const isFreight = slug === runService.PROCESS_SLUG;
        return JSON.stringify({
          ok: true, runId: r.runId, status: r.status, pointEstimate: round(r.point), autoPosted: r.autoPosted,
          message: isFreight
            ? (r.autoPosted ? 'Run complete and auto-posted (all carriers within tolerance).' : `Run complete and PAUSED at the gate (${r.status}). A human must sign off before the JE posts.`)
            : `Run complete (${r.status}). This process runs as a generic scaffold until an engine is set on its steps.`,
        });
      }

      case 'fos__action_items': {
        const id = input.runId || (await latestRunId(slug));
        if (!id) return JSON.stringify({ error: 'No run found.' });
        const items = await prisma.actionItem.findMany({ where: { runId: id }, orderBy: { ord: 'asc' } });
        const open = items.filter((i) => i.status === 'open').length;
        return JSON.stringify({
          runId: id, open, total: items.length,
          readyToSignOff: open === 0,
          items: items.map((i) => ({ id: i.id, severity: i.severity, title: i.title, detail: i.detail, amount: round(i.amount), status: i.status, note: i.note, clearedBy: i.clearedBy })),
        });
      }

      case 'fos__clear_action': {
        if (!input.itemId) return JSON.stringify({ error: 'itemId is required.' });
        const r = await runService.clearActionItem(input.itemId, { status: input.status, note: input.note || '', actor: 'Owner Agent (on human instruction)' });
        return JSON.stringify({ ok: true, itemId: input.itemId, status: r.item.status, openRemaining: r.openCount, message: r.openCount === 0 ? 'All action items cleared — the run can now be signed off.' : `Item cleared. ${r.openCount} still open.` });
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

      // ── Builder hat handlers ──────────────────────────────────────────────
      case 'fos__create_step': {
        const r = await builder.createStep(slug, input, 'Owner Agent (Builder)');
        return JSON.stringify({ ...r, message: `Step '${input.name}' added at #${r.order}.` });
      }
      case 'fos__update_step': {
        const { key, ...patch } = input;
        const r = await builder.updateStep(slug, key, patch, 'Owner Agent (Builder)');
        return JSON.stringify({ ...r, message: `Step '${key}' updated (v${r.version}): ${r.changed.join(', ')}.` });
      }
      case 'fos__reorder_steps': {
        const r = await builder.reorderSteps(slug, input.order || [], 'Owner Agent (Builder)');
        return JSON.stringify({ ...r, message: `Steps reordered: ${r.order.join(' → ')}.` });
      }
      case 'fos__set_engine': {
        const { stepKey, ...opts } = input;
        const r = await builder.setEngine(slug, stepKey, opts, 'Owner Agent (Builder)');
        return JSON.stringify({ ...r, message: `Engine bound to '${stepKey}' as ${r.engineSource} (${r.file}).` });
      }
      case 'fos__create_policy': {
        const r = await builder.createPolicy(slug, input, 'Owner Agent (Builder)');
        return JSON.stringify({ ...r, message: `Policy '${input.name}' added.` });
      }
      case 'fos__update_policy': {
        const { key, ...patch } = input;
        const r = await builder.updatePolicy(slug, key, patch, 'Owner Agent (Builder)');
        return JSON.stringify({ ...r, message: `Policy '${key}' updated (v${r.version}): ${r.changed.join(', ')}.` });
      }
      case 'fos__attach_tool': {
        const r = await builder.attachTool(slug, input, 'Owner Agent (Builder)');
        return JSON.stringify({ ...r, message: `Tool '${r.tool.name}' attached${r.attachedToStep ? ` to step '${r.attachedToStep}'` : ''}.` });
      }
      case 'fos__snapshot_package': {
        const r = await builder.snapshotPackage(slug, input, 'Owner Agent (Builder)');
        return JSON.stringify({ ...r, message: `Package frozen at v${r.packageVersion} (${r.steps} steps, ${r.policies} policies).` });
      }

      default:
        return JSON.stringify({ error: `Unknown fos tool: ${toolName}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message || String(err) });
  }
});

module.exports = { FOS_TOOLS };
