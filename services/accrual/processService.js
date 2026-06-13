// Process registry — list and create processes on the generalized model.
//
// The freight accrual is the first process loaded onto a generic
// Process -> Step / Policy / Tool model. This service proves the model is general:
// new processes can be defined (org hierarchy, steps, versioned policies) and
// persisted. Only processes whose slug maps to a bound engine actually execute a
// run today (freight-accrual); the rest are defined and "awaiting engine binding".

const prisma = require('../db');
const { PROCESS_SLUG } = require('./runService');

const FREIGHT_SLUG = PROCESS_SLUG;

function slugify(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'process';
}

// Canonical finance sub-functions (OrgFunction records). These section the command
// center: every section renders even when it has no processes yet, so the finance
// org's shape is always visible. icon = a lucide-style glyph key resolved in the view.
const SUBFUNCTIONS = [
  { slug: 'gl-close', name: 'General Ledger & Close', icon: 'book', blurb: 'Journal entries, accruals, the period-end close.' },
  { slug: 'accounts-payable', name: 'Accounts Payable', icon: 'arrow-down', blurb: 'Vendor invoices, approvals, disbursement.' },
  { slug: 'accounts-receivable', name: 'Accounts Receivable', icon: 'arrow-up', blurb: 'Customer billing, collections, cash application.' },
  { slug: 'fpa', name: 'FP&A', icon: 'trend', blurb: 'Budgeting, forecasting, variance analysis.' },
  { slug: 'cost-inventory', name: 'Cost Accounting & Inventory', icon: 'box', blurb: 'Standard costs, inventory valuation, COGS.' },
  { slug: 'revenue-trade', name: 'Revenue & Trade Promotion', icon: 'tag', blurb: 'Revenue recognition, rebates, trade spend.' },
  { slug: 'treasury', name: 'Treasury', icon: 'wallet', blurb: 'Cash, liquidity, banking, FX.' },
  { slug: 'tax', name: 'Tax', icon: 'percent', blurb: 'Provision, compliance, indirect tax.' },
  { slug: 'payroll', name: 'Payroll', icon: 'users', blurb: 'Compensation, benefits accruals, payroll JE.' },
  { slug: 'internal-audit', name: 'Internal Audit', icon: 'shield', blurb: 'Controls testing, SOX, risk assurance.' },
];

const SUBFUNCTION_SLUGS = new Set(SUBFUNCTIONS.map((s) => s.slug));

// A neutral starter checklist for a brand-new process (no engine bound yet).
const BLANK_STEPS = [
  { key: 'ingest', name: 'Ingest source data', decisionType: 'policy_based', engineSource: null, description: 'Load and dedupe the source records for the period.' },
  { key: 'normalize', name: 'Normalize & validate', decisionType: 'policy_based', engineSource: null, description: 'Canonicalize fields, resolve references, flag data-quality issues.' },
  { key: 'compute', name: 'Compute estimate', decisionType: 'judgment_based', engineSource: null, description: 'Produce the point estimate and a confidence band.' },
  { key: 'gate', name: 'Materiality gate', decisionType: 'policy_based', engineSource: null, isGate: true, pauseAfter: true, description: 'Auto-post within tolerance; otherwise route to a human.' },
  { key: 'post', name: 'Post journal entry', decisionType: 'policy_based', engineSource: null, description: 'Post the balanced JE once the gate clears or a human signs off.' },
  { key: 'reconcile', name: 'Reconcile & learn', decisionType: 'judgment_based', engineSource: null, description: 'Forward-replay reconciliation; propose policy changes.' },
];

const BLANK_POLICIES = [
  { key: 'materiality_gate', name: 'Materiality & confidence gate', definition: 'Auto-post only if the estimate is within the materiality threshold and confidence bound; otherwise escalate.', params: { materialityThreshold: 1500, maxCv: 0.15 } },
  { key: 'je_accounts', name: 'Journal entry account mapping', definition: 'The debit/credit accounts this process books to.', params: { debitAccount: '', creditAccount: '' } },
  { key: 'improve_trigger', name: 'Improvement trigger', definition: 'How often the improvement loop runs and how many prior runs it ingests.', params: { mode: 'auto', lookbackRuns: 6 } },
];

async function listProcesses() {
  const rows = await prisma.process.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    include: {
      org: true,
      function: true,
      runs: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, period: true } },
      _count: { select: { runs: true, steps: true } },
    },
  });
  // Tile signal: what the operator should feel at a glance.
  //   attention -> a run is waiting on a human / blocked
  //   live      -> a run is processing right now
  //   posted    -> latest run is booked / reconciled
  //   idle      -> engine bound but no run yet (or defined-only)
  const ATTENTION = new Set(['awaiting_human', 'needs_review', 'blocked']);
  const POSTED = new Set(['approved', 'posted', 'reconciled']);
  return rows.map((p) => {
    const latest = p.runs[0] || null;
    const status = latest ? latest.status : null;
    let signal = 'idle';
    if (status && ATTENTION.has(status)) signal = 'attention';
    else if (status === 'processing') signal = 'live';
    else if (status && POSTED.has(status)) signal = 'posted';
    return {
      id: p.id, slug: p.slug, name: p.name,
      org: p.org ? p.org.name : null,
      function: p.function ? p.function.name : null,
      functionSlug: p.function ? p.function.slug : null,
      frequency: p.frequency, mode: p.mode,
      runCount: p._count.runs, stepCount: p._count.steps,
      runnable: p.slug === FREIGHT_SLUG,
      latestStatus: status, latestPeriod: latest ? latest.period : null,
      signal,
    };
  });
}

