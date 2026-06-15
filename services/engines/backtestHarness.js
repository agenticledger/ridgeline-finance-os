// Reusable forward-backtest harness — the SCOREBOARD that gates methodology edits.
//
// Mirrors scripts/forward-backtest.js (no look-ahead: calibrate on months < M only)
// but returns STRUCTURED metrics instead of printing, and accepts the estimateAccrual
// implementation as a parameter so a candidate engine can be scored before activation.
// The validated stable deps (ingest, rate engine, calibration, baseline) are fixed;
// only the methodology under test varies.

const { ingestInvoices, ingestDenise } = require('../accrual/ingest');
const { calcPeak, calcHeartland, calcCoastal } = require('../accrual/rateEngine');
const { computeCalibration, heartlandQtdMap, invoiceToShipment } = require('../accrual/calibrate');
const { trailingBaselines } = require('../accrual/baseline');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const mkKey = (sm) => { const [m, y] = sm.split(' '); return parseInt(y, 10) * 100 + MONTHS.indexOf(m); };
const mae = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);

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

// Run the forward backtest against a given estimateAccrual implementation.
// Returns { portfolioMae, deniseMae, improvementPct, bandCoverage, bandHits, bandTotal,
//           perCarrier: { peak, heartland, coastal }, rows: [...] }.
function runBacktest(estimateAccrual) {
  if (typeof estimateAccrual !== 'function') throw new Error('runBacktest requires an estimateAccrual function.');
  const invoices = ingestInvoices();
  const denise = ingestDenise();
  const deniseMap = {};
  for (const d of denise) deniseMap[`${mkKey(d.month)}|${d.carrier}`] = d;

  const byMonth = {};
  for (const inv of invoices) (byMonth[inv.serviceMonth] ||= []).push(inv);
  const monthList = Object.keys(byMonth).sort((a, b) => mkKey(a) - mkKey(b));
  const qtdAll = heartlandQtdMap(invoices);

  const carrierErr = { point: { peak: [], heartland: [], coastal: [] }, denise: { peak: [], heartland: [], coastal: [] } };
  const portfolio = { engErr: [], denErr: [], hits: 0, total: 0, rows: [] };

  for (let i = 2; i < monthList.length; i++) {
    const month = monthList[i];
    const priorInvoices = monthList.slice(0, i).flatMap((m) => byMonth[m]);
    const calibration = computeCalibration(priorInvoices);
    const contractual = contractualForMonth(byMonth[month], qtdAll);
    const reconByCarrier = { peak: [], heartland: [], coastal: [] };
    for (let k = 0; k < i; k++) {
      for (const c of ['peak', 'heartland', 'coastal']) {
        const d = deniseMap[`${mkKey(monthList[k])}|${c}`];
        if (d) reconByCarrier[c].push({ carrier: c, actualInvoiced: d.actualInvoiced });
      }
    }
    const baselines = trailingBaselines(reconByCarrier);
    const est = estimateAccrual({ byCarrier: contractual.byCarrier, total: contractual.total }, calibration, { baselines });

    let actTot = 0; let denTot = 0; let haveAll = true;
    for (const c of ['peak', 'heartland', 'coastal']) {
      const d = deniseMap[`${mkKey(month)}|${c}`];
      if (!d) { haveAll = false; break; }
      actTot += d.actualInvoiced; denTot += d.accrualEstimate;
    }
    if (haveAll) {
      const p = est.portfolio;
      const eErr = p.point - actTot; const dErr = denTot - actTot;
      const inBand = actTot >= p.low && actTot <= p.high;
      portfolio.engErr.push(Math.abs(eErr));
      portfolio.denErr.push(Math.abs(dErr));
      portfolio.hits += inBand ? 1 : 0; portfolio.total++;
      portfolio.rows.push({ month, actTot: Math.round(actTot), point: Math.round(p.point), eErr: Math.round(eErr), denTot: Math.round(denTot), dErr: Math.round(dErr), low: Math.round(p.low), high: Math.round(p.high), inBand });
    }
    for (const c of ['peak', 'heartland', 'coastal']) {
      const d = deniseMap[`${mkKey(month)}|${c}`];
      if (!d) continue;
      const e = est.carriers[c];
      carrierErr.point[c].push(Math.abs(e.point - d.actualInvoiced));
      carrierErr.denise[c].push(Math.abs(d.accrualEstimate - d.actualInvoiced));
    }
  }

  const portfolioMae = mae(portfolio.engErr);
  const deniseMae = mae(portfolio.denErr);
  return {
    portfolioMae,
    deniseMae,
    improvementPct: deniseMae ? Math.round((1 - portfolioMae / deniseMae) * 100) : 0,
    bandHits: portfolio.hits,
    bandTotal: portfolio.total,
    bandCoverage: portfolio.total ? Math.round((100 * portfolio.hits) / portfolio.total) : 0,
    perCarrier: {
      peak: { engine: mae(carrierErr.point.peak), denise: mae(carrierErr.denise.peak) },
      heartland: { engine: mae(carrierErr.point.heartland), denise: mae(carrierErr.denise.heartland) },
      coastal: { engine: mae(carrierErr.point.coastal), denise: mae(carrierErr.denise.coastal) },
    },
    rows: portfolio.rows,
  };
}

module.exports = { runBacktest };
