// Phase 0 seed — loads the challenge data into the DB and stands up the
// generalized Process model with the Freight Accrual process as the first
// process loaded onto the Finance OS.
//
//   node prisma/seed.js            (idempotent — safe to re-run)

const { PrismaClient } = require('@prisma/client');
const { ingestShipments, ingestInvoices, ingestDenise } = require('../services/accrual/ingest');
const { PEAK, HEARTLAND, COASTAL } = require('../services/accrual/rateConfig');

const prisma = new PrismaClient();

async function loadData() {
  // ── Shipments (April 2026 activity) ──────────────────────────────
  const { shipments } = ingestShipments('shipments_apr2026.csv', 'April 2026');
  await prisma.shipment.deleteMany({ where: { period: 'April 2026' } });
  await prisma.shipment.createMany({
    data: shipments.map((s) => ({
      shipmentId: s.shipmentId,
      date: new Date(s.date),
      originCity: s.originCity, originState: s.originState,
      destCity: s.destCity, destState: s.destState, destZip: s.destZip,
      carrierRaw: s.carrierRaw, carrier: s.carrier,
      serviceLevelRaw: s.serviceLevelRaw, serviceLevel: s.serviceLevel,
      weightLbs: s.weightLbs, weightEstimated: s.weightEstimated,
      units: s.units, residential: s.residential,
      specialHandling: s.specialHandling, period: s.period,
    })),
  });
  console.log(`  shipments: ${shipments.length}`);

  // ── Invoices (Oct 2025 – Mar 2026 history) ───────────────────────
  const invoices = ingestInvoices();
  await prisma.invoice.deleteMany({});
  await prisma.invoice.createMany({
    data: invoices.filter((i) => i.carrier).map((i) => ({
      invoiceId: i.invoiceId, carrier: i.carrier,
      invoiceDate: new Date(i.invoiceDate), serviceMonth: i.serviceMonth,
      shipmentRef: i.shipmentRef, destCity: i.destCity, destState: i.destState, destZip: i.destZip,
      weightLbs: i.weightLbs, baseCharge: i.baseCharge, fuelSurcharge: i.fuelSurcharge,
      accessorialFees: i.accessorialFees, accessorialDetail: i.accessorialDetail,
      adjustments: i.adjustments, totalCharge: i.totalCharge,
    })),
  });
  console.log(`  invoices: ${invoices.length}`);

  // ── Denise baseline (the benchmark to beat) ──────────────────────
  const denise = ingestDenise();
  await prisma.deniseBaseline.deleteMany({});
  await prisma.deniseBaseline.createMany({
    data: denise.filter((d) => d.carrier).map((d) => ({
      month: d.month, carrier: d.carrier,
      accrualEstimate: d.accrualEstimate, actualInvoiced: d.actualInvoiced,
      varianceDollars: d.varianceDollars, variancePct: d.variancePct, notes: d.notes,
    })),
  });
  console.log(`  denise rows: ${denise.length}`);

  // ── Rate cards (versioned config) ────────────────────────────────
  for (const card of [PEAK, HEARTLAND, COASTAL]) {
    await prisma.rateCard.upsert({
      where: { carrier_version: { carrier: card.carrier, version: card.version } },
      update: { data: card, effective: new Date(card.effective), isActive: true },
      create: { carrier: card.carrier, version: card.version, effective: new Date(card.effective), data: card, isActive: true },
    });
  }
  console.log('  rate cards: 3');
}

