// Phase 1 — Stepped runner + persistence.
//
// Wraps the validated deterministic engine (accrualService.runAccrual) in the
// Process/Run/Step model: it reads policy params from the DB (pinned per run),
// executes the accrual as an ordered list of Steps, and writes one StepExecution
// per step (input -> processing -> policies applied -> outcome). The materiality
// gate sits BEFORE the JE post (plan G4): when a carrier escalates, the run pauses
// at `awaiting_human` and the JE is staged but NOT posted until a human signs off.
//
// Deterministic by default, agentic by exception: the routine auto-posts; only
// the exceptions wait for the overseer.

const prisma = require('../db');
const { runAccrual } = require('./accrualService');

const PROCESS_SLUG = 'freight-accrual';
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => (n == null ? '--' : '$' + Math.round(n).toLocaleString('en-US'));

// ── Load the process + its policies, return a params lookup + pinned versions ──
async function loadProcessContext() {
  const process = await prisma.process.findFirst({
    where: { slug: PROCESS_SLUG },
    include: { steps: { orderBy: { order: 'asc' } }, policies: true },
  });
  if (!process) throw new Error('Freight Accrual process not seeded. Run: node prisma/seed.js');
  const policyByKey = {};
  const pinnedVersions = {};
  for (const p of process.policies) {
    policyByKey[p.key] = p;
    pinnedVersions[`policy:${p.key}`] = p.version;
  }
  return { process, policyByKey, pinnedVersions };
}

function param(policyByKey, key, field, fallback) {
  const p = policyByKey[key];
  if (p && p.params && p.params[field] != null) return p.params[field];
  return fallback;
}

