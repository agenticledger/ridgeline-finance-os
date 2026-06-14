// LEARN plane — recursive improvement: propose, approve (apply), version.
//
// Grounds the self-review (`forwardLearn`) into concrete, APPLYABLE proposals that
// each target one versioned Policy param (plan G1/G6: Improve tunes params, not
// algorithms). Applying a proposal bumps the policy version and writes an immutable
// ObjectVersion (before → after diff). Changes affect FUTURE runs only — runs pin
// the versions they used, so frozen history reproduces exactly.

const prisma = require('../db');
const { forwardLearn } = require('./learn');

const PROCESS_SLUG = 'freight-accrual';
const round3 = (n) => Math.round(n * 1000) / 1000;
const money = (n) => (n == null ? '--' : '$' + Math.round(n).toLocaleString('en-US'));

async function processBySlug(slug = PROCESS_SLUG) {
  const p = await prisma.process.findFirst({ where: { slug }, include: { policies: true } });
  if (!p) throw new Error(`Process ${slug} not found.`);
  return p;
}
function policyParam(process, key, param, fallback) {
  const p = process.policies.find((x) => x.key === key);
  return p && p.params && p.params[param] != null ? p.params[param] : fallback;
}

// Build concrete, param-targeted proposals from the backtest diagnostics.
function buildProposals(process, learn, period) {
  const out = [];
  const cov = learn.coverage || { pct: 0, hits: 0, total: 0 };

  // Worst-error carrier from the forward backtest.
  let worst = null;
  for (const c of ['peak', 'heartland', 'coastal']) {
    const m = learn.maeByCarrier[c];
    if (m && (!worst || m.engine > worst.mae)) worst = { carrier: c, mae: m.engine, denise: m.denise };
  }

  // 1. Band coverage → widen the confidence interval (estimation_method.bandZ).
  const bandZ = policyParam(process, 'estimation_method', 'bandZ', 1.645);
  if (cov.pct < 92 && bandZ < 1.96) {
    out.push({
      period, lever: 'policy', component: 'estimation_method', riskLevel: 'low',
      diagnosis: `Band coverage ${cov.pct}% (${cov.hits}/${cov.total}) is under the 95% target; promo-cycle months are landing outside the interval.`,
      proposal: `Widen the confidence band: raise the z-score ${bandZ} → 1.96 (90% → 95%) so volatile months are captured.`,
      target: { policyKey: 'estimation_method', param: 'bandZ', from: bandZ, to: 1.96, kind: 'number' },
    });
  }

  // 2. Mix-shift sensitivity → trust the rate engine sooner (estimation_method.mixShiftZ).
  const mixZ = policyParam(process, 'estimation_method', 'mixShiftZ', 1.0);
  if (mixZ > 0.8) {
    out.push({
      period, lever: 'policy', component: 'estimation_method', riskLevel: 'medium',
      diagnosis: `Mix-shift detection fires at z ≥ ${mixZ}. The Heartland Q-reset and Peak long-haul months Denise misses sit just under that threshold, so the ensemble damps the engine on real volume changes.`,
      proposal: `Lower the mix-shift z-threshold ${mixZ} → 0.8 so the engine is trusted earlier when volume/mix genuinely shifts.`,
      target: { policyKey: 'estimation_method', param: 'mixShiftZ', from: mixZ, to: 0.8, kind: 'number' },
    });
  }

  // 3. Baseline window → dampen single-month invoice-timing noise (baseline_window.months).
  const months = policyParam(process, 'baseline_window', 'months', 3);
  if (months < 4) {
    out.push({
      period, lever: 'policy', component: 'baseline_window', riskLevel: 'low',
      diagnosis: `The trailing baseline uses ${months} months. Single-month invoice-timing swings (e.g. December promo) pull the ${months}-month average around.`,
      proposal: `Extend the trailing baseline ${months} → 4 months to smooth timing noise in the Denise benchmark blend.`,
      target: { policyKey: 'baseline_window', param: 'months', from: months, to: 4, kind: 'number' },
    });
  }

  // Advisory (not directly applyable): the widest-error carrier needs a methodology change.
  if (worst && worst.mae > worst.denise) {
    out.push({
      period, lever: 'methodology', component: `${worst.carrier}_calibration`, riskLevel: 'medium',
      diagnosis: `${worst.carrier} forward MAE ${money(worst.mae)} exceeds Denise ${money(worst.denise)} — driven by unflagged carrier promo months.`,
      proposal: `Add a promo-month flag to the realization factor for ${worst.carrier}. (Methodology change — requires an engine update, not a single param.)`,
      target: {},
    });
  }
  return out;
}

