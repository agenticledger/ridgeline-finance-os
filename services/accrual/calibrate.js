// Calibration [A-by-data]. Learns each carrier's real-world realization factor
// from historical invoices: the ratio of what was actually invoiced to what the
// deterministic contract engine says it should have been. This is the bridge
// between clean contract math and messy reality — and the thing Denise's flat
// trailing-dollar average cannot capture, because it adapts to volume and mix.
//
// Output per carrier: factor (median actual/contractual), spread (stdev of the
// ratio for confidence intervals), and the supporting sample size.

const { calcPeak, calcHeartland, calcCoastal } = require('./rateEngine');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function quarterKey(serviceMonth) {
  const [m, y] = String(serviceMonth).split(' ');
  const q = Math.floor(MONTHS.indexOf(m) / 3) + 1;
  return `${y}-Q${q}`;
}

// Reconstruct Heartland quarter-to-date positions across the invoice history so
// the volume-tier discount is applied the same way it was when billed.
function heartlandQtdMap(invoices) {
  const map = new Map();
  const hl = invoices
    .filter((i) => i.carrier === 'heartland')
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => (a.i.serviceMonth < b.i.serviceMonth ? -1
      : a.i.serviceMonth > b.i.serviceMonth ? 1 : a.idx - b.idx));
  const counter = {};
  for (const { i } of hl) {
    const q = quarterKey(i.serviceMonth);
    counter[q] = (counter[q] || 0) + 1;
    map.set(i.invoiceId, counter[q]);
  }
  return map;
}

function invoiceToShipment(inv) {
  return {
    shipmentId: inv.invoiceId,
    destCity: inv.destCity, destState: inv.destState, destZip: inv.destZip,
    originCity: 'Denver',
    weightLbs: inv.weightLbs,
    residential: /residential/i.test(inv.accessorialDetail || ''),
    specialHandling: inv.accessorialDetail || null,
  };
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// Build per-carrier calibration from invoice history.
//
// The realization factor is modelled at the MONTH level, not the shipment level.
// A whole month's shipments share one exogenous rate environment (fuel index, demand
// pricing), so the realization factor is a COMMON shock across the month — it does
// NOT diversify away with shipment count. We therefore compute one factor per
// carrier-month (Σactual / Σcontractual) and take the median as the central factor
// and the stdev as the monthly spread that drives the confidence band.
function computeCalibration(invoices) {
  const qtd = heartlandQtdMap(invoices);
  // carrier -> month -> { contractual, actual, n }
  const grid = {};
  const totals = {};
  for (const c of ['peak', 'heartland', 'coastal']) { grid[c] = {}; totals[c] = { contractual: 0, actual: 0, n: 0, unresolved: 0 }; }

  for (const inv of invoices) {
    const c = inv.carrier;
    if (!grid[c]) continue;
    const s = invoiceToShipment(inv);
    let r;
    if (c === 'peak') r = calcPeak(s);
    else if (c === 'heartland') r = calcHeartland(s, qtd.get(inv.invoiceId));
    else r = calcCoastal(s);

    if (r.breakdown && r.breakdown.error) { totals[c].unresolved++; continue; }

    const cell = (grid[c][inv.serviceMonth] ||= { contractual: 0, actual: 0, n: 0 });
    cell.contractual += r.total; cell.actual += inv.totalCharge; cell.n++;
    totals[c].contractual += r.total; totals[c].actual += inv.totalCharge; totals[c].n++;
  }

  const calibration = {};
  for (const c of ['peak', 'heartland', 'coastal']) {
    const cells = Object.values(grid[c]).filter((m) => m.contractual > 0);
    const monthlyFactors = cells.map((m) => m.actual / m.contractual);
    const monthlyContractual = cells.map((m) => m.contractual);
    const med = median(monthlyFactors);
    const sd = stdev(monthlyFactors); // monthly factor volatility — the real uncertainty
    calibration[c] = {
      carrier: c,
      n: totals[c].n,                                 // shipments observed
      months: monthlyFactors.length,                  // months observed
      unresolved: totals[c].unresolved,
      factor: Math.round(med * 1000) / 1000,          // median monthly actual/contractual
      factorMean: Math.round(mean(monthlyFactors) * 1000) / 1000,
      spread: Math.round(sd * 1000) / 1000,           // stdev of the monthly factor
      cv: med ? Math.round((sd / med) * 1000) / 1000 : 0,
      // Historical monthly contractual distribution — used to detect a volume/mix
      // shift (a current month whose bottom-up contractual falls outside the normal
      // range is a real mix change to trust, not rate noise to dampen).
      contractualMean: Math.round(mean(monthlyContractual) * 100) / 100,
      contractualSd: Math.round(stdev(monthlyContractual) * 100) / 100,
      contractualTotal: Math.round(totals[c].contractual * 100) / 100,
      actualTotal: Math.round(totals[c].actual * 100) / 100,
    };
  }
  return calibration;
}

module.exports = { computeCalibration, quarterKey, heartlandQtdMap, invoiceToShipment };
