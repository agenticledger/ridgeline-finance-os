// CSV ingestion [D]. Parses challenge data into normalized JS objects and runs
// data-quality checks. Pure functions — no DB dependency, so the engine can be
// validated standalone.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { normalizeCarrier, normalizeServiceLevel } = require('./normalize');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function readCsv(file) {
  const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true });
}

// ── Shipments: dedup, normalize, estimate missing weights, flag issues ──
function ingestShipments(file = 'shipments_apr2026.csv', period = 'April 2026') {
  const rows = readCsv(file);
  const seen = new Set();
  const shipments = [];
  const dataQuality = [];

  // First pass: parse + normalize
  for (const r of rows) {
    const id = r.shipment_id;
    if (seen.has(id)) {
      dataQuality.push({ type: 'duplicate', shipmentId: id, message: `Duplicate shipment ${id} removed.` });
      continue;
    }
    seen.add(id);
    const carrier = normalizeCarrier(r.carrier);
    if (!carrier) dataQuality.push({ type: 'unknown_carrier', shipmentId: id, message: `Unrecognized carrier "${r.carrier}".` });
    const weightLbs = r.weight_lbs === '' || r.weight_lbs == null ? null : parseFloat(r.weight_lbs);
    shipments.push({
      shipmentId: id,
      date: r.date,
      originCity: r.origin_city || null,
      originState: r.origin_state || null,
      destCity: r.destination_city || null,
      destState: r.destination_state || null,
      destZip: r.destination_zip || null,
      carrierRaw: r.carrier,
      carrier,
      serviceLevelRaw: r.service_level || null,
      serviceLevel: normalizeServiceLevel(r.service_level),
      weightLbs,
      weightEstimated: false,
      units: r.units ? parseInt(r.units, 10) : null,
      residential: String(r.residential).toUpperCase() === 'TRUE',
      specialHandling: r.special_handling || null,
      period,
    });
  }

  // Median lbs/unit per carrier (for weight estimation)
  const ratios = {};
  for (const s of shipments) {
    if (s.weightLbs != null && s.units) {
      (ratios[s.carrier] ||= []).push(s.weightLbs / s.units);
    }
  }
  const medianRatio = {};
  for (const [c, arr] of Object.entries(ratios)) {
    arr.sort((a, b) => a - b);
    medianRatio[c] = arr[Math.floor(arr.length / 2)];
  }

  // Second pass: estimate missing weights
  for (const s of shipments) {
    if (s.weightLbs == null) {
      const ratio = medianRatio[s.carrier];
      if (ratio && s.units) {
        s.weightLbs = Math.round(ratio * s.units * 10) / 10;
        s.weightEstimated = true;
        dataQuality.push({ type: 'weight_estimated', shipmentId: s.shipmentId, message: `Missing weight estimated as ${s.weightLbs} lbs (${s.units} units × ${ratio.toFixed(1)} median lbs/unit for ${s.carrier}).` });
      } else {
        dataQuality.push({ type: 'missing_weight', shipmentId: s.shipmentId, severity: 'critical', message: 'Weight missing and could not be estimated.' });
      }
    }
  }

  return { shipments, dataQuality };
}

function ingestInvoices(file = 'freight_invoices_oct2025_mar2026_v2.csv') {
  return readCsv(file).map((r) => ({
    invoiceId: r.invoice_id,
    carrier: normalizeCarrier(r.carrier),
    invoiceDate: r.invoice_date,
    serviceMonth: r.service_month,
    shipmentRef: r.shipment_ref || null,
    destCity: r.destination_city || null,
    destState: r.destination_state || null,
    destZip: r.destination_zip || null,
    weightLbs: r.weight_lbs ? parseFloat(r.weight_lbs) : null,
    baseCharge: parseFloat(r.base_charge) || 0,
    fuelSurcharge: parseFloat(r.fuel_surcharge) || 0,
    accessorialFees: parseFloat(r.accessorial_fees) || 0,
    accessorialDetail: r.accessorial_detail || null,
    adjustments: parseFloat(r.adjustments) || 0,
    totalCharge: parseFloat(r.total_charge) || 0,
  }));
}

function ingestDenise(file = 'denise_accruals_v2.csv') {
  return readCsv(file).map((r) => ({
    month: r.month,
    carrier: normalizeCarrier(r.carrier),
    accrualEstimate: parseFloat(r.accrual_estimate) || 0,
    actualInvoiced: parseFloat(r.actual_invoiced) || 0,
    varianceDollars: parseFloat(r.variance_dollars) || 0,
    variancePct: parseFloat(r.variance_pct) || 0,
    notes: r.notes || null,
  }));
}

module.exports = { ingestShipments, ingestInvoices, ingestDenise, readCsv, DATA_DIR };