// ── Decompose the engine result into 10 StepExecution payloads ────────────────
function buildStepExecutions(result, policyByKey, stepByKey) {
  const dq = result.ingestion.dataQualitySummary || {};
  const c = result.carriers;
  const portfolio = result.portfolio;
  const carrierOutcome = (sel) => c.reduce((o, x) => { o[x.key] = round2(sel(x)); return o; }, {});

  const oot = result.exceptions.filter((x) => x.type === 'out_of_territory').length;

  const steps = [
    {
      key: 'ingest', decisionType: 'policy_based',
      input: { source: 'shipments_apr2026.csv', rowsRead: result.ingestion.shipments + (dq.duplicate || 0) },
      processing: { rule: 'dedup by shipment_id; infer missing weight from median lbs/unit per carrier' },
      policiesApplied: [],
      outcome: { shipments: result.ingestion.shipments, duplicatesRemoved: dq.duplicate || 0, weightsInferred: dq.weight_estimated || 0, dataQualityNotes: result.ingestion.dataQuality.length, headline: `${result.ingestion.shipments} shipments` },
    },
    {
      key: 'normalize', decisionType: 'policy_based',
      input: { shipments: result.ingestion.shipments },
      processing: { rule: 'normalize carrier names + service levels; resolve territory/lane; flag out-of-territory' },
      policiesApplied: [],
      outcome: { carriersResolved: 3, outOfTerritoryFlags: oot, headline: `3 carriers${oot ? ` · ${oot} OOT` : ''}` },
    },
    {
      key: 'price', decisionType: 'policy_based',
      input: { shipments: result.ingestion.shipments, rateCards: 3 },
      processing: { rule: 'deterministic per-carrier pricing: base + fuel + accessorials + floors' },
      policiesApplied: [],
      outcome: { byCarrier: carrierOutcome((x) => x.contractual), contractualTotal: portfolio.contractual, headline: money(portfolio.contractual) },
    },
    {
      key: 'calibrate', decisionType: 'judgment_based',
      input: { invoiceHistory: result.ingestion.invoicesAnalyzed },
      processing: { method: param(policyByKey, 'calibration_method', 'central', 'median'), level: param(policyByKey, 'calibration_method', 'level', 'month') },
      policiesApplied: ['calibration_method'],
      outcome: { factors: { peak: result.calibration.peak.factor, heartland: result.calibration.heartland.factor, coastal: result.calibration.coastal.factor }, headline: `×${result.calibration.peak.factor} / ×${result.calibration.heartland.factor} / ×${result.calibration.coastal.factor}` },
    },
    {
      key: 'baseline', decisionType: 'policy_based',
      input: { months: param(policyByKey, 'baseline_window', 'months', 3) },
      processing: { rule: `trailing ${param(policyByKey, 'baseline_window', 'months', 3)}-month average of actuals (Denise method)` },
      policiesApplied: ['baseline_window'],
      outcome: (() => { const benchmarkTotal = round2(c.reduce((s, x) => s + (x.baseline || 0), 0)); return { byCarrier: carrierOutcome((x) => x.baseline), benchmarkTotal, headline: money(benchmarkTotal) }; })(),
    },
    {
      key: 'estimate', decisionType: 'judgment_based',
      input: { contractual: portfolio.contractual, baselineBlend: true },
      processing: { ensemble: param(policyByKey, 'estimation_method', 'ensemble', 'inverse_variance'), mixShiftZ: param(policyByKey, 'estimation_method', 'mixShiftZ', 1.0), bandZ: param(policyByKey, 'estimation_method', 'bandZ', 1.645) },
      policiesApplied: ['estimation_method'],
      outcome: { byCarrier: carrierOutcome((x) => x.point), point: portfolio.point, low: portfolio.low, high: portfolio.high, headline: money(portfolio.point) },
    },
    {
      key: 'exceptions', decisionType: 'policy_based',
      input: { shipments: result.ingestion.shipments },
      processing: { rule: 'severity mapping critical/warning/info' },
      policiesApplied: [],
      outcome: { total: result.exceptions.length, summary: result.exceptionSummary, critical: result.exceptions.filter((x) => x.severity === 'critical').map((x) => ({ id: x.shipmentId, type: x.type, message: x.message })), headline: `${result.exceptions.length} raised` },
    },
    {
      key: 'gate', decisionType: 'policy_based', isGate: true,
      input: { materialityThreshold: param(policyByKey, 'materiality_gate', 'materialityThreshold', 1500), maxCv: param(policyByKey, 'materiality_gate', 'maxCv', 0.15) },
      processing: { rule: 'auto_post only if half-band < materiality AND CV < maxCv; else review/escalate' },
      policiesApplied: ['materiality_gate'],
      outcome: (() => { const d = result.control.dispositions; return { dispositions: d, gateMatrix: result.control.gateMatrix, overseerQueue: result.control.overseerQueue, headline: `${d.auto_post || 0} auto · ${d.review || 0} review · ${d.escalate || 0} escalate` }; })(),
    },
    {
      key: 'post_je', decisionType: 'policy_based',
      input: { je: result.je },
      processing: { rule: 'post balanced JE only after gate clears or human sign-off' },
      policiesApplied: ['je_accounts'],
      outcome: { staged: true, posted: false, je: result.je },
    },
    {
      key: 'reconcile_learn', decisionType: 'judgment_based',
      input: { lookbackRuns: param(policyByKey, 'improve_trigger', 'lookbackRuns', 6) },
      processing: { rule: 'forward-replay reconciliation; propose param changes' },
      policiesApplied: ['improve_trigger'],
      outcome: { coverage: result.learning.coverage, monthsReplayed: result.learning.monthsReplayed, proposals: result.learning.proposals, headline: `${(result.learning.coverage && result.learning.coverage.pct) || 0}% band coverage` },
    },
  ];

  return steps.map((s) => ({
    stepId: stepByKey[s.key] ? stepByKey[s.key].id : null,
    order: stepByKey[s.key] ? stepByKey[s.key].order : 0,
    key: s.key,
    name: stepByKey[s.key] ? stepByKey[s.key].name : s.key,
    decisionType: s.decisionType,
    input: s.input,
    processing: s.processing,
    policiesApplied: s.policiesApplied,
    outcome: s.outcome,
    isGate: !!s.isGate,
  }));
}

