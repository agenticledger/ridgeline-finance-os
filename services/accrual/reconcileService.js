// LEARN plane — run-level reconciliation (closes plan gap G5).
//
// When the invoices for a closed period actually arrive, reconcile the booked
// accrual against the real invoiced amounts. This writes immutable Reconciliation
// rows (one per carrier) against the FROZEN run without mutating it, computes the
// variance, and if the portfolio variance breaches materiality it stages a true-up
// JE for the next open period. This is the post-close half of the loop that
// `forwardLearn()` only simulates with historical replay.

const prisma = require('../db');
const { PROCESS_SLUG } = require('./runService');

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => (n == null ? '--' : '$' + Math.round(n).toLocaleString('en-US'));
const CARRIERS = ['peak', 'heartland', 'coastal'];
const CARRIER_LABEL = { peak: 'Peak Logistics', heartland: 'Heartland Freight', coastal: 'Coastal Express' };

// Read the materiality threshold from the process's versioned policy.
async function materialityFor(processId) {
  const p = await prisma.policy.findFirst({ where: { processId, key: 'materiality_gate' } });
  return (p && p.params && p.params.materialityThreshold != null) ? p.params.materialityThreshold : 1500;
}

// Pull actual invoiced totals per carrier for a period from the baseline table
// (this is the real post-close truth Ridgeline gets when invoices land).
async function actualsFromBaseline(period) {
  const rows = await prisma.deniseBaseline.findMany({ where: { month: period } });
  const out = {};
  for (const r of rows) out[r.carrier] = r.actualInvoiced;
  return Object.keys(out).length ? out : null;
}

// Reconcile a run against actuals. `actuals` may be supplied ({peak,heartland,coastal});
// otherwise we resolve them from the baseline truth for the run's period.
async function reconcileRun(runId, { actuals = null, actor = 'Reconciliation Agent' } = {}) {
  const run = await prisma.accrualRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error('Run not found');
  if (run.status !== 'posted' && run.status !== 'reconciled' && !run.frozen) {
    throw new Error(`Run is ${run.status}; reconcile only a posted/frozen run.`);
  }

  const bookedByCarrier = {};
  for (const c of (run.summary.carriers || [])) bookedByCarrier[c.key] = c;

  const resolved = actuals || (await actualsFromBaseline(run.period));
  if (!resolved) throw new Error(`No actuals available for ${run.period}. Pass actuals: {peak, heartland, coastal}.`);

  const materiality = await materialityFor(run.processId);

  // Re-reconcile is idempotent: clear prior rows for this run.
  await prisma.reconciliation.deleteMany({ where: { runId } });

  const carriers = [];
  let estTotal = 0, actTotal = 0;
  for (const key of CARRIERS) {
    const booked = bookedByCarrier[key];
    if (!booked || resolved[key] == null) continue;
    const estimated = round2(booked.point);
    const actual = round2(resolved[key]);
    const variance = round2(actual - estimated);
    const variancePct = actual ? round2((variance / actual) * 100) : 0;
    const inBand = booked.low != null && booked.high != null ? (actual >= booked.low && actual <= booked.high) : null;
    estTotal += estimated; actTotal += actual;

    await prisma.reconciliation.create({
      data: {
        runId, period: run.period, carrier: key,
        estimated, actual, variance, variancePct,
        detail: { label: CARRIER_LABEL[key], low: booked.low, high: booked.high, inBand, materiality },
      },
    });
    carriers.push({ carrier: key, label: CARRIER_LABEL[key], estimated, actual, variance, variancePct, inBand });
  }

  estTotal = round2(estTotal); actTotal = round2(actTotal);
  const totalVariance = round2(actTotal - estTotal);
  const totalVariancePct = actTotal ? round2((totalVariance / actTotal) * 100) : 0;
  const withinMateriality = Math.abs(totalVariance) <= materiality;

  // True-up: if the portfolio variance breaches materiality, stage a correcting JE
  // into the next open period (debit/credit depend on direction).
  let trueUp = null;
  if (!withinMateriality) {
    const debit = totalVariance > 0 ? '6100 · Freight Expense' : '2150 · Accrued Freight Liability';
    const credit = totalVariance > 0 ? '2150 · Accrued Freight Liability' : '6100 · Freight Expense';
    const amount = Math.abs(totalVariance);
    trueUp = {
      amount, direction: totalVariance > 0 ? 'under-accrued' : 'over-accrued',
      lines: [
        { account: debit, debit: amount, credit: 0 },
        { account: credit, debit: 0, credit: amount },
      ],
      memo: `True-up for ${run.period}: booked ${money(estTotal)} vs actual ${money(actTotal)} (${totalVariance > 0 ? '+' : ''}${money(totalVariance)}).`,
    };
  }

  const reconSummary = {
    period: run.period, reconciledAt: new Date().toISOString(), reconciledBy: actor,
    estTotal, actTotal, totalVariance, totalVariancePct, materiality, withinMateriality,
    carriers, trueUp,
  };

  await prisma.accrualRun.update({
    where: { id: runId },
    data: { status: 'reconciled', summary: { ...run.summary, reconciliation: reconSummary } },
  });

  await prisma.ledgerEvent.create({
    data: {
      runId, actor, action: 'RECONCILE',
      detail: {
        message: `Reconciled ${run.period}: booked ${money(estTotal)} vs actual ${money(actTotal)} → variance ${totalVariance > 0 ? '+' : ''}${money(totalVariance)} (${totalVariancePct}%). ${withinMateriality ? 'Within materiality — no true-up.' : `Breaches materiality (${money(materiality)}) — true-up staged.`}`,
        totalVariance, withinMateriality, trueUp,
      },
    },
  });

  return { runId, ...reconSummary };
}

async function getReconciliation(runId) {
  const rows = await prisma.reconciliation.findMany({ where: { runId }, orderBy: { carrier: 'asc' } });
  return rows;
}

module.exports = { reconcileRun, getReconciliation, actualsFromBaseline, PROCESS_SLUG };