// The 9-step accrual process + the Improve step, expressed as data (plan §B.1).
const STEPS = [
  { order: 1, key: 'ingest', name: 'Ingest', engineSource: 'ingest.js', decisionType: 'policy_based', desc: 'Parse April shipments, dedupe, infer missing weights from unit medians.' },
  { order: 2, key: 'normalize', name: 'Normalize', engineSource: 'normalize.js', decisionType: 'policy_based', desc: 'Resolve carrier names, territories and lanes; flag out-of-territory.' },
  { order: 3, key: 'price', name: 'Price', engineSource: 'rateEngine.js + rateConfig.js', decisionType: 'policy_based', desc: 'Deterministically price every lane from the contract rate card (base, fuel, accessorials, floors).' },
  { order: 4, key: 'calibrate', name: 'Calibrate factor', engineSource: 'calibrate.js', decisionType: 'judgment_based', desc: 'Learn the realization factor from 6 months of invoice history (month-level, median-central, mean-reverting).' },
  { order: 5, key: 'baseline', name: 'Baseline', engineSource: 'baseline.js', decisionType: 'policy_based', desc: 'Compute the trailing-3-month average (the Denise benchmark) for an honest side-by-side.' },
  { order: 6, key: 'estimate', name: 'Estimate', engineSource: 'estimate.js', decisionType: 'judgment_based', desc: 'Inverse-variance ensemble of engine vs baseline; mix-shift lift; 90% confidence band.' },
  { order: 7, key: 'exceptions', name: 'Exceptions', engineSource: 'compute.js', decisionType: 'policy_based', desc: 'Raise and rank exceptions (critical / warning / info) for overseer review.' },
  { order: 8, key: 'gate', name: 'Materiality gate', engineSource: 'accrualService.js', decisionType: 'policy_based', isGate: true, pauseAfter: true, desc: 'Materiality x confidence gate → auto_post / review / escalate. Pauses the run before posting when a carrier escalates.' },
  { order: 9, key: 'post_je', name: 'Post journal entry', engineSource: 'accrualService.js', decisionType: 'policy_based', desc: 'Post the balanced JE (6100 Dr / 2150 Cr). Runs only after the gate clears or a human signs off.' },
  { order: 10, key: 'reconcile_learn', name: 'Reconcile & learn', engineSource: 'learn.js', decisionType: 'judgment_based', desc: 'Improve step: forward-replay reconciliation proposes param changes for calibrate/estimate/gate.' },
];

// Reusable tools, mapped to the process. "Automation" tools are the deterministic
// code engines that execute a step's logic (the old engineSource is now a tool of
// type automation). Agents, prompts and integrations round out the registry.
// Agents are NOT seeded here — they live in the real Agent table and are
// auto-provisioned as each process's owner (see processAgentService). The
// registry sources agents live from that table, so there are no placeholders.
const TOOLS = [
  // Automations — deterministic code engines (the "engine source" of each step)
  { type: 'automation', slug: 'shipment-ingest', name: 'Shipment Ingest', desc: 'Parses raw shipment activity, dedupes, infers missing weights from unit medians.', role: 'ingest', engine: 'ingest.js' },
  { type: 'automation', slug: 'carrier-normalizer', name: 'Carrier Normalizer', desc: 'Resolves carrier names, territories and lanes; flags out-of-territory shipments.', role: 'normalize', engine: 'normalize.js' },
  { type: 'automation', slug: 'freight-rate-engine', name: 'Freight Rate Engine', desc: 'Deterministic multi-carrier rate computation (Peak/Heartland/Coastal): base, fuel, accessorials, floors.', role: 'pricing', engine: 'rateEngine.js + rateConfig.js' },
  { type: 'automation', slug: 'calibration-engine', name: 'Calibration Engine', desc: 'Learns realization factors and confidence spread from invoice history.', role: 'calibration', engine: 'calibrate.js' },
  { type: 'automation', slug: 'baseline-engine', name: 'Baseline Calculator', desc: 'Computes the trailing-N-month average (the Denise benchmark) for an honest side-by-side.', role: 'baseline', engine: 'baseline.js' },
  { type: 'automation', slug: 'ensemble-estimator', name: 'Ensemble Estimator', desc: 'Inverse-variance blend of engine vs baseline + mix-shift lift + confidence band.', role: 'estimation', engine: 'estimate.js' },
  { type: 'automation', slug: 'exception-engine', name: 'Exception Engine', desc: 'Raises and ranks exceptions (critical / warning / info) for overseer review.', role: 'controls', engine: 'compute.js' },
  { type: 'automation', slug: 'materiality-gate', name: 'Materiality Gate', desc: 'Materiality x confidence gate routing carriers to auto-post / review / escalate.', role: 'gate', engine: 'accrualService.js' },
  { type: 'automation', slug: 'journal-poster', name: 'Journal Poster', desc: 'Posts the balanced accrual JE (6100 Dr / 2150 Cr) once the gate clears or a human signs off.', role: 'posting', engine: 'accrualService.js' },
  // MCP + prompt
  { type: 'mcp', slug: 'finance-os-mcp', name: 'Finance OS MCP', desc: 'MCP tools exposing run/estimate/reconcile/apply over the process objects.', role: 'integration' },
  { type: 'prompt', slug: 'variance-narrative', name: 'Variance Narrative Prompt', desc: 'Prompt template that turns a run summary into a controller-ready variance narrative.', role: 'reporting' },
];