// ── Execute a run end to end and persist it ───────────────────────────────────
async function executeRun({ period = 'April 2026', mode = 'manual', actor = 'Accrual Agent' } = {}) {
  const { process, policyByKey, pinnedVersions } = await loadProcessContext();
  const stepByKey = {};
  for (const s of process.steps) stepByKey[s.key] = s;

  // Read tunable params from policies (plan G1: params = Policy)
  const materialityThreshold = param(policyByKey, 'materiality_gate', 'materialityThreshold', 1500);
  const maxCv = param(policyByKey, 'materiality_gate', 'maxCv', 0.15);
  // Estimation methodology params (the Improve plane's primary tuning target).
  const bandZ = param(policyByKey, 'estimation_method', 'bandZ', 1.645);
  const mixShiftZ = param(policyByKey, 'estimation_method', 'mixShiftZ', 1);

  // Run the validated deterministic engine
  const result = runAccrual({ period, materialityThreshold, maxCv, bandZ, mixShiftZ });

  const dispositions = result.control.dispositions;
  const escalate = dispositions.escalate > 0;
  const review = dispositions.review > 0;
  // Gate-before-post: pause if anything escalates; review if anything flags; else auto-post.
  const runStatus = escalate ? 'awaiting_human' : review ? 'needs_review' : 'posted';
  const autoPosted = runStatus === 'posted';

  const stepExecs = buildStepExecutions(result, policyByKey, stepByKey);

  // Create the run
  const run = await prisma.accrualRun.create({
    data: {
      processId: process.id,
      period,
      mode,
      status: runStatus,
      frozen: false,
      pinnedVersions,
      totalAccrual: result.portfolio.point,
      summary: {
        period,
        contractual: result.portfolio.contractual,
        point: result.portfolio.point,
        low: result.portfolio.low,
        high: result.portfolio.high,
        denise: result.portfolio.denise,
        vsDenise: result.portfolio.vsDenise,
        dispositions,
        materialityThreshold,
        maxCv,
        bandZ,
        mixShiftZ,
        carriers: result.carriers,
        je: result.je,
        calibration: result.calibration,
        learning: { coverage: result.learning.coverage, monthsReplayed: result.learning.monthsReplayed, proposals: result.learning.proposals, maeByCarrier: result.learning.maeByCarrier },
        control: result.control,
        exceptionSummary: result.exceptionSummary,
        autoPosted,
      },
    },
  });

  const now = Date.now();
  await prisma.stepExecution.createMany({
    data: stepExecs.map((s, i) => {
      // post_je waits when paused; everything else done. reconcile_learn is evidence (done).
      let status = 'done';
      if (s.key === 'post_je') status = autoPosted ? 'done' : 'awaiting_human';
      const outcome = s.key === 'post_je'
        ? { ...s.outcome, posted: autoPosted, headline: `${autoPosted ? 'posted ' : 'staged '}${money((s.outcome.je && s.outcome.je.total) || 0)}` }
        : s.outcome;
      return {
        runId: run.id, stepId: s.stepId, order: s.order, key: s.key, name: s.name,
        status, decisionType: s.decisionType,
        input: s.input, processing: s.processing, policiesApplied: s.policiesApplied, outcome,
        startedAt: new Date(now + i * 10), finishedAt: status === 'awaiting_human' ? null : new Date(now + i * 10 + 5),
      };
    }),
  });

  // Persist accrual lines (per-shipment auditable breakdown)
  if (result.lines && result.lines.length) {
    await prisma.accrualLine.createMany({
      data: result.lines.map((l) => ({
        runId: run.id, shipmentId: l.shipmentId, carrier: l.carrier,
        baseCharge: round2(l.base || 0), fuelSurcharge: round2(l.fuel || 0),
        accessorialFees: round2(l.accessorials || 0), total: round2(l.total || 0),
        breakdown: l.breakdown || {}, flags: l.flags || [],
      })),
    });
  }

  // Persist exceptions
  if (result.exceptions && result.exceptions.length) {
    await prisma.exception.createMany({
      data: result.exceptions.map((x) => ({
        runId: run.id, shipmentId: x.shipmentId || null, type: x.type,
        severity: x.severity || 'warning', message: x.message,
      })),
    });
  }

  // Event ledger (append-only system of record)
  const events = (result.events || []).slice().reverse(); // back to chronological for insert order
  await prisma.ledgerEvent.create({ data: { runId: run.id, actor, action: 'RUN_STARTED', detail: { period, mode } } });
  for (const e of events) {
    await prisma.ledgerEvent.create({ data: { runId: run.id, actor, action: e.type, detail: { plane: e.plane, tag: e.tag, message: e.message } } });
  }
  await prisma.ledgerEvent.create({
    data: {
      runId: run.id, actor: 'Materiality Gate', action: 'GATE',
      detail: { dispositions, decision: runStatus, message: autoPosted ? 'All carriers within tolerance — auto-posting.' : `Paused: ${dispositions.escalate} escalate, ${dispositions.review} review. Awaiting overseer sign-off before JE post.` },
    },
  });

  return { runId: run.id, status: runStatus, point: result.portfolio.point, autoPosted };
}

