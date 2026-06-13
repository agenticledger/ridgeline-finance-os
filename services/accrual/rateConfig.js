// Rate card configuration — parsed from the three carrier rate cards.
// Treated as versioned config (rate-card-as-config principle). The deterministic
// engine reads these; updating a rate is a config edit, not a code change.

// ─────────────────────────── PEAK LOGISTICS ───────────────────────────
// Per-mile by weight tier + 14% fuel + $185 minimum. Mountain West.
const PEAK = {
  carrier: 'peak',
  version: 3,
  effective: '2025-01-01',
  weightTiers: [
    { label: 'Under 500 lbs', min: 0, max: 499.99, ratePerMile: 3.25 },
    { label: '500-2,000 lbs', min: 500, max: 2000, ratePerMile: 4.80 },
    { label: 'Over 2,000 lbs', min: 2000.01, max: Infinity, ratePerMile: 6.40 },
  ],
  fuelSurchargePct: 0.14,
  minimumCharge: 185.0,
  accessorials: {
    'Liftgate': 75,
    'Residential Delivery': 45,
    'Appointment Delivery': 50,
    'Inside Delivery': 125,
    'Redelivery': 150, // shipper/consignee fault
  },
  // Origin: Denver, CO. miles + source provenance for audit.
  // INVOICE-CALIBRATED: the rate card's "Approx. Miles" table is explicitly
  // approximate ("contact your rep"), and 6 months of invoices show Peak bills
  // on a materially shorter mileage basis than the published road miles. We use
  // the median implied miles (base_charge / tier rate) from invoice history as
  // the lane estimate; residual per-lane spread feeds the confidence layer.
  // Published values are retained as comments for audit trail.
  mileage: {
    // invoice-calibrated (median implied miles; published value in comment)
    'Fort Collins|CO': { miles: 52, source: 'invoice-calibrated' },        // published 59
    'Colorado Springs|CO': { miles: 56, source: 'invoice-calibrated' },    // published 70
    'Pueblo|CO': { miles: 89, source: 'invoice-calibrated' },              // published — / derived 100
    'Laramie|WY': { miles: 100, source: 'invoice-calibrated' },            // published — / derived 118
    'Cheyenne|WY': { miles: 68, source: 'invoice-calibrated' },            // published 100
    'Casper|WY': { miles: 242, source: 'invoice-calibrated' },             // published — / derived 272
    'Grand Junction|CO': { miles: 222, source: 'invoice-calibrated' },     // published — / derived 222
    'Pocatello|ID': { miles: 355, source: 'invoice-calibrated' },          // published 440
    'Idaho Falls|ID': { miles: 348, source: 'invoice-calibrated' },        // published 480
    'Provo|UT': { miles: 378, source: 'invoice-calibrated' },              // published 490
    'Salt Lake City|UT': { miles: 339, source: 'invoice-calibrated' },     // published 525
    'Billings|MT': { miles: 399, source: 'invoice-calibrated' },           // published 550
    'Great Falls|MT': { miles: 434, source: 'invoice-calibrated' },        // published 710
    // published-only (no invoice history to calibrate against — used as-is, flagged)
    'Ogden|UT': { miles: 590, source: 'published-uncalibrated' },
    'Boise|ID': { miles: 830, source: 'published-uncalibrated' },
    'Missoula|MT': { miles: 830, source: 'published-uncalibrated' },
  },
  // Non-Denver origin lane estimates (flagged as assumptions)
  originAdjustments: {
    'Salt Lake City': {
      'Colorado Springs|CO': 565,
      'Fort Collins|CO': 520,
      'Casper|WY': 410,
    },
  },
  // Out-of-territory destinations (outside CO/UT/WY/MT/ID) — flagged
  outOfTerritory: {
    'Reno|NV': { miles: 1000, source: 'estimated-out-of-territory' },
  },
};

