// Deterministic data normalization + resolvers.
// Handles the messy-data gauntlet: carrier name variants, service levels,
// ZIP-to-zone mapping, and Peak mileage resolution with provenance.

const { PEAK, HEARTLAND } = require('./rateConfig');

// ── Carrier name normalization (6 variants → 3 canonical) ──
function normalizeCarrier(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase();
  if (s.startsWith('PEAK')) return 'peak';
  if (s.startsWith('HEARTLAND')) return 'heartland';
  if (s.startsWith('COASTAL')) return 'coastal';
  return null;
}

// ── Service level canonicalization (informational; does not affect rates) ──
function normalizeServiceLevel(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const map = {
    std: 'Standard', standard: 'Standard',
    economy: 'Economy', ground: 'Ground',
    express: 'Expedited', expedited: 'Expedited',
  };
  return map[s] || (raw.charAt(0).toUpperCase() + raw.slice(1));
}

// ── Heartland ZIP prefix → zone (by prefix, NOT state) ──
function resolveHeartlandZone(zip) {
  if (!zip) return { zone: null, flag: 'missing_zip' };
  const prefix = parseInt(String(zip).slice(0, 3), 10);
  if (isNaN(prefix)) return { zone: null, flag: 'invalid_zip' };
  const match = HEARTLAND.zonePrefixRanges.find((r) => prefix >= r.lo && prefix <= r.hi);
  if (!match) return { zone: null, flag: 'zip_not_in_zone_table' };
  return { zone: match.zone };
}

// ── Coastal region by ZIP range ──
function resolveCoastalRegion(zip, COASTAL) {
  if (!zip) return { region: null, flag: 'missing_zip' };
  const z = parseInt(String(zip).slice(0, 5), 10);
  if (isNaN(z)) return { region: null, flag: 'invalid_zip' };
  const match = COASTAL.regions.find((r) => z >= r.zipLo && z <= r.zipHi);
  if (!match) return { region: null, flag: 'zip_out_of_service_area' };
  return { region: match };
}

// ── Peak mileage resolver with provenance + flags ──
function resolvePeakMileage(city, state, originCity) {
  const key = `${city}|${state}`;
  const flags = [];

  // Non-Denver origin lane adjustment
  if (originCity && originCity !== 'Denver') {
    const originTable = PEAK.originAdjustments[originCity];
    if (originTable && originTable[key]) {
      flags.push({ type: 'origin_assumption', message: `Non-Denver origin (${originCity}); using estimated lane mileage.` });
      return { miles: originTable[key], source: 'origin-adjusted-estimate', flags };
    }
    flags.push({ type: 'origin_assumption', message: `Non-Denver origin (${originCity}); mileage table is Denver-primary. Using Denver mileage as proxy.` });
  }

  // Out-of-territory
  if (PEAK.outOfTerritory[key]) {
    flags.push({ type: 'out_of_territory', severity: 'critical', message: `${city}, ${state} is outside Peak's stated service area (CO/UT/WY/MT/ID).` });
    return { miles: PEAK.outOfTerritory[key].miles, source: PEAK.outOfTerritory[key].source, flags };
  }

  // Published or derived table
  const entry = PEAK.mileage[key];
  if (entry) {
    if (entry.source === 'invoice-calibrated') {
      flags.push({ type: 'mileage_calibrated', severity: 'info', message: `Mileage for ${city} calibrated to billed history (${entry.miles} mi; published table runs higher).` });
    } else if (entry.source === 'published-uncalibrated') {
      flags.push({ type: 'mileage_uncalibrated', severity: 'warning', message: `Mileage for ${city} uses the published table (${entry.miles} mi) — no invoice history to calibrate against.` });
    }
    return { miles: entry.miles, source: entry.source, flags };
  }

  // Unknown
  flags.push({ type: 'missing_mileage', severity: 'critical', message: `No mileage available for ${city}, ${state}.` });
  return { miles: null, source: 'unknown', flags };
}

// ── Peak weight tier lookup ──
function peakWeightTier(weight) {
  return PEAK.weightTiers.find((t) => weight >= t.min && weight <= t.max) || null;
}

module.exports = {
  normalizeCarrier,
  normalizeServiceLevel,
  resolveHeartlandZone,
  resolveCoastalRegion,
  resolvePeakMileage,
  peakWeightTier,
};
