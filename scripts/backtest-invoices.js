// Back-test the deterministic engine against 6 months of historical invoices.
// For each invoice we reconstruct a shipment-equivalent input, compute the
// CONTRACTUAL charge, and compare to what was actually invoiced. The gap is the
// real-world variance Denise can't see. We summarize it as a per-carrier
// realization factor (actual / contractual) + residual spread — the calibration
// constants the agentic estimation layer will apply on top of the clean math.

const { ingestInvoices } = require('../services/accrual/ingest');
const { calcPeak, calcHeartland, calcCoastal } = require('../services/accrual/rateEngine');
const { HEARTLAND } = require('../services/accrual/rateConfig');

const fmt = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;

const invoices = ingestInvoices();

// Heartland QTD: assign cumulative position within each calendar quarter.
const quarterOf = (month) => {
  // service_month like "October 2025"
  const [m, y] = month.split(' ');
  const mi = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'].indexOf(m);
  const q = Math.floor(mi / 3) + 1;
  return `${y}-Q${q}`;
};
const heartlandQtd = new Map();
{
  const hl = invoices.filter((i) => i.carrier === 'heartland')
    .map((i, idx) => ({ i, idx, q: quarterOf(i.serviceMonth) }))
    .sort((a, b) => (a.i.serviceMonth < b.i.serviceMonth ? -1 : a.i.serviceMonth > b.i.serviceMonth ? 1 : a.idx - b.idx));
  const counter = {};
  for (const row of hl) {
    counter[row.q] = (counter[row.q] || 0) + 1;
    heartlandQtd.set(row.i.invoiceId, counter[row.q]);
  }
}

const toShipment = (inv) => ({
  shipmentId: inv.invoiceId,
  destCity: inv.destCity, destState: inv.destState, destZip: inv.destZip,
  originCity: 'Denver',
  weightLbs: inv.weightLbs,
  residential: /residential/i.test(inv.accessorialDetail || ''),
  specialHandling: inv.accessorialDetail || null,
});

const stats = {};
for (const c of ['peak', 'heartland', 'coastal']) {
  stats[c] = { n: 0, computed: 0, actualPreAdj: 0, actualTotal: 0, ratios: [], unresolved: 0 };
}

for (const inv of invoices) {
  const c = inv.carrier;
  if (!stats[c]) continue;
  const s = toShipment(inv);
  let r;
  if (c === 'peak') r = calcPeak(s);
  else if (c === 'heartland') r = calcHeartland(s, heartlandQtd.get(inv.invoiceId));
  else r = calcCoastal(s);

  if (r.breakdown && r.breakdown.error) { stats[c].unresolved++; continue; }

  const actualPreAdj = inv.baseCharge + inv.fuelSurcharge + inv.accessorialFees;
  stats[c].n++;
  stats[c].computed += r.total;
  stats[c].actualPreAdj += actualPreAdj;
  stats[c].actualTotal += inv.totalCharge;
  if (r.total > 0) stats[c].ratios.push(actualPreAdj / r.total);
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const stdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

console.log('\n=== BACK-TEST: contractual engine vs actual invoices (Oct25-Mar26) ===\n');
let totComp = 0, totAct = 0;
for (const c of ['peak', 'heartland', 'coastal']) {
  const x = stats[c];
  const realization = x.actualTotal / x.computed;
  console.log(`${c.toUpperCase()}  (n=${x.n}, unresolved=${x.unresolved})`);
  console.log(`  contractual computed : ${fmt(x.computed).padStart(14)}`);
  console.log(`  actual pre-adjustment: ${fmt(x.actualPreAdj).padStart(14)}  (ratio ${pct(x.actualPreAdj / x.computed)})`);
  console.log(`  actual total (w/ adj): ${fmt(x.actualTotal).padStart(14)}  (realization ${pct(realization)})`);
  console.log(`  per-invoice ratio    : mean ${x.ratios.length ? mean(x.ratios).toFixed(3) : 'n/a'}  median ${x.ratios.length ? median(x.ratios).toFixed(3) : 'n/a'}  stdev ${x.ratios.length ? stdev(x.ratios).toFixed(3) : 'n/a'}`);
  console.log('');
  totComp += x.computed;
  totAct += x.actualTotal;
}
console.log(`PORTFOLIO  computed=${fmt(totComp)}  actual=${fmt(totAct)}  realization=${pct(totAct / totComp)}`);
console.log('');