// Each step draws many tools from the registry. The first entry is the step's
// primary automation (its engine); additional entries are the prompts and MCP
// servers that also run on the step. The owning agent is Process.ownerAgent.
const STEP_TOOLS = {
  ingest: ['shipment-ingest'],
  normalize: ['carrier-normalizer'],
  price: ['freight-rate-engine'],
  calibrate: ['calibration-engine'],
  baseline: ['baseline-engine'],
  estimate: ['ensemble-estimator'],
  exceptions: ['exception-engine'],
  gate: ['materiality-gate'],
  post_je: ['journal-poster', 'finance-os-mcp'],
  reconcile_learn: ['variance-narrative'],
};

// Policies — the tunable knobs (params = Policy, algorithms = code; plan G1).
const POLICIES = [
  { key: 'materiality_gate', stepKey: 'gate', scope: 'process', name: 'Materiality & confidence gate',
    definition: 'A carrier auto-posts only if its half-band is under the materiality threshold AND its CV is under the max. Otherwise it routes to review/escalate.',
    params: { materialityThreshold: 1500, maxCv: 0.15 } },
  { key: 'baseline_window', stepKey: 'baseline', scope: 'process', name: 'Trailing baseline window',
    definition: 'Number of trailing months averaged for the Denise-style baseline.',
    params: { months: 3 } },
  { key: 'estimation_method', stepKey: 'estimate', scope: 'process', name: 'Ensemble & band methodology',
    definition: 'Inverse-variance ensemble of engine vs baseline; mix-shift z-threshold lifts engine weight; band z-score for the confidence interval.',
    params: { ensemble: 'inverse_variance', mixShiftZ: 1.0, bandZ: 1.645, bandConfidence: 0.90 } },
  { key: 'calibration_method', stepKey: 'calibrate', scope: 'process', name: 'Realization factor methodology',
    definition: 'Factor learned at month level, median-central (mean-reverting, no recency weighting).',
    params: { level: 'month', central: 'median', recencyWeighting: false } },
  { key: 'je_accounts', stepKey: 'post_je', scope: 'process', name: 'Journal entry account mapping',
    definition: 'Accrual books freight expense against the accrued freight liability.',
    params: { debitAccount: '6100 · Freight Expense', creditAccount: '2150 · Accrued Freight Liability' } },
  { key: 'improve_trigger', stepKey: 'reconcile_learn', scope: 'process', name: 'Improvement trigger',
    definition: 'How often the improvement loop runs and how many prior runs it ingests.',
    params: { mode: 'auto', lookbackRuns: 6 } },
];

// Canonical finance sub-functions. Every section renders in the command center even
// when it has no processes, so the finance org's shape is always visible.
const SUBFUNCTIONS = [
  { slug: 'gl-close', name: 'General Ledger & Close' },
  { slug: 'accounts-payable', name: 'Accounts Payable' },
  { slug: 'accounts-receivable', name: 'Accounts Receivable' },
  { slug: 'fpa', name: 'FP&A' },
  { slug: 'cost-inventory', name: 'Cost Accounting & Inventory' },
  { slug: 'revenue-trade', name: 'Revenue & Trade Promotion' },
  { slug: 'treasury', name: 'Treasury' },
  { slug: 'tax', name: 'Tax' },
  { slug: 'payroll', name: 'Payroll' },
  { slug: 'internal-audit', name: 'Internal Audit' },
];

async function seedSubfunctions() {
  for (const sf of SUBFUNCTIONS) {
    await prisma.orgFunction.upsert({
      where: { slug: sf.slug }, update: { name: sf.name }, create: { name: sf.name, slug: sf.slug },
    });
  }
  console.log(`  sub-functions: ${SUBFUNCTIONS.length} seeded`);
}

