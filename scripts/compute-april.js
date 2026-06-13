// Validation harness: ingest April shipments, run the deterministic accrual
// engine, and print per-carrier + grand totals. Sanity-checks the core before
// any DB/UI is layered on. Run: node scripts/compute-april.js

const { ingestShipments, ingestInvoices, ingestDenise } = require('../services/accrual/ingest');
const { computeAccrual } = require('../services/accrual/compute');
const { computeCalibration } = require('../services/accrual/calibrate');
const { estimateAccrual } = require('../services/accrual/estimate');
const { trailingBaselines } = require('../services/accrual/baseline');

const fmt = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const { shipments, dataQuality } = ingestShipments();
const result = computeAccrual(shipments);

console.log('\n=== INGESTION ===');
console.log(`Shipments parsed: ${shipments.length}`);
console.log(`Data-quality notes: ${dataQuality.length}`);
const dqByType = {};
for (const d of dataQuality) dqByType[d.type] = (dqByType[d.type] || 0) + 1;
console.log(dqByType);

console.log('\n=== ACCRUAL BY CARRIER ===');
for (const c of ['peak', 'heartland', 'coastal']) {
  const b = result.byCarrier[c];
  console.log(
    `${c.padEnd(10)} n=${String(b.shipmentCount).padStart(3)}  ` +
    `base=${fmt(b.base).padStart(13)}  fuel=${fmt(b.fuel).padStart(11)}  ` +
    `acc=${fmt(b.accessorials).padStart(10)}  total=${fmt(b.total).padStart(13)}`
  );
}
console.log(`${'TOTAL'.padEnd(10)} n=${String(result.shipmentCount).padStart(3)}  ${' '.repeat(40)}total=${fmt(result.total).padStart(13)}`);

console.log('\n=== EXCEPTIONS ===');
const exByType = {};
for (const e of result.exceptions) exByType[e.type] = (exByType[e.type] || 0) + 1;
console.log(`Total: ${result.exceptions.length}`);
console.log(exByType);
const critical = result.exceptions.filter((e) => e.severity === 'critical');
if (critical.length) {
  console.log(`\nCRITICAL (${critical.length}):`);
  for (const e of critical) console.log(`  ${e.shipmentId}  ${e.type}: ${e.message}`);
}

console.log('\n=== CALIBRATION (learned from invoice history) ===');
const calibration = computeCalibration(ingestInvoices());
for (const c of ['peak', 'heartland', 'coastal']) {
  const k = calibration[c];
  console.log(`${c.padEnd(10)} factor=${k.factor.toFixed(3)}  spread=${k.spread.toFixed(3)}  cv=${k.cv.toFixed(3)}  n=${k.n}`);
}

console.log('\n=== BOOKED ACCRUAL (engine x calibration, ensemble + 90% band) ===');
const denise = ingestDenise();
const reconByCarrier = { peak: [], heartland: [], coastal: [] };
for (const d of denise) if (reconByCarrier[d.carrier]) reconByCarrier[d.carrier].push({ carrier: d.carrier, actualInvoiced: d.actualInvoiced });
const baselines = trailingBaselines(reconByCarrier);
const est = estimateAccrual(result, calibration, { materialityThreshold: 1500, maxCv: 0.15, baselines });
for (const c of ['peak', 'heartland', 'coastal']) {
  const e = est.carriers[c];
  console.log(
    `${c.padEnd(10)} contract=${fmt(e.contractual).padStart(13)}  ` +
    `point=${fmt(e.point).padStart(13)}  [${fmt(e.low)} – ${fmt(e.high)}]  w=${e.engineWeight}  ${e.decision.decision}`
  );
}
const p = est.portfolio;
console.log(`${'PORTFOLIO'.padEnd(10)} contract=${fmt(p.contractual).padStart(13)}  point=${fmt(p.point).padStart(13)}  [${fmt(p.low)} – ${fmt(p.high)}]  ${p.decision.decision}`);

console.log('\n=== DENISE BASELINE (trailing comparison context) ===');
const recent = {};
for (const d of denise) {
  (recent[d.carrier] ||= []).push(d);
}
for (const c of ['peak', 'heartland', 'coastal']) {
  const rows = (recent[c] || []).slice(-3);
  if (!rows.length) continue;
  const avgEst = rows.reduce((s, r) => s + r.accrualEstimate, 0) / rows.length;
  const avgAct = rows.reduce((s, r) => s + r.actualInvoiced, 0) / rows.length;
  console.log(`${c.padEnd(10)} trailing-3 avg estimate=${fmt(avgEst).padStart(13)}  avg actual=${fmt(avgAct).padStart(13)}`);
}
console.log('');
