// End-to-end validation harness for the Ridgeline freight accrual loop.
//
// Asserts the invariants that make the build defensible to a CFO/auditor:
//   1. The deterministic engine reproduces the canonical April number exactly.
//   2. The staged journal entry balances (debits == credits).
//   3. The live April run is correctly gated at awaiting_human (human-in-the-loop).
//   4. The closed March run walked posted -> frozen -> reconciled.
//   5. Reconciliation math ties (variance == actual - estimated, per carrier + total).
//   6. A material variance stages a balanced true-up JE.
//   7. Applying a proposal bumps the policy version and writes one immutable
//      ObjectVersion with a correct before -> after diff (audit trail).
//   8. The REST + MCP doc catalogs are internally consistent (no duplicate ops).
//
// It first rebuilds the canonical state (so it is self-contained), then asserts.
// Exits non-zero on the first failed invariant.
//
// Run:  node scripts/validate.js

const { execSync } = require('child_process');
const path = require('path');
const prisma = require('../services/db');
const { runAccrual } = require('../services/accrual/accrualService');
const { API_GROUPS, endpointCount } = require('../docs/catalog');
const { TOOL_GROUPS, toolCount } = require('../mcp/toolCatalog');

let passed = 0, failed = 0;
const round2 = (n) => Math.round(n * 100) / 100;

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
function approx(a, b, eps = 0.01) { return Math.abs(a - b) <= eps; }

(async () => {
  console.log('Rebuilding canonical state for validation...');
  execSync('node ' + path.join(__dirname, 'seed-demo.js'), { stdio: 'ignore' });
  console.log('Asserting invariants:\n');

  // ── 1. Deterministic engine reproduces the canonical April number ──────────
  const a1 = runAccrual({ period: 'April 2026' });
  const a2 = runAccrual({ period: 'April 2026' });
  check('engine is deterministic', approx(a1.portfolio.point, a2.portfolio.point), `${a1.portfolio.point} == ${a2.portfolio.point}`);
  check('engine reproduces canonical April total', approx(a1.portfolio.point, 103402.27, 0.5), `$${a1.portfolio.point}`);
  check('90% band brackets the point estimate', a1.portfolio.low <= a1.portfolio.point && a1.portfolio.point <= a1.portfolio.high,
    `${a1.portfolio.low} <= ${a1.portfolio.point} <= ${a1.portfolio.high}`);

  // ── 2. Staged JE balances ──────────────────────────────────────────────────
  const je = a1.je;
  const debits = je.lines.reduce((s, l) => s + (l.debit || 0), 0);
  const credits = je.lines.reduce((s, l) => s + (l.credit || 0), 0);
  check('staged JE balances (debits == credits)', approx(debits, credits), `Dr ${round2(debits)} / Cr ${round2(credits)}`);

  // ── 3. Live April run gated at awaiting_human ──────────────────────────────
  const april = await prisma.accrualRun.findFirst({ where: { period: 'April 2026' }, orderBy: { createdAt: 'desc' } });
  check('live April run exists', !!april);
  check('April run gated for human sign-off', april && april.status === 'awaiting_human', april && april.status);
  check('April run not frozen (still open)', april && april.frozen === false);

  // ── 4. Closed March run walked the full lifecycle ──────────────────────────
  const march = await prisma.accrualRun.findFirst({ where: { period: 'March 2026' }, orderBy: { createdAt: 'desc' } });
  check('closed March run exists', !!march);
  check('March run reconciled', march && march.status === 'reconciled', march && march.status);
  check('March run frozen for close', march && march.frozen === true);

  // ── 5. Reconciliation math ties ────────────────────────────────────────────
  const recons = march ? await prisma.reconciliation.findMany({ where: { runId: march.id } }) : [];
  check('three per-carrier reconciliation rows', recons.length === 3, `${recons.length} rows`);
  let allTie = recons.length > 0;
  for (const r of recons) if (!approx(r.variance, round2(r.actual - r.estimated))) allTie = false;
  check('per-carrier variance == actual - estimated', allTie);
  const reconSummary = march && march.summary ? march.summary.reconciliation : null;
  if (reconSummary) {
    const sumVar = round2(recons.reduce((s, r) => s + r.variance, 0));
    check('portfolio variance == sum of carrier variances', approx(reconSummary.totalVariance, sumVar), `${reconSummary.totalVariance} == ${sumVar}`);
  } else check('reconciliation summary persisted on run', false);

  // ── 6. Material variance stages a balanced true-up ─────────────────────────
  if (reconSummary && !reconSummary.withinMateriality) {
    const tu = reconSummary.trueUp;
    check('true-up JE staged for material variance', !!tu);
    if (tu) {
      const d = tu.lines.reduce((s, l) => s + (l.debit || 0), 0);
      const c = tu.lines.reduce((s, l) => s + (l.credit || 0), 0);
      check('true-up JE balances', approx(d, c), `Dr ${round2(d)} / Cr ${round2(c)}`);
      check('true-up amount == |portfolio variance|', approx(tu.amount, Math.abs(reconSummary.totalVariance)));
    }
  } else {
    check('within materiality -> no true-up needed', reconSummary && !reconSummary.trueUp);
  }

  // ── 7. Applying a proposal versioned a policy with an audit row ────────────
  const versions = await prisma.objectVersion.findMany({ where: { objectType: 'policy' } });
  check('exactly one ObjectVersion written', versions.length === 1, `${versions.length}`);
  const applied = await prisma.improvementProposal.findFirst({ where: { status: 'applied' } });
  check('one proposal marked applied', !!applied);
  if (versions[0]) {
    const v = versions[0];
    check('ObjectVersion bumped policy to v2', v.version === 2, `v${v.version}`);
    check('ObjectVersion records before -> after diff', v.diff && v.diff.before !== undefined && v.diff.after !== undefined,
      v.diff ? `${v.diff.param}: ${v.diff.before} -> ${v.diff.after}` : '');
    check('ObjectVersion has an approver (signed change)', !!v.approvedBy, v.approvedBy);
    const pol = await prisma.policy.findUnique({ where: { id: v.objectId } });
    check('live policy version matches audit row', pol && pol.version === v.version, pol && `policy v${pol.version}`);
  }

  // ── 8. Doc catalogs internally consistent (no duplicate operation ids) ─────
  const ops = API_GROUPS.flatMap((g) => g.endpoints.map((e) => e.op));
  check('REST op ids are unique', new Set(ops).size === ops.length, `${ops.length} endpoints`);
  const names = TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name));
  check('MCP tool names are unique', new Set(names).size === names.length, `${names.length} tools`);
  check('catalog counters agree with declared entries', endpointCount() === ops.length && toolCount() === names.length,
    `REST ${endpointCount()}, MCP ${toolCount()}`);

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('VALIDATION ERROR:', e); process.exit(1); });
