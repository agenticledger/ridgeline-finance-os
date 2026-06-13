// Backtest [D]: replay every historical invoice (Oct 2025–Mar 2026) through the
// deterministic rate engine, aggregate to month×carrier, and score against BOTH
// the actual invoiced totals AND Denise's trailing-average estimates.
//
// The challenge is graded on monthly accrual accuracy, so the headline metric is:
// "engine monthly MAE vs Denise monthly MAE" per carrier.

const { ingestInvoices, ingestDenise } = require('../services/accrual/ingest');
const { calcPeak, calcHeartland, calcCoastal, round2 } = require('../services/accrual/rateEngine');

function quarterOf(serviceMonth) {
  const m = serviceMonth.toLowerCase();
  if (/(october|november|december) 2025/.test(m)) return '2025Q4';
  if (/(january|february|march) 2026/.test(m)) return '2026Q1';
  if (/(april|may|june) 2026/.test(m)) return '2026Q2';
  return 'other';
}
function monthKey(serviceMonth) {
  const order = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const [mname, yr] = serviceMonth.toLowerCase().split(' ');
  return parseInt(yr, 10) * 100 + order.indexOf(mname);
}

const invoices = ingestInvoices();
const denise = ingestDenise();

function toShipment(inv) {
  return {
    shipmentId: inv.shipmentRef || inv.invoiceId,
    date: inv.invoiceDate,
    originCity: 'Denver',
    destCity: inv.destCity, destState: inv.destState, destZip: inv.destZip,
    carrier: inv.carrier, weightLbs: inv.weightLbs,
    residential: /residential/i.test(inv.accessorialDetail || ''),
    specialHandling: inv.accessorialDetail,
  };
}

// Heartland QTD cumulative ordering, per quarter (resets each quarter).
const heartlandByQ = {};
for (const inv of invoices.filter((i) => i.carrier === 'heartland')) {
  (heartlandByQ[quarterOf(inv.serviceMonth)] ||= []).push(inv);
}
const heartlandQtd = new Map();
for (const q of Object.keys(heartlandByQ)) {
  heartlandByQ[q]
    .sort((a, b) => (a.invoiceDate < b.invoiceDate ? -1 : a.invoiceDate > b.invoiceDate ? 1 : a.invoiceId.localeCompare(b.invoiceId)))
    .forEach((inv, i) => heartlandQtd.set(inv.invoiceId, i + 1));
}

// month -> carrier -> { predicted, contractedActual, invoicedActual }
const grid = {};
for (const inv of invoices) {
  const s = toShipment(inv);
  let r;
  if (inv.carrier === 'peak') r = calcPeak(s);
  else if (inv.carrier === 'heartland') r = calcHeartland(s, heartlandQtd.get(inv.invoiceId));
  else if (inv.carrier === 'coastal') r = calcCoastal(s);
  else continue;
  const mk = monthKey(inv.serviceMonth);
  const cell = ((grid[mk] ||= {})[inv.carrier] ||= { month: inv.serviceMonth, predicted: 0, contractedActual: 0, invoicedActual: 0, n: 0 });
  cell.predicted += r.total;
  cell.contractedActual += inv.baseCharge + inv.fuelSurcharge + inv.accessorialFees;
  cell.invoicedActual += inv.totalCharge;
  cell.n++;
}

const deniseMap = {};
for (const d of denise) deniseMap[`${monthKey(d.month)}|${d.carrier}`] = d;

const carrierLabel = { peak: 'Peak', heartland: 'Heartland', coastal: 'Coastal' };
const months = Object.keys(grid).map(Number).sort();

console.log('\n=== MONTHLY ACCRUAL BACKTEST: Engine vs Denise vs Actual Invoiced ===\n');
const agg = { peak: { eng: [], den: [] }, heartland: { eng: [], den: [] }, coastal: { eng: [], den: [] } };

for (const c of ['peak', 'heartland', 'coastal']) {
  console.log(`── ${carrierLabel[c]} ──`);
  console.log('  Month            Actual    Engine   Eng err     Denise   Den err');
  for (const mk of months) {
    const cell = grid[mk] && grid[mk][c];
    if (!cell) continue;
    const d = deniseMap[`${mk}|${c}`];
    const actual = cell.invoicedActual;
    const eng = cell.predicted;
    const engErr = eng - actual;
    const denEst = d ? d.accrualEstimate : null;
    const denErr = d ? denEst - d.actualInvoiced : null;
    agg[c].eng.push(Math.abs(engErr));
    if (d) agg[c].den.push(Math.abs(denErr));
    console.log(
      `  ${cell.month.padEnd(15)} ${('$' + Math.round(actual)).padStart(7)}  ${('$' + Math.round(eng)).padStart(7)}  ${(engErr >= 0 ? '+' : '') + Math.round(engErr)}`.padEnd(52)
      + ` ${denEst != null ? ('$' + Math.round(denEst)).padStart(7) : '   —  '}  ${denErr != null ? (denErr >= 0 ? '+' : '') + Math.round(denErr) : '—'}`
    );
  }
  const mae = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  console.log(`  ── Engine MAE: $${Math.round(mae(agg[c].eng))}/mo   |   Denise MAE: $${Math.round(mae(agg[c].den))}/mo\n`);
}

// Total-portfolio monthly MAE
const mae = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const allEng = [...agg.peak.eng, ...agg.heartland.eng, ...agg.coastal.eng];
const allDen = [...agg.peak.den, ...agg.heartland.den, ...agg.coastal.den];
console.log('=== HEADLINE ===');
console.log(`  Engine per-carrier-month MAE: $${Math.round(mae(allEng))}`);
console.log(`  Denise per-carrier-month MAE: $${Math.round(mae(allDen))}`);
console.log(`  Improvement: ${Math.round((1 - mae(allEng) / mae(allDen)) * 100)}% lower error\n`);