// ─────────────────────────── HEARTLAND FREIGHT ───────────────────────────
// Flat rate by zone (ZIP prefix) + quarterly cumulative volume discount. Midwest.
const HEARTLAND = {
  carrier: 'heartland',
  version: 2,
  effective: '2025-01-01',
  zoneRates: { 1: 320, 2: 485, 3: 610, 4: 780 },
  fuelIncluded: true, // NO separate FSC
  accessorials: {
    'Liftgate': 85,
    'Inside Delivery': 135,
    'Appointment Delivery': 40,
    'Detention': 75, // per hour — not modeled per-shipment
  },
  // ZIP 3-digit prefix → zone. Range-based per the lookup table.
  zonePrefixRanges: [
    { lo: 640, hi: 641, zone: 1 }, // KC metro MO
    { lo: 660, hi: 662, zone: 1 }, // KC metro KS (Zone 1 despite KS state)
    { lo: 663, hi: 668, zone: 2 }, // Eastern KS
    { lo: 669, hi: 679, zone: 2 }, // Rest of KS
    { lo: 630, hi: 639, zone: 2 }, // Eastern MO (St. Louis)
    { lo: 650, hi: 659, zone: 2 }, // Central/southern MO
    { lo: 500, hi: 529, zone: 2 }, // All Iowa
    { lo: 680, hi: 685, zone: 2 }, // Southern/central NE
    { lo: 600, hi: 609, zone: 3 }, // Chicago metro
    { lo: 610, hi: 629, zone: 3 }, // Rest of IL
    { lo: 530, hi: 546, zone: 3 }, // Southern/central WI
    { lo: 550, hi: 554, zone: 3 }, // Twin Cities
    { lo: 547, hi: 549, zone: 4 }, // Northern WI
    { lo: 555, hi: 567, zone: 4 }, // Greater MN
    { lo: 686, hi: 693, zone: 4 }, // Northern/western NE
  ],
  // Quarterly cumulative volume discount tiers (QTD shipment count)
  volumeTiers: [
    { tier: 1, min: 1, max: 50, discount: 0.00 },
    { tier: 2, min: 51, max: 120, discount: 0.05 },
    { tier: 3, min: 121, max: 200, discount: 0.10 },
    { tier: 4, min: 201, max: Infinity, discount: 0.15 },
  ],
};

// ─────────────────────────── COASTAL EXPRESS ───────────────────────────
// Per-pound by region (ZIP range) + $28 min + 9.5% fuel (base only) + tiered residential. West Coast.
const COASTAL = {
  carrier: 'coastal',
  version: 1,
  effective: '2025-01-01',
  // ratePerLb INVOICE-CALIBRATED from heavy (>300 lb) shipments where the per-lb
  // (not the minimum) binds. Published card rate retained for audit. Billed history
  // shows a consistent ~14-15% uplift over card across all three regions.
  regions: [
    { name: 'SoCal', zipLo: 90000, zipHi: 92899, ratePerLb: 0.55, cardRatePerLb: 0.48 },
    { name: 'NorCal', zipLo: 93000, zipHi: 96199, ratePerLb: 0.63, cardRatePerLb: 0.55 },
    { name: 'PNW', zipLo: 97000, zipHi: 99499, ratePerLb: 0.835, cardRatePerLb: 0.72 },
  ],
  // Light DTC parcels (<60 lb) bill at a flat ~$32 floor (calibrated). Card stated
  // $28; billed history shows the effective floor is ~$32 with a hard $21.99 floor.
  minimumCharge: 32.0,
  fuelSurchargePct: 0.095, // base only, before accessorials
  residentialTiers: [
    { min: 0, max: 49.99, surcharge: 12.5 },
    { min: 50, max: 500, surcharge: 35.0 },
    { min: 500.01, max: Infinity, surcharge: 65.0 },
  ],
  accessorials: {
    'Liftgate': 90,
    'Inside Delivery': 110,
    'Appointment Delivery': 55,
    'Saturday Delivery': 150,
  },
};

module.exports = { PEAK, HEARTLAND, COASTAL };