// Generate + persist proposals for a process (optionally tied to a run).
async function generateProposals(slug = PROCESS_SLUG, { runId = null, actor = 'Improvement Agent' } = {}) {
  const process = await processBySlug(slug);
  const learn = forwardLearn();
  const period = runId ? (await runFor(runId)) : 'continuous';
  const proposals = buildProposals(process, learn, period);

  // Idempotent: clear prior PENDING proposals for this run scope, keep applied history.
  await prisma.improvementProposal.deleteMany({ where: { runId: runId || undefined, status: 'pending' } });

  const created = [];
  for (const p of proposals) {
    const row = await prisma.improvementProposal.create({
      data: {
        runId: runId || undefined, period: p.period, lever: p.lever, component: p.component,
        diagnosis: p.diagnosis, proposal: p.proposal, riskLevel: p.riskLevel, status: 'pending',
        target: p.target || {},
      },
    });
    created.push(row);
  }
  if (runId) {
    await prisma.ledgerEvent.create({
      data: { runId, actor, action: 'PROPOSE', detail: { message: `Improve loop raised ${created.length} proposals from ${learn.monthsReplayed} replayed cycles (${learn.coverage.pct}% band coverage).` } },
    });
  }
  return { count: created.length, proposals: created, coverage: learn.coverage, monthsReplayed: learn.monthsReplayed };
}

async function runFor(runId) {
  const r = await prisma.accrualRun.findUnique({ where: { id: runId }, select: { period: true } });
  return r ? r.period : 'continuous';
}

// Apply a proposal: tune one policy param, bump the version, write an ObjectVersion.
async function applyProposal(proposalId, { approvedBy = 'Controller' } = {}) {
  const proposal = await prisma.improvementProposal.findUnique({ where: { id: proposalId } });
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status === 'applied') return { proposalId, status: 'applied', alreadyApplied: true };
  const t = proposal.target || {};
  if (!t.policyKey || !t.param) {
    await prisma.improvementProposal.update({ where: { id: proposalId }, data: { status: 'dismissed' } });
    throw new Error('Proposal is advisory (methodology change) and cannot be auto-applied to a policy param.');
  }

  const policy = await prisma.policy.findFirst({ where: { key: t.policyKey, process: { slug: PROCESS_SLUG } } });
  if (!policy) throw new Error(`Policy ${t.policyKey} not found.`);

  const before = { ...(policy.params || {}) };
  let value = t.to;
  if (t.kind === 'number') value = Number(t.to);
  const after = { ...before, [t.param]: value };
  const newVersion = policy.version + 1;

  await prisma.policy.update({ where: { id: policy.id }, data: { params: after, version: newVersion } });

  const version = await prisma.objectVersion.create({
    data: {
      objectType: 'policy', objectId: policy.id, version: newVersion,
      diff: { param: t.param, before: before[t.param], after: value, beforeParams: before, afterParams: after },
      source: 'improve', approvedBy, approvedAt: new Date(),
    },
  });

  await prisma.improvementProposal.update({
    where: { id: proposalId }, data: { status: 'applied', appliedVersionId: version.id },
  });

  if (proposal.runId) {
    await prisma.ledgerEvent.create({
      data: {
        runId: proposal.runId, actor: approvedBy, action: 'APPLY_PROPOSAL',
        detail: { message: `Applied: ${t.policyKey}.${t.param} ${before[t.param]} → ${value} (policy v${policy.version} → v${newVersion}). Affects future runs only.` },
      },
    });
  }

  return { proposalId, status: 'applied', policyKey: t.policyKey, param: t.param, before: before[t.param], after: value, newVersion, objectVersionId: version.id };
}

async function listProposals(slug = PROCESS_SLUG, { runId = null } = {}) {
  const where = runId ? { runId } : {};
  return prisma.improvementProposal.findMany({ where, orderBy: { createdAt: 'desc' } });
}

// Version history for the process's policies (the audit trail of Improve actions).
async function listVersions(slug = PROCESS_SLUG) {
  const process = await prisma.process.findFirst({ where: { slug }, include: { policies: true } });
  if (!process) return [];
  const byId = {}; process.policies.forEach((p) => { byId[p.id] = p; });
  const ids = process.policies.map((p) => p.id);
  if (!ids.length) return [];
  const versions = await prisma.objectVersion.findMany({
    where: { objectType: 'policy', objectId: { in: ids } }, orderBy: { createdAt: 'desc' },
  });
  return versions.map((v) => ({ ...v, policyName: byId[v.objectId] ? byId[v.objectId].name : v.objectId, policyKey: byId[v.objectId] ? byId[v.objectId].key : null }));
}

// Package history — every process_package snapshot (the audit trail of edits).
// Each row is one versioned Package: a whole-process snapshot of steps, policies
// and tools, cut by the owner agent on create (v1) and on every applied edit.
async function listPackageVersions(slug = PROCESS_SLUG) {
  const process = await prisma.process.findFirst({ where: { slug }, select: { id: true } });
  if (!process) return [];
  const versions = await prisma.objectVersion.findMany({
    where: { objectType: 'process_package', objectId: process.id }, orderBy: { version: 'desc' },
  });
  return versions.map((v) => {
    const d = v.diff || {};
    const snap = d.snapshot || {};
    return {
      version: v.version,
      note: d.note || '',
      initial: !!d.initial,
      steps: Array.isArray(snap.steps) ? snap.steps.length : null,
      policies: Array.isArray(snap.policies) ? snap.policies.length : null,
      tools: Array.isArray(snap.tools) ? snap.tools.length : null,
      source: v.source,
      approvedBy: v.approvedBy,
      approvedAt: v.approvedAt,
    };
  });
}

module.exports = { generateProposals, applyProposal, listProposals, listVersions, listPackageVersions, PROCESS_SLUG };
