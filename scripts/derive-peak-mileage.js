// Derive Peak per-destination mileage from historical invoices, cleanly.
// Distance is a property of the lane, not the shipment, so we isolate it using
// only the Under-500 tier (unambiguous $3.25/mi) and drop rows floored at the
// $185 minimum (which hide true distance). Median implied miles = lane estimate;
// the residual spread feeds the confidence layer, not the point estimate.

const { ingestInvoices } = require('../services/accrual/ingest');
const { PEAK } = require('../services/accrual/rateConfig');

const UNDER_500_RATE = PEAK.weightTiers[0].ratePerMile; // 3.25
const MIN = PEAK.minimumCharge; // 185

const invoices = ingestInvoices().filter((i) => i.carrier === 'peak');

const byDest = {};
for (const inv of invoices) {
  if (inv.weightLbs == null || inv.weightLbs >= 500) continue;     // Under-500 tier only
  if (!inv.baseCharge || inv.baseCharge <= MIN + 0.01) continue;   // drop min-floored
  const implied = inv.baseCharge / UNDER_500_RATE;
  const key = `${inv.destCity}|${inv.destState}`;
  (byDest[key] ||= []).push(implied);
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdev = (arr) => {
  const mn = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - mn) ** 2, 0) / arr.length);
};

console.log('\n=== RECALIBRATED PEAK MILEAGE (Under-500 tier, min-floored excluded) ===\n');
console.log('dest'.padEnd(24), 'n'.padStart(4), 'newMi'.padStart(8), 'cv%'.padStart(7), 'config'.padStart(8), 'delta%'.padStart(8));
const out = {};
for (const [key, arr] of Object.entries(byDest).sort((a, b) => b[1].length - a[1].length)) {
  const med = Math.round(median(arr) * 10) / 10;
  const cv = stdev(arr) / median(arr);
  const cfg = PEAK.mileage[key];
  const cfgMi = cfg ? cfg.miles : null;
  const deltaPct = cfgMi != null ? ((med - cfgMi) / cfgMi) * 100 : null;
  out[key] = med;
  console.log(
    key.padEnd(24), String(arr.length).padStart(4), med.toFixed(1).padStart(8),
    (cv * 100).toFixed(1).padStart(7), (cfgMi != null ? String(cfgMi) : '-').padStart(8),
    (deltaPct != null ? (deltaPct >= 0 ? '+' : '') + deltaPct.toFixed(1) : '-').padStart(8),
  );
}
console.log('\nJSON (miles, source=derived-from-invoices):');
console.log(JSON.stringify(out, null, 2));
console.log('');
