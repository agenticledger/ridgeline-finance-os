const { ingestShipments } = require('../services/accrual/ingest');
const { calcPeak } = require('../services/accrual/rateEngine');
const { shipments } = ingestShipments();
const peak = shipments.filter(s => s.carrier === 'peak');
const rows = peak.map(s => ({ s, r: calcPeak(s) })).sort((a,b) => b.r.total - a.r.total);
console.log(`April Peak: n=${peak.length}`);
let sum=0; for(const{r} of rows) sum+=r.total;
console.log(`contractual total: $${Math.round(sum)}\n`);
console.log('top 12 by total:');
for(const{s,r} of rows.slice(0,12)){
  console.log(`  ${s.shipmentId} ${String(s.destCity).padEnd(16)} ${String(s.weightLbs).padStart(7)}lb ${(r.breakdown.miles||'?')+'mi'} tier=${r.breakdown.weightTier} base=$${Math.round(r.baseCharge)} total=$${Math.round(r.total)} ${r.breakdown.mileageSource||''}`);
}
// weight tier distribution
const tiers={}; for(const{s} of rows){const w=s.weightLbs; const t=w<500?'<500':w<=2000?'500-2000':'>2000'; tiers[t]=(tiers[t]||0)+1;}
console.log('\nweight tier counts:', tiers);
// destination distribution
const dest={}; for(const{s} of rows) dest[s.destCity]=(dest[s.destCity]||0)+1;
console.log('destinations:', dest);
