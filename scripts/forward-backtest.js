// FORWARD backtest — the honest scoreboard. For each month M we:
//   1. calibrate the realization factor on months < M ONLY (no look-ahead),
//   2. price month M's ACTUAL shipments through the deterministic engine,
//   3. apply the calibration → point estimate + 90% band,
//   4. score against what was actually invoiced, and against Denise's estimate.
//
// This simulates real monthly deployment and isolates our true edge: bottom-up
// volume/mix pricing + adaptive realization factor vs a flat trailing-dollar mean.

const { ingestInvoices, ingestDenise } = require('../services/accrual/ingest');
const { calcPeak, calcHeartland, calcCoastal } = require('../services/accrual/rateEngine');
const { computeCalibration, heartlandQtdMap, invoiceToShipment, quarterKey } = require('../services/accrual/calibrate');
const { estimateAccrual } = require('../services/accrual/estimate');
const { trailingBaselines } = require('../services/accrual/baseline');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const mkKey = (sm) => { const [m, y] = sm.split(' '); return parseInt(y, 10) * 100 + MONTHS.indexOf(m); };

const invoices = ingestInvoices();
const denise = ingestDenise();
const deniseMap = {};
for (const d of denise) deniseMap[`${mkKey(d.month)}|${d.carrier}`] = d;

// Group invoices by service month.
const byMonth = {};
for (const inv of invoices) (byMonth[inv.serviceMonth] ||= []).push(inv);
const monthList = Object.keys(byMonth).sort((a, b) => mkKey(a) - mkKey(b));

// Deterministic contractual for a single month's invoices (engine prices the shipments).
function contractualForMonth(monthInvoices, qtdMap) {
  const byCarrier = { peak: { total: 0 }, heartland: { total: 0 }, coastal: { total: 0 } };
  for (const inv of monthInvoices) {
    const s = invoiceToShipment(inv);
    let r;
    if (inv.carrier === 'peak') r = calcPeak(s);
    else if (inv.carrier === 'heartland') r = calcHeartland(s, qtdMap.get(inv.invoiceId));
    else if (inv.carrier === 'coastal') r = calcCoastal(s);
    else continue;
    byCarrier[inv.carrier].total += r.total;
  }
  const total = byCarrier.peak.total + byCarrier.heartland.total + byCarrier.coastal.total;
  return { byCarrier, total };
}

const qtdAll = heartlandQtdMap(invoices); // QTD positions across full history

const score = {
  point: { peak: [], heartland: [], coastal: [] },
  denise: { peak: [], heartland: [], coastal: [] },
  bandHits: 0, bandTotal: 0,
};

console.log('\n=== FORWARD BACKTEST (calibrate on prior months only) ===\n');
// Start predicting once we have >=2 months of history for a stable factor.
for (let i = 2; i < monthList.length; i++) {
  const month = monthList[i];
  const priorInvoices = monthList.slice(0, i).flatMap((m) => byMonth[m]);
  const calibration = computeCalibration(priorInvoices);
  const contractual = contractualForMonth(byMonth[month], qtdAll);
  // Trailing baselines from prior months' actuals (no look-ahead) for the ensemble.
  const reconByCarrier = { peak: [], heartland: [], coastal: [] };
  for (let k = 0; k < i; k++) {
    for (const c of ['peak', 'heartland', 'coastal']) {
      const d = deniseMap[`${mkKey(monthList[k])}|${c}`];
      if (d) reconByCarrier[c].push({ carrier: c, actualInvoiced: d.actualInvoiced });
    }
  }
  const baselines = trailingBaselines(reconByCarrier);
  const est = estimateAccrual({ byCarrier: contractual.byCarrier, total: contractual.total }, calibration, { baselines });

  console.log(`── ${month} ──`);
  console.log('  carrier      actual   point   band[low–high]   pErr   denise  dErr');
  for (const c of ['peak', 'heartland', 'coastal']) {
    const mk = mkKey(month);
    const d = deniseMap[`${mk}|${c}`];
    const actual = d ? d.actualInvoiced : null;
    const e = est.carriers[c];
    if (actual != null) {
      const pErr = e.point - actual;
      const dErr = d.accrualEstimate - actual;
      score.point[c].push(Math.abs(pErr));
      score.denise[c].push(Math.abs(dErr));
      const inBand = actual >= e.low && actual <= e.high;
      score.bandHits += inBand ? 1 : 0; score.bandTotal++;
      console.log(
        `  ${c.padEnd(10)} ${('$' + Math.round(actual)).padStart(7)} ${('$' + Math.round(e.point)).padStart(7)}`
        + `  [${Math.round(e.low)}–${Math.round(e.high)}]`.padEnd(17)
        + ` ${(pErr >= 0 ? '+' : '') + Math.round(pErr)}`.padStart(7)
        + ` ${('$' + Math.round(d.accrualEstimate)).padStart(7)} ${(dErr >= 0 ? '+' : '') + Math.round(dErr)}`.padStart(8)
        + (inBand ? '  ✓band' : '  ✗band')
      );
    }
  }
  console.log('');
}

const mae = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
console.log('=== SCORE (mean abs error per carrier-month, forward) ===');
let allP = [], allD = [];
for (const c of ['peak', 'heartland', 'coastal']) {
  console.log(`  ${c.padEnd(10)} engine $${mae(score.point[c])}   denise $${mae(score.denise[c])}`);
  allP = allP.concat(score.point[c]); allD = allD.concat(score.denise[c]);
}
console.log(`  ${'TOTAL'.padEnd(10)} engine $${mae(allP)}   denise $${mae(allD)}`);
console.log(`\n  Engine is ${Math.round((1 - mae(allP) / mae(allD)) * 100)}% more accurate than Denise.`);
console.log(`  90% band coverage: ${score.bandHits}/${score.bandTotal} (${Math.round(100 * score.bandHits / score.bandTotal)}%)\n`);
