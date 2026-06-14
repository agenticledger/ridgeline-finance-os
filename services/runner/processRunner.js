// Generic process runner (GENERIC_RUNNER_PLAN Phase 1 / SPEC §7).
//
// runProcess({ processSlug, period, mode, actor }) is the ONE entry point for
// executing any process. The freight-accrual path is validated and must never
// change, so freight DELEGATES to the untouched runService.executeRun via the
// engine registry. Any other process runs a generic scaffold that produces a
// real, persisted, visualizable Run (AccrualRun + one StepExecution per step +
// LedgerEvents), topologically ordered by Step.dependsOn.
//
// The agent is NOT in the critical path: execution is deterministic code.

const prisma = require('../db');
const runService = require('../accrual/runService');

// Engine registry — slug → engine fn. Freight is the only engine-bound process
// today; it delegates 100% to the validated path (zero change to that code).
const ENGINES = {
  'freight-accrual': (args) => runService.executeRun(args),
};

// Topologically sort steps by dependsOn (forward data deps). Feedback edges
// (feedbackTo) are intentionally ignored here so the graph stays acyclic for
// ordering. Falls back to declared `order` for stability and for linear chains.
function topoSort(steps) {
  const byKey = {};
  for (const s of steps) byKey[s.key] = s;
  const state = {}; // undefined=unvisited, 1=visiting, 2=done
  const ordered = [];
  function visit(s) {
    if (state[s.key] === 2) return;
    if (state[s.key] === 1) throw new Error(`Cycle detected in process DAG at step '${s.key}'`);
    state[s.key] = 1;
    for (const dep of s.dependsOn || []) {
      if (byKey[dep]) visit(byKey[dep]);
    }
    state[s.key] = 2;
    ordered.push(s);
  }
  for (const s of steps.slice().sort((a, b) => a.order - b.order)) visit(s);
  return ordered;
}

// Generic scaffold run for a process with no registered engine. Produces a real
// persisted run so the standard tabs (Flow/History/Execute) can render it.
async function runScaffold(process, period, mode, actor) {
  const steps = process.steps.slice().sort((a, b) => a.order - b.order);
  const ordered = topoSort(steps);
  const hasGate = steps.some((s) => s.isGate);
  // Scaffold has no escalate signal; auto-posts. A real engine sets escalate →
  // awaiting_human via the registry path; the gate hook is left here for that.
  const runStatus = 'posted';

  const run = await prisma.accrualRun.create({
    data: {
      processId: process.id,
      period,
      mode,
      status: runStatus,
      frozen: false,
      pinnedVersions: {},
      totalAccrual: 0,
      summary: { scaffold: true, stepCount: steps.length, processVersion: process.version },
    },
  });

  const now = Date.now();
  await prisma.stepExecution.createMany({
    data: ordered.map((s, i) => ({
      runId: run.id,
      stepId: s.id,
      order: s.order,
      key: s.key,
      name: s.name,
      status: 'done',
      decisionType: s.decisionType,
      input: { fromSteps: s.dependsOn || [] },
      processing: { engineSource: s.engineSource || 'scaffold' },
      policiesApplied: [],
      outcome: { scaffold: true, headline: s.engineSource ? `ran ${s.engineSource}` : 'step complete' },
      startedAt: new Date(now + i * 10),
      finishedAt: new Date(now + i * 10 + 5),
    })),
  });

  await prisma.ledgerEvent.create({
    data: { runId: run.id, actor, action: 'RUN_STARTED', detail: { period, mode, scaffold: true } },
  });
  await prisma.ledgerEvent.create({
    data: {
      runId: run.id, actor: 'Process Runner', action: 'GATE',
      detail: {
        decision: runStatus, hasGate,
        message: hasGate
          ? 'Scaffold run — gate present but no escalate signal; auto-posted.'
          : 'Scaffold run — no gate; auto-posted.',
      },
    },
  });

  return { runId: run.id, status: runStatus, autoPosted: true };
}

// THE entry point. Freight delegates to the validated engine; everything else
// runs the generic scaffold.
async function runProcess({ processSlug, period = 'April 2026', mode = 'manual', actor = 'Accrual Agent' } = {}) {
  if (!processSlug) throw new Error('runProcess requires a processSlug');
  if (ENGINES[processSlug]) {
    return ENGINES[processSlug]({ period, mode, actor });
  }
  const process = await prisma.process.findFirst({
    where: { slug: processSlug },
    include: { steps: { orderBy: { order: 'asc' } }, policies: true },
  });
  if (!process) throw new Error(`Process not found: ${processSlug}`);
  return runScaffold(process, period, mode, actor);
}

module.exports = { runProcess, runScaffold, topoSort, ENGINES };
