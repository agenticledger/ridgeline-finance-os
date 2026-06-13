// Recursive-improvement plane [LEARN]. Replays the deployment month by month with
// NO look-ahead — calibrate on prior months only, price the month's actual shipments,
// apply the learned factor, then reconcile against what was actually invoiced and
// against Denise's trailing-average. Returns structured results the Mission Control
// Improvement plane renders: the reconciliation trail, the factor the engine learned
// at each step, head-to-head accuracy, and band coverage. This is the closed loop —
// every cycle the realization factor and the baseline get a fresh, honest grade.

const { ingestInvoices, ingestDenise } = require('./ingest');
const { calcPeak, calcHeartland, calcCoastal } = require('./rateEngine');
const { computeCalibration, heartlandQtdMap, invoiceToShipment } = require('./calibrate');
const { estimateAccrual } = require('./estimate');
const { trailingBaselines } = require('./baseline');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const CARRIERS = ['peak', 'heartland', 'coastal'];
const mkKey = (sm) => { const [m, y] = sm.split(' '); return parseInt(y, 10) * 100 + MONTHS.indexOf(m); };
const mae = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
const round2 = (n) => Math.round(n * 100) / 100;

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

// Forward replay → structured learning record for the Improvement plane.
function forwardLearn() {
  const invoices = ingestInvoices();
  const denise = ingestDenise();
  const deniseMap = {};
  for (const d of denise) deniseMap[`${mkKey(d.month)}|${d.carrier}`] = d;

  const byMonth = {};
  for (const inv of invoices) (byMonth[inv.serviceMonth] ||= []).push(inv);
  const monthList = Object.keys(byMonth).sort((a, b) => mkKey(a) - mkKey(b));
  const qtdAll = heartlandQtdMap(invoices);

  const absErr = { point: { peak: [], heartland: [], coastal: [] }, denise: { peak: [], heartland: [], coastal: [] } };
  let bandHits = 0, bandTotal = 0;
  const cycles = [];
  const factorSeries = { peak: [], heartland: [], coastal: [] };

  for (let i = 2; i < monthList.length; i++) {
    const month = monthList[i];
    const priorInvoices = monthList.slice(0, i).flatMap((m) => byMonth[m]);
    const calibration = computeCalibration(priorInvoices);
    const contractual = contractualForMonth(byMonth[month], qtdAll);

    const reconByCarrier = { peak: [], heartland: [], coastal: [] };
    for (let k = 0; k < i; k++) {
      for (const c of CARRIERS) {
        const d = deniseMap[`${mkKey(monthList[k])}|${c}`];
        if (d) reconByCarrier[c].push({ carrier: c, actualInvoiced: d.actualInvoiced });
      }
    }
    const baselines = trailingBaselines(reconByCarrier);
    const est = estimateAccrual({ byCarrier: contractual.byCarrier, total: contractual.total }, calibration, { baselines });

    const cyc = { month, label: month.replace(/ 20/, " '"), carriers: {}, engineTotal: 0, deniseTotal: 0, actualTotal: 0 };
    for (const c of CARRIERS) {
      factorSeries[c].push({ month, factor: calibration[c] ? calibration[c].factor : null });
      const d = deniseMap[`${mkKey(month)}|${c}`];
      const actual = d ? d.actualInvoiced : null;
      const e = est.carriers[c];
      if (actual != null) {
        const pErr = e.point - actual;
        const dErr = d.accrualEstimate - actual;
        absErr.point[c].push(Math.abs(pErr));
        absErr.denise[c].push(Math.abs(dErr));
        const inBand = actual >= e.low && actual <= e.high;
        bandHits += inBand ? 1 : 0; bandTotal++;
        cyc.carriers[c] = {
          actual: round2(actual), point: round2(e.point), low: round2(e.low), high: round2(e.high),
          denise: round2(d.accrualEstimate), engineErr: round2(pErr), deniseErr: round2(dErr), inBand,
        };
        cyc.engineTotal += e.point; cyc.deniseTotal += d.accrualEstimate; cyc.actualTotal += actual;
      }
    }
    cyc.engineTotal = round2(cyc.engineTotal); cyc.deniseTotal = round2(cyc.deniseTotal); cyc.actualTotal = round2(cyc.actualTotal);
    cyc.engineErr = round2(cyc.engineTotal - cyc.actualTotal);
    cyc.deniseErr = round2(cyc.deniseTotal - cyc.actualTotal);
    cycles.push(cyc);
  }

  const maeByCarrier = {};
  let allP = [], allD = [];
  for (const c of CARRIERS) {
    maeByCarrier[c] = { engine: mae(absErr.point[c]), denise: mae(absErr.denise[c]) };
    allP = allP.concat(absErr.point[c]); allD = allD.concat(absErr.denise[c]);
  }
  const engineMae = mae(allP), deniseMae = mae(allD);

  return {
    cycles,
    factorSeries,
    maeByCarrier,
    engineMae,
    deniseMae,
    improvementPct: deniseMae ? Math.round((1 - engineMae / deniseMae) * 100) : 0,
    coverage: { hits: bandHits, total: bandTotal, pct: bandTotal ? Math.round((100 * bandHits) / bandTotal) : 0 },
    monthsReplayed: cycles.length,
  };
}

module.exports = { forwardLearn };
