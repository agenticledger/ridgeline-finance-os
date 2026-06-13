// Deterministic rate engine [D]. Applies each carrier's contracted rate card to a
// normalized shipment and returns a fully auditable line-item breakdown.
// No estimation or probability here — pure contracted math.

const { PEAK, HEARTLAND, COASTAL } = require('./rateConfig');
const {
  resolveHeartlandZone, resolveCoastalRegion, resolvePeakMileage, peakWeightTier,
} = require('./normalize');

const round2 = (n) => Math.round(n * 100) / 100;

// Parse special_handling into accessorial fee line items for a carrier.
// skipResidential: Coastal handles residential via the tiered flag surcharge, not as a flat fee.
function applyAccessorials(specialHandling, accessorials, { skipResidential = false } = {}) {
  const items = [];
  if (!specialHandling) return { total: 0, items };
  const parts = String(specialHandling).split(',').map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (skipResidential && /residential/i.test(part)) continue;
    // match against known accessorials (case-insensitive contains)
    const key = Object.keys(accessorials).find((k) => k.toLowerCase() === part.toLowerCase()
      || part.toLowerCase().includes(k.toLowerCase()));
    if (key) {
      items.push({ label: part, fee: accessorials[key] });
    } else {
      items.push({ label: part, fee: 0, note: 'unrecognized accessorial — assumed $0' });
    }
  }
  return { total: round2(items.reduce((s, i) => s + i.fee, 0)), items };
}

// ─────────────────────────── PEAK ───────────────────────────
function calcPeak(shipment) {
  const flags = [];
  const { miles, source, flags: mFlags } = resolvePeakMileage(
    shipment.destCity, shipment.destState, shipment.originCity,
  );
  flags.push(...mFlags);

  if (shipment.weightLbs == null) flags.push({ type: 'missing_weight', severity: 'critical', message: 'Weight missing for Peak shipment.' });
  if (miles == null) {
    return { carrier: 'peak', baseCharge: 0, fuelSurcharge: 0, accessorialFees: 0, total: 0, breakdown: { error: 'mileage_unresolved' }, flags };
  }

  const tier = peakWeightTier(shipment.weightLbs ?? 0);
  const rate = tier ? tier.ratePerMile : PEAK.weightTiers[0].ratePerMile;
  let base = round2(miles * rate);
  const rawBase = base;
  let minApplied = false;
  if (base < PEAK.minimumCharge) { base = PEAK.minimumCharge; minApplied = true; }

  const fuel = round2(base * PEAK.fuelSurchargePct);
  const acc = applyAccessorials(shipment.specialHandling, PEAK.accessorials);
  const total = round2(base + fuel + acc.total);

  return {
    carrier: 'peak',
    baseCharge: base, fuelSurcharge: fuel, accessorialFees: acc.total, total,
    breakdown: {
      miles, mileageSource: source, weightLbs: shipment.weightLbs,
      weightTier: tier ? tier.label : 'unknown', ratePerMile: rate,
      rawBase, minimumCharge: PEAK.minimumCharge, minApplied,
      fuelPct: PEAK.fuelSurchargePct, accessorials: acc.items,
    },
    flags,
  };
}

// ─────────────────────────── HEARTLAND ───────────────────────────
// qtdCount = this shipment's cumulative quarter-to-date position (1-based).
function calcHeartland(shipment, qtdCount) {
  const flags = [];
  const { zone, flag } = resolveHeartlandZone(shipment.destZip);
  if (flag) flags.push({ type: flag, severity: 'critical', message: `Heartland zone unresolved for ZIP ${shipment.destZip}.` });
  if (zone == null) {
    return { carrier: 'heartland', baseCharge: 0, fuelSurcharge: 0, accessorialFees: 0, total: 0, breakdown: { error: 'zone_unresolved' }, flags };
  }

  const flatRate = HEARTLAND.zoneRates[zone];
  const vt = HEARTLAND.volumeTiers.find((t) => qtdCount >= t.min && qtdCount <= t.max) || HEARTLAND.volumeTiers[0];
  const discount = vt.discount;
  const base = round2(flatRate * (1 - discount));
  if (discount > 0) flags.push({ type: 'volume_discount_applied', severity: 'info', message: `QTD #${qtdCount} → Tier ${vt.tier} (${(discount * 100).toFixed(0)}% off).` });

  // Fuel included; accessorials NOT discounted.
  const acc = applyAccessorials(shipment.specialHandling, HEARTLAND.accessorials);
  const total = round2(base + acc.total);

  return {
    carrier: 'heartland',
    baseCharge: base, fuelSurcharge: 0, accessorialFees: acc.total, total,
    breakdown: {
      zone, flatRate, qtdCount, volumeTier: vt.tier, discountPct: discount,
      fuelIncluded: true, accessorials: acc.items,
    },
    flags,
  };
}

// ─────────────────────────── COASTAL ───────────────────────────
function calcCoastal(shipment) {
  const flags = [];
  const { region, flag } = resolveCoastalRegion(shipment.destZip, COASTAL);
  if (flag) flags.push({ type: flag, severity: 'critical', message: `Coastal region unresolved for ZIP ${shipment.destZip}.` });
  if (!region) {
    return { carrier: 'coastal', baseCharge: 0, fuelSurcharge: 0, accessorialFees: 0, total: 0, breakdown: { error: 'region_unresolved' }, flags };
  }
  if (shipment.weightLbs == null) flags.push({ type: 'missing_weight', severity: 'critical', message: 'Weight missing for Coastal shipment.' });

  const weight = shipment.weightLbs ?? 0;
  let base = round2(weight * region.ratePerLb);
  const rawBase = base;
  let minApplied = false;
  if (base < COASTAL.minimumCharge) { base = COASTAL.minimumCharge; minApplied = true; }

  const fuel = round2(base * COASTAL.fuelSurchargePct);

  // Residential surcharge (tiered by weight) when flagged.
  let residential = 0;
  let resTier = null;
  if (shipment.residential) {
    const t = COASTAL.residentialTiers.find((r) => weight >= r.min && weight <= r.max);
    if (t) { residential = t.surcharge; resTier = `${t.min}-${t.max} lbs`; }
  }

  // Other accessorials (skip residential — handled above).
  const acc = applyAccessorials(shipment.specialHandling, COASTAL.accessorials, { skipResidential: true });
  const accessorialTotal = round2(acc.total + residential);
  const total = round2(base + fuel + accessorialTotal);

  return {
    carrier: 'coastal',
    baseCharge: base, fuelSurcharge: fuel, accessorialFees: accessorialTotal, total,
    breakdown: {
      region: region.name, ratePerLb: region.ratePerLb, weightLbs: weight,
      rawBase, minimumCharge: COASTAL.minimumCharge, minApplied,
      fuelPct: COASTAL.fuelSurchargePct,
      residential: { applied: !!shipment.residential, tier: resTier, surcharge: residential },
      accessorials: acc.items,
    },
    flags,
  };
}

module.exports = { calcPeak, calcHeartland, calcCoastal, round2, applyAccessorials };