async function seedProcess() {
  const org = await prisma.organization.upsert({
    where: { slug: 'ridgeline-foods' },
    update: {}, create: { name: 'Ridgeline Foods', slug: 'ridgeline-foods' },
  });
  const entity = await prisma.legalEntity.findFirst({ where: { orgId: org.id, name: 'Ridgeline Foods, Inc.' } })
    || await prisma.legalEntity.create({ data: { orgId: org.id, name: 'Ridgeline Foods, Inc.', code: 'RDG', currency: 'USD' } });
  // Freight accrual lives in General Ledger & Close.
  const fn = await prisma.orgFunction.upsert({
    where: { slug: 'gl-close' }, update: {}, create: { name: 'General Ledger & Close', slug: 'gl-close' },
  });
  const bu = await prisma.businessUnit.findFirst({ where: { legalEntityId: entity.id, name: 'Corporate' } })
    || await prisma.businessUnit.create({ data: { legalEntityId: entity.id, name: 'Corporate' } });

  const process = await prisma.process.upsert({
    where: { orgId_slug: { orgId: org.id, slug: 'freight-accrual' } },
    update: { businessUnitId: bu.id, functionId: fn.id, legalEntityId: entity.id },
    create: {
      orgId: org.id, legalEntityId: entity.id, businessUnitId: bu.id, functionId: fn.id,
      name: 'Freight Accrual', slug: 'freight-accrual',
      description: 'Estimate month-end freight expense from shipment activity and rate cards before carrier invoices arrive. Beats the trailing-3-month average.',
      frequency: 'monthly', mode: 'manual',
      improveTrigger: { mode: 'auto', lookbackRuns: 6 },
    },
  });

  // Tools (global registry) + process mapping.
  // Human is not a tool — drop any stale human-type tools (steps SetNull, mappings cascade).
  await prisma.tool.deleteMany({ where: { type: 'human' } });
  const toolBySlug = {};
  for (const t of TOOLS) {
    const tool = await prisma.tool.upsert({
      where: { slug: t.slug }, update: { name: t.name, type: t.type, description: t.desc },
      create: { slug: t.slug, name: t.name, type: t.type, description: t.desc },
    });
    toolBySlug[t.slug] = tool;
    await prisma.processTool.upsert({
      where: { processId_toolId: { processId: process.id, toolId: tool.id } },
      update: { role: t.role }, create: { processId: process.id, toolId: tool.id, role: t.role },
    });
  }

  // Steps — each draws many tools from the registry (StepTool). The primary
  // automation (first in STEP_TOOLS) is also kept on step.toolId for back-compat.
  const stepByKey = {};
  for (const s of STEPS) {
    const toolSlugs = STEP_TOOLS[s.key] || [];
    const primarySlug = toolSlugs[0];
    const step = await prisma.step.upsert({
      where: { processId_key: { processId: process.id, key: s.key } },
      update: { order: s.order, name: s.name, description: s.desc, decisionType: s.decisionType, engineSource: s.engineSource, isGate: !!s.isGate, pauseAfter: !!s.pauseAfter, toolId: primarySlug ? toolBySlug[primarySlug].id : null },
      create: { processId: process.id, order: s.order, key: s.key, name: s.name, description: s.desc, decisionType: s.decisionType, engineSource: s.engineSource, isGate: !!s.isGate, pauseAfter: !!s.pauseAfter, toolId: primarySlug ? toolBySlug[primarySlug].id : null },
    });
    stepByKey[s.key] = step;
    // Attach every mapped tool to the step (idempotent).
    for (const slug of toolSlugs) {
      const tool = toolBySlug[slug];
      if (!tool) continue;
      await prisma.stepTool.upsert({
        where: { stepId_toolId: { stepId: step.id, toolId: tool.id } },
        update: { role: tool === toolBySlug[primarySlug] ? 'engine' : null },
        create: { stepId: step.id, toolId: tool.id, role: slug === primarySlug ? 'engine' : null },
      });
    }
  }

  // Policies (params), pinned to steps
  for (const p of POLICIES) {
    await prisma.policy.upsert({
      where: { processId_key: { processId: process.id, key: p.key } },
      update: { name: p.name, definition: p.definition, params: p.params, scope: p.scope, stepId: stepByKey[p.stepKey] ? stepByKey[p.stepKey].id : null },
      create: { processId: process.id, key: p.key, name: p.name, definition: p.definition, params: p.params, scope: p.scope, stepId: stepByKey[p.stepKey] ? stepByKey[p.stepKey].id : null },
    });
  }

  console.log(`  process: ${process.name} (${STEPS.length} steps, ${TOOLS.length} tools, ${POLICIES.length} policies)`);
  return process;
}

async function main() {
  console.log('Seeding Ridgeline Finance OS...');
  await loadData();
  await seedSubfunctions();
  await seedProcess();
  console.log('Seed complete.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
