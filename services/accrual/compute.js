// Accrual aggregator [D]. Orchestrates the rate engine across all shipments,
// handling Heartland's quarter-to-date cumulative volume-tier progression.
// Pure function: shipments in → full accrual result out.

const { calcPeak, calcHeartland, calcCoastal, round2 } = require('./rateEngine');

function computeAccrual(shipments) {
  const lines = [];
  const exceptions = [];

  // Heartland needs QTD ordering: sort by date, assign cumulative count.
  // (April = Q2 month 1, so the quarter starts fresh on Apr 1.)
  const heartland = shipments.filter((s) => s.carrier === 'heartland')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.shipmentId.localeCompare(b.shipmentId)));
  const heartlandQtd = new Map();
  heartland.forEach((s, i) => heartlandQtd.set(s.shipmentId, i + 1));

  for (const s of shipments) {
    let result;
    if (s.carrier === 'peak') result = calcPeak(s);
    else if (s.carrier === 'heartland') result = calcHeartland(s, heartlandQtd.get(s.shipmentId));
    else if (s.carrier === 'coastal') result = calcCoastal(s);
    else { exceptions.push({ shipmentId: s.shipmentId, type: 'unknown_carrier', severity: 'critical', message: `No engine for carrier "${s.carrierRaw}".` }); continue; }

    lines.push({
      shipmentId: s.shipmentId, carrier: s.carrier, date: s.date,
      destCity: s.destCity, destState: s.destState, destZip: s.destZip,
      weightLbs: s.weightLbs, weightEstimated: s.weightEstimated,
      serviceLevel: s.serviceLevel, residential: s.residential,
      specialHandling: s.specialHandling,
      baseCharge: result.baseCharge, fuelSurcharge: result.fuelSurcharge,
      accessorialFees: result.accessorialFees, total: result.total,
      breakdown: result.breakdown, flags: result.flags,
    });

    for (const f of result.flags || []) {
      exceptions.push({ shipmentId: s.shipmentId, type: f.type, severity: f.severity || 'warning', message: f.message });
    }
    if (s.weightEstimated) {
      exceptions.push({ shipmentId: s.shipmentId, type: 'weight_estimated', severity: 'info', message: `Weight estimated at ${s.weightLbs} lbs.` });
    }
  }

  // Per-carrier aggregation
  const byCarrier = {};
  for (const c of ['peak', 'heartland', 'coastal']) {
    const cl = lines.filter((l) => l.carrier === c);
    byCarrier[c] = {
      carrier: c,
      shipmentCount: cl.length,
      base: round2(cl.reduce((s, l) => s + l.baseCharge, 0)),
      fuel: round2(cl.reduce((s, l) => s + l.fuelSurcharge, 0)),
      accessorials: round2(cl.reduce((s, l) => s + l.accessorialFees, 0)),
      total: round2(cl.reduce((s, l) => s + l.total, 0)),
    };
  }
  const total = round2(Object.values(byCarrier).reduce((s, c) => s + c.total, 0));

  return { lines, exceptions, byCarrier, total, shipmentCount: lines.length };
}

module.exports = { computeAccrual };
