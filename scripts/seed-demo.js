// Canonical demo state for the Ridgeline freight accrual.
//
// Produces a deterministic, video-ready state that exercises EVERY plane of the
// loop end to end, using only the provided data files:
//
//   • April 2026 run  — LIVE, awaiting_human. Three carriers escalated; the JE is
//                        staged and waiting on a human sign-off. This is the hero.
//   • March 2026 run  — the CLOSED loop, fully replayed: posted → frozen →
//                        reconciled against the real March invoices (denise
//                        baseline) → improvement proposals raised → one applied,
//                        which bumps a versioned policy param and writes an
//                        immutable ObjectVersion audit row.
//
// Idempotent: wipes all run/loop artifacts and resets the two policy params the
// demo mutates back to their defaults, so it can be re-run to the same state.
//
// Run:  node scripts/seed-demo.js

const prisma = require('../services/db');
const { executeRun, signOff, freezeRun, clearActionItem, getRun, PROCESS_SLUG } = require('../services/accrual/runService');
const { reconcileRun } = require('../services/accrual/reconcileService');
const improve = require('../services/accrual/improveService');

const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function resetState() {
  // Loop artifacts first (Reconciliation is SetNull, ImprovementProposal has no FK,
  // ObjectVersion is keyed to the policy — none of these cascade from a run delete).
  await prisma.reconciliation.deleteMany({});
  await prisma.improvementProposal.deleteMany({});
  await prisma.objectVersion.deleteMany({});
  // Runs cascade to lines, exceptions, ledger events, and step executions.
  await prisma.accrualRun.deleteMany({});

  // Reset the two policy params the demo's "apply" mutates, back to defaults + v1,
  // so the apply always produces a clean v1 -> v2 transition.
  const process = await prisma.process.findFirst({ where: { slug: PROCESS_SLUG }, include: { policies: true } });
  if (!process) throw new Error(`Process ${PROCESS_SLUG} not found. Run \`npm run seed\` first.`);
  const resets = {
    estimation_method: { bandZ: 1.645, ensemble: 'inverse_variance', mixShiftZ: 1, bandConfidence: 0.9 },
    baseline_window: { months: 3 },
  };
  for (const [key, params] of Object.entries(resets)) {
    const p = process.policies.find((x) => x.key === key);
    if (p) await prisma.policy.update({ where: { id: p.id }, data: { params, version: 1 } });
  }
  return process;
}

async function liveAprilRun() {
  // April is the period under estimate — its invoices have NOT arrived. This run
  // stays at awaiting_human as the "needs you" hero.
  const r = await executeRun({ period: 'April 2026', mode: 'manual', actor: 'Accrual Agent' });
  const full = await getRun(r.runId);
  console.log(`  April 2026  -> ${full.status}  ${money(full.totalAccrual)}  (${full.steps.length} steps, ${full.exceptions.length} exceptions)`);
  return r.runId;
}

async function closedMarchLoop() {
  // March 2026 has real actuals in the denise baseline, so we can replay the full
  // post-close loop against true invoiced numbers.
  const r = await executeRun({ period: 'March 2026', mode: 'manual', actor: 'Accrual Agent' });
  let full = await getRun(r.runId);
  console.log(`  March 2026  -> ${full.status}  ${money(full.totalAccrual)} (booked estimate)`);

  // Clear every action item first (the sign-off gate): approve them all.
  for (const item of (full.actionItems || [])) {
    await clearActionItem(item.id, { status: 'approved', note: 'Reviewed — within tolerance for March.', actor: 'M. Chen (Controller)' });
  }
  if ((full.actionItems || []).length) console.log(`              -> cleared ${full.actionItems.length} action items (approved)`);

  // Sign off (posts the staged JE) unless it auto-posted.
  if (full.status === 'awaiting_human' || full.status === 'needs_review') {
    await signOff(r.runId, { actor: 'M. Chen (Controller)', note: 'Reviewed bands; comfortable booking March.' });
    full = await getRun(r.runId);
    console.log(`              -> signed off, status ${full.status}`);
  }

  // Freeze for period close.
  await freezeRun(r.runId, { actor: 'M. Chen (Controller)' });
  console.log('              -> frozen for close');

  // Reconcile against the real March invoices (resolved from the denise baseline).
  const recon = await reconcileRun(r.runId, { actor: 'Reconciliation Agent' });
  console.log(`              -> reconciled: booked ${money(recon.estTotal)} vs actual ${money(recon.actTotal)} = variance ${recon.totalVariance >= 0 ? '+' : ''}${money(recon.totalVariance)} (${recon.withinMateriality ? 'within materiality' : 'true-up staged'})`);

  // Raise improvement proposals from the forward-replay diagnostics, tied to the run.
  const gen = await improve.generateProposals(PROCESS_SLUG, { runId: r.runId });
  console.log(`              -> ${gen.count} proposals raised (${gen.coverage.pct}% band coverage over ${gen.monthsReplayed} replayed cycles)`);

  // Approve + apply the first applyable proposal (param-targeted, not advisory).
  const applyable = gen.proposals.find((p) => p.target && p.target.policyKey && p.target.param);
  if (applyable) {
    const res = await improve.applyProposal(applyable.id, { approvedBy: 'M. Chen (Controller)' });
    console.log(`              -> applied ${res.policyKey}.${res.param}: ${res.before} -> ${res.after} (policy v${res.newVersion}, ObjectVersion written)`);
  }
  return r.runId;
}

(async () => {
  console.log('Seeding canonical demo state...\n');
  await resetState();
  console.log('Reset: runs, reconciliations, proposals, versions cleared; policies reset to v1.\n');

  // Order matters now that estimation params flow from policy into the engine.
  // April is booked FIRST, while every policy is still at v1 (default params), so it
  // reproduces the canonical $103,402.27. The March loop then APPLIES a proposal that
  // tunes a policy param — affecting future runs only, never the already-pinned April
  // run. Finally we touch April's createdAt so it still sorts newest (the "needs you"
  // hero the command center and supervisor key off).
  console.log('Live period:');
  const aprilId = await liveAprilRun();

  console.log('\nClosed loop (replayed prior period):');
  const marchId = await closedMarchLoop();

  await prisma.accrualRun.update({ where: { id: aprilId }, data: { createdAt: new Date() } });
  console.log('\nApril run re-stamped as newest (live period on top).');

  const counts = {
    runs: await prisma.accrualRun.count(),
    reconciliations: await prisma.reconciliation.count(),
    proposals: await prisma.improvementProposal.count(),
    objectVersions: await prisma.objectVersion.count(),
  };
  console.log('\nFinal state:', JSON.stringify(counts));
  console.log(`Live April run:   ${aprilId}`);
  console.log(`Closed March run: ${marchId}`);
  console.log('\nDemo state ready.');
  process.exit(0);
})().catch((e) => { console.error('SEED FAILED:', e); process.exit(1); });