async function ensureUniqueSlug(orgId, base) {
  let slug = base;
  let n = 2;
  // @@unique([orgId, slug])
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.process.findFirst({ where: { orgId, slug } })) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

async function upsertFunction(name) {
  if (!name || !name.trim()) return null;
  const slug = slugify(name);
  const existing = await prisma.orgFunction.findUnique({ where: { slug } });
  if (existing) return existing;
  return prisma.orgFunction.create({ data: { name: name.trim(), slug } });
}

// Create a new process. template: 'blank' (neutral starter) or 'clone' (copy freight's
// step/policy/tool shape). Reuses the existing org hierarchy of the freight process so
// the new process sits in the same legal entity.
async function createProcess({ name, functionName, functionSlug, frequency = 'monthly', mode = 'manual', description = '', template = 'blank' }) {
  if (!name || !name.trim()) throw new Error('Process name is required.');

  const base = await prisma.process.findFirst({
    where: { slug: FREIGHT_SLUG },
    include: { steps: { orderBy: { order: 'asc' } }, policies: true, tools: true },
  });
  if (!base) throw new Error('No base hierarchy found. Seed the freight process first.');

  // Prefer an existing sub-function by slug (so the new process homes to its section);
  // otherwise upsert one from the typed name.
  let fn = null;
  if (functionSlug && SUBFUNCTION_SLUGS.has(functionSlug)) {
    fn = await prisma.orgFunction.findUnique({ where: { slug: functionSlug } });
  }
  if (!fn) fn = await upsertFunction(functionName);
  const slug = await ensureUniqueSlug(base.orgId, slugify(name));

  const proc = await prisma.process.create({
    data: {
      orgId: base.orgId,
      legalEntityId: base.legalEntityId,
      businessUnitId: base.businessUnitId,
      functionId: fn ? fn.id : base.functionId,
      name: name.trim(),
      slug,
      description: description.trim() || (template === 'clone'
        ? 'Cloned from the freight accrual blueprint. Re-home and re-bind the engine to make it run.'
        : 'New process defined on the Ridgeline Finance OS model. Awaiting engine binding before it can execute a run.'),
      frequency,
      mode,
      improveTrigger: { mode: 'auto', lookbackRuns: 6 },
    },
  });

  // Steps
  const stepDefs = template === 'clone'
    ? base.steps.map((s) => ({ key: s.key, name: s.name, description: s.description, decisionType: s.decisionType, engineSource: s.engineSource, toolId: s.toolId, isGate: s.isGate, pauseAfter: s.pauseAfter }))
    : BLANK_STEPS.map((s) => ({ key: s.key, name: s.name, description: s.description, decisionType: s.decisionType, engineSource: s.engineSource, toolId: null, isGate: !!s.isGate, pauseAfter: !!s.pauseAfter }));

  await prisma.step.createMany({
    data: stepDefs.map((s, i) => ({
      processId: proc.id, order: i + 1, key: s.key, name: s.name, description: s.description,
      decisionType: s.decisionType, engineSource: s.engineSource, toolId: s.toolId || null,
      isGate: !!s.isGate, pauseAfter: !!s.pauseAfter, version: 1,
    })),
  });

  // Policies
  const policyDefs = template === 'clone'
    ? base.policies.map((p) => ({ key: p.key, name: p.name, definition: p.definition, params: p.params, scope: p.scope }))
    : BLANK_POLICIES.map((p) => ({ key: p.key, name: p.name, definition: p.definition, params: p.params, scope: 'process' }));

  await prisma.policy.createMany({
    data: policyDefs.map((p) => ({
      processId: proc.id, key: p.key, name: p.name, definition: p.definition,
      params: p.params, scope: p.scope || 'process', version: 1,
    })),
  });

  // Tool mappings (reuse the global tool registry) when cloning.
  if (template === 'clone' && base.tools.length) {
    await prisma.processTool.createMany({
      data: base.tools.map((pt) => ({ processId: proc.id, toolId: pt.toolId })),
      skipDuplicates: true,
    });
  }

  // Auto-provision the Process Owner Agent — every process is owned by exactly one
  // supervisor agent. Non-fatal if it fails; the process still exists.
  let ownerAgent = null;
  try {
    const { provisionOwnerAgent } = require('./processAgentService');
    ownerAgent = await provisionOwnerAgent(proc.id, { regeneratePrompt: true });
  } catch (e) {
    console.error('Owner-agent provisioning failed (non-fatal):', e.message);
  }

  return { id: proc.id, slug: proc.slug, name: proc.name, ownerAgent: ownerAgent ? { id: ownerAgent.id, slug: ownerAgent.slug, name: ownerAgent.name } : null };
}

module.exports = { listProcesses, createProcess, FREIGHT_SLUG, SUBFUNCTIONS, SUBFUNCTION_SLUGS };
