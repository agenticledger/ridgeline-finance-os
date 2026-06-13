// Diagnostic: reverse-engineer the true rate parameters from historical invoices
// so we can calibrate the rate cards. Prints implied mileage (Peak), implied
// fuel/zone behavior (Heartland), implied per-lb (Coastal).

const { ingestInvoices } = require('../services/accrual/ingest');
const { PEAK, HEARTLAND, COASTAL } = require('../services/accrual/rateConfig');
const { peakWeightTier, resolveHeartlandZone, resolveCoastalRegion } = require('../services/accrual/normalize');

const invoices = ingestInvoices();
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ── PEAK: implied miles = base_charge / tier_rate(weight) ──
console.log('\n=== PEAK: implied miles per destination (base / weight-tier rate) ===');
const peakByDest = {};
for (const inv of invoices.filter((i) => i.carrier === 'peak')) {
  const tier = peakWeightTier(inv.weightLbs ?? 0);
  if (!tier) continue;
  const impliedMiles = inv.baseCharge / tier.ratePerMile;
  const key = `${inv.destCity}, ${inv.destState}`;
  (peakByDest[key] ||= []).push(impliedMiles);
}
const peakTable = PEAK.mileage;
for (const [dest, arr] of Object.entries(peakByDest).sort()) {
  arr.sort((a, b) => a - b);
  const med = arr[Math.floor(arr.length / 2)];
  const min = arr[0], max = arr[arr.length - 1];
  const cur = peakTable[dest] ? peakTable[dest].miles : (PEAK.outOfTerritory[dest] ? PEAK.outOfTerritory[dest].miles : '—');
  const spread = round(max - min, 1);
  const flag = (cur !== '—' && Math.abs(med - cur) > 5) ? '  <<< MISMATCH' : '';
  console.log(`  ${dest.padEnd(26)} n=${String(arr.length).padStart(3)}  implied≈${String(round(med, 0)).padStart(4)}mi (spread ${spread})  current=${cur}${flag}`);
}

// ── HEARTLAND: does fuel exist? what is implied zone rate? ──
console.log('\n=== HEARTLAND: fuel column + implied base behavior ===');
const hFuel = invoices.filter((i) => i.carrier === 'heartland');
const fuelNonZero = hFuel.filter((i) => i.fuelSurcharge > 0).length;
console.log(`  lines with fuel_surcharge > 0: ${fuelNonZero}/${hFuel.length}`);
console.log(`  avg fuel_surcharge: $${round(hFuel.reduce((s, i) => s + i.fuelSurcharge, 0) / hFuel.length)}`);
console.log(`  avg fuel/base ratio: ${round(hFuel.reduce((s, i) => s + (i.baseCharge ? i.fuelSurcharge / i.baseCharge : 0), 0) / hFuel.length, 4)}`);
// implied zone flat rate (base, no discount) grouped by resolved zone
const hByZone = {};
for (const inv of hFuel) {
  const { zone } = resolveHeartlandZone(inv.destZip);
  if (zone == null) continue;
  (hByZone[zone] ||= []).push(inv.baseCharge);
}
console.log('  implied base_charge by resolved zone (min/median/max — discounts pull median below the card rate):');
for (const z of Object.keys(hByZone).sort()) {
  const a = hByZone[z].sort((x, y) => x - y);
  console.log(`    zone ${z}: card=$${HEARTLAND.zoneRates[z]}  actual min=$${round(a[0])} med=$${round(a[Math.floor(a.length / 2)])} max=$${round(a[a.length - 1])}  n=${a.length}`);
}

// ── COASTAL: implied per-lb + fuel ratio by region ──
console.log('\n=== COASTAL: implied per-lb + fuel by region ===');
const cInv = invoices.filter((i) => i.carrier === 'coastal');
const fuelRatioC = cInv.filter((i) => i.baseCharge).map((i) => i.fuelSurcharge / i.baseCharge);
console.log(`  avg fuel/base ratio: ${round(fuelRatioC.reduce((s, x) => s + x, 0) / fuelRatioC.length, 4)} (card=${COASTAL.fuelSurchargePct})`);
const cByRegion = {};
for (const inv of cInv) {
  const { region } = resolveCoastalRegion(inv.destZip, COASTAL);
  if (!region || !inv.weightLbs) continue;
  (cByRegion[region.name] ||= []).push(inv.baseCharge / inv.weightLbs);
}
for (const [name, arr] of Object.entries(cByRegion)) {
  arr.sort((a, b) => a - b);
  const card = COASTAL.regions.find((r) => r.name === name).ratePerLb;
  console.log(`  ${name.padEnd(8)} implied $/lb med=${round(arr[Math.floor(arr.length / 2)], 3)}  card=${card}  n=${arr.length}`);
}
console.log('');