// ── Sign-off: a human says "go on" — post the staged JE and advance the run ────
async function signOff(runId, { actor = 'Controller', note = '' } = {}) {
  const run = await prisma.accrualRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error('Run not found');
  if (run.frozen) throw new Error('Run is frozen — cannot modify. Create a new run.');
  if (run.status === 'posted' || run.status === 'reconciled') {
    return { runId, status: run.status, alreadyPosted: true };
  }

  // Advance the post_je step
  const postStep = await prisma.stepExecution.findFirst({ where: { runId, key: 'post_je' } });
  if (postStep) {
    await prisma.stepExecution.update({
      where: { id: postStep.id },
      data: { status: 'done', finishedAt: new Date(), outcome: { ...postStep.outcome, posted: true, postedBy: actor, postedAt: new Date().toISOString(), headline: `posted ${money((postStep.outcome.je && postStep.outcome.je.total) || run.totalAccrual)}` }, override: note ? { signOffNote: note } : undefined },
    });
  }

  await prisma.accrualRun.update({
    where: { id: runId },
    data: { status: 'posted', summary: { ...run.summary, posted: true, postedBy: actor, postedAt: new Date().toISOString() } },
  });

  await prisma.ledgerEvent.create({
    data: { runId, actor, action: 'SIGN_OFF', detail: { message: `Overseer signed off — JE posted: ${money(run.totalAccrual)} to 2150 Accrued Freight.`, note } },
  });

  return { runId, status: 'posted', point: run.totalAccrual };
}

// ── Freeze: lock the run immutable (period close) ─────────────────────────────
async function freezeRun(runId, { actor = 'Controller' } = {}) {
  const run = await prisma.accrualRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error('Run not found');
  await prisma.accrualRun.update({ where: { id: runId }, data: { frozen: true } });
  await prisma.ledgerEvent.create({ data: { runId, actor, action: 'FREEZE', detail: { message: 'Run frozen for period close — now immutable.' } } });
  return { runId, frozen: true };
}

// ── Read a full run for the UI ────────────────────────────────────────────────
async function getRun(runId) {
  return prisma.accrualRun.findUnique({
    where: { id: runId },
    include: {
      process: true,
      steps: { orderBy: { order: 'asc' } },
      lines: true,
      exceptions: { orderBy: { severity: 'asc' } },
      events: { orderBy: { createdAt: 'desc' } },
      reconciliations: true,
    },
  });
}

async function listRuns(processSlug = PROCESS_SLUG) {
  const process = await prisma.process.findFirst({ where: { slug: processSlug } });
  if (!process) return [];
  return prisma.accrualRun.findMany({
    where: { processId: process.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, period: true, status: true, mode: true, frozen: true, totalAccrual: true, createdAt: true, parentRunId: true },
  });
}

// ── Richer run list for the History tab: headline numbers + step/exception counts ──
async function listRunHistory(processSlug = PROCESS_SLUG) {
  const process = await prisma.process.findFirst({ where: { slug: processSlug } });
  if (!process) return [];
  const runs = await prisma.accrualRun.findMany({
    where: { processId: process.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { steps: true, exceptions: true, lines: true } } },
  });
  return runs.map((r) => {
    const sm = r.summary || {};
    return {
      id: r.id,
      period: r.period,
      status: r.status,
      mode: r.mode,
      frozen: r.frozen,
      parentRunId: r.parentRunId,
      createdAt: r.createdAt,
      point: sm.scaffold ? null : r.totalAccrual,
      contractual: sm.contractual ?? null,
      denise: sm.denise ?? null,
      vsDenise: sm.vsDenise ?? null,
      dispositions: sm.dispositions || { auto_post: 0, review: 0, escalate: 0 },
      autoPosted: !!sm.autoPosted,
      stepCount: r._count.steps,
      exceptionCount: r._count.exceptions,
      lineCount: r._count.lines,
    };
  });
}

module.exports = { executeRun, signOff, freezeRun, getRun, listRuns, listRunHistory, loadProcessContext, PROCESS_SLUG };
