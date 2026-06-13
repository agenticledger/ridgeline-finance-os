// Accrual orchestration service. Runs the full Execution-plane pipeline end to end
// and returns one rich, view-ready result object. Deliberately DB-independent so the
// deterministic core can run live from the data files (the demo works with no DB);
// persistence is layered on top by the caller when a run is posted.
//
// Pipeline:  ingest → [D] price → [D] calibrate → [stat] estimate → controls/exceptions
//            → JE preview → Denise comparison.

const { ingestShipments, ingestInvoices, ingestDenise } = require('./ingest');
const { computeAccrual } = require('./compute');
const { computeCalibration } = require('./calibrate');
const { estimateAccrual } = require('./estimate');
const { trailingBaselines } = require('./baseline');
const { forwardLearn } = require('./learn');

const round2 = (n) => Math.round(n * 100) / 100;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const CARRIER_META = {
  peak: { label: 'Peak Logistics', region: 'Mountain West', model: 'Per-mile × weight tier + 14% fuel, $185 min' },
  heartland: { label: 'Heartland Freight', region: 'Midwest', model: 'Flat zone rate (ZIP) + quarterly volume discount, fuel incl.' },
  coastal: { label: 'Coastal Express', region: 'West Coast', model: 'Per-lb × region + 9.5% fuel + tiered residential, $32 min' },
};

// Denise trailing-3-month baseline (her method) for an honest side-by-side.
function deniseEstimate(denise, period) {
  const out = {};
  for (const c of ['peak', 'heartland', 'coastal']) {
    const rows = denise.filter((d) => d.carrier === c).slice(-3);
    out[c] = rows.length ? round2(rows.reduce((s, r) => s + r.actualInvoiced, 0) / rows.length) : null;
  }
  out.total = round2(['peak', 'heartland', 'coastal'].reduce((s, c) => s + (out[c] || 0), 0));
  return out;
}

function runAccrual({ period = 'April 2026', materialityThreshold = 1500, maxCv = 0.15, bandZ = 1.645, mixShiftZ = 1 } = {}) {
  // ── Ingest ─────────────────────────────────────────────────────────
  const { shipments, dataQuality } = ingestShipments('shipments_apr2026.csv', period);
  const invoices = ingestInvoices();
  const denise = ingestDenise();

  // ── Deterministic pricing ──────────────────────────────────────────
  const accrual = computeAccrual(shipments);

  // ── Learn calibration + trailing baselines from history ────────────
  const calibration = computeCalibration(invoices);
  const reconByCarrier = { peak: [], heartland: [], coastal: [] };
  for (const d of denise) if (reconByCarrier[d.carrier]) reconByCarrier[d.carrier].push({ carrier: d.carrier, actualInvoiced: d.actualInvoiced });
  const baselines = trailingBaselines(reconByCarrier);

  // ── Estimate (regime-aware ensemble + 90% band + gate) ─────────────
  const est = estimateAccrual(accrual, calibration, { materialityThreshold, maxCv, baselines, bandZ, mixShiftZ });

  // ── Assemble per-carrier view rows ─────────────────────────────────
  const denise3 = deniseEstimate(denise, period);
  const carriers = ['peak', 'heartland', 'coastal'].map((c) => {
    const sub = accrual.byCarrier[c];
    const e = est.carriers[c];
    const cal = calibration[c];
    const lines = accrual.lines.filter((l) => l.carrier === c);
    const carrierExceptions = accrual.exceptions.filter((x) => lines.some((l) => l.shipmentId === x.shipmentId));
    return {
      key: c,
      ...CARRIER_META[c],
      shipmentCount: sub.shipmentCount,
      base: sub.base, fuel: sub.fuel, accessorials: sub.accessorials,
      contractual: e.contractual,
      factor: cal.factor, factorSpread: cal.spread,
      point: e.point, low: e.low, high: e.high, halfBand: e.halfBand,
      engineWeight: e.engineWeight, invVarWeight: e.invVarWeight, mixShift: e.mixShift,
      baseline: e.baseline,
      decision: e.decision.decision,
      cv: e.decision.cv,
      denise: denise3[c],
      vsDenise: denise3[c] != null ? round2(e.point - denise3[c]) : null,
      exceptionCount: carrierExceptions.length,
      lineCount: lines.length,
    };
  });

  // ── Exceptions: enrich + sort by severity ──────────────────────────
  const sevRank = { critical: 0, warning: 1, info: 2 };
  const exceptions = accrual.exceptions
    .map((x) => {
      const line = accrual.lines.find((l) => l.shipmentId === x.shipmentId);
      return { ...x, carrier: line ? line.carrier : null, dollarImpact: line ? line.total : null, destCity: line ? line.destCity : null };
    })
    .sort((a, b) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3));
  const exceptionSummary = {};
  for (const x of exceptions) exceptionSummary[x.severity] = (exceptionSummary[x.severity] || 0) + 1;

  // ── JE preview (the artifact Finance actually books) ───────────────
  const je = {
    period,
    date: monthEnd(period),
    lines: [
      ...carriers.map((c) => ({ account: '6100 · Freight Expense', subledger: c.label, debit: c.point, credit: 0 })),
      { account: '2150 · Accrued Freight Liability', subledger: 'All carriers', debit: 0, credit: est.portfolio.point },
    ],
    total: est.portfolio.point,
  };

  // ── Portfolio + headline vs Denise ─────────────────────────────────
  const portfolio = {
    contractual: est.portfolio.contractual,
    point: est.portfolio.point,
    low: est.portfolio.low,
    high: est.portfolio.high,
    decision: est.portfolio.decision.decision,
    denise: denise3.total,
    vsDenise: round2(est.portfolio.point - denise3.total),
  };

  const dq = summarize(dataQuality, 'type');

  // ══ CONTROL PLANE ═══════════════════════════════════════════════════
  // Oversight & policy. The materiality x confidence gate decides what a human
  // sees; everything else auto-posts. "Deterministic by default, agentic by
  // exception" — the overseer signs the exceptions, not the routine.
  const dispositions = { auto_post: 0, review: 0, escalate: 0 };
  for (const c of carriers) dispositions[c.decision] = (dispositions[c.decision] || 0) + 1;

  const gateMatrix = carriers.map((c) => {
    const eC = est.carriers[c.key];
    const xRatio = c.cv / maxCv;                       // confidence axis (1 = CV limit)
    const yRatio = eC.halfBand / materialityThreshold; // materiality axis (1 = threshold)
    // Plot space spans 0..2 with the policy threshold at 1.0. Materiality ratios run
    // large (bands dwarf a $1.5k threshold), so compress above the line to keep nodes
    // distinct without hiding that all three are material.
    return {
      key: c.key, label: c.label, decision: c.decision, point: c.point,
      cv: c.cv, halfBand: eC.halfBand,
      material: eC.decision.material, confident: eC.decision.confident,
      x: round2(Math.min(1.95, xRatio)),
      y: round2(Math.min(1.95, yRatio > 1 ? 1 + (yRatio - 1) * 0.12 : yRatio)),
    };
  });

  const overseerQueue = [
    ...carriers.filter((c) => c.decision !== 'auto_post').map((c) => ({
      kind: 'disposition',
      severity: c.decision === 'escalate' ? 'critical' : 'warning',
      label: `${c.label}: ${decisionVerb(c.decision)}`,
      detail: `${money(c.point)} booked · band ±${money(est.carriers[c.key].halfBand)} · CV ${(c.cv * 100).toFixed(1)}% vs ${(maxCv * 100)}% limit`,
      dollar: c.point,
    })),
    ...exceptions.filter((x) => x.severity === 'critical').map((x) => ({
      kind: 'exception', severity: 'critical',
      label: `${(x.type || '').replace(/_/g, ' ')}: ${x.shipmentId || ''}`,
      detail: x.message + (x.carrier ? ` · ${x.carrier}` : ''),
      dollar: x.dollarImpact,
    })),
  ];

  const adjustment = round2(portfolio.point - portfolio.contractual);
  const posture = {
    deterministic: portfolio.contractual,        // [D] pure rule-based contract math
    realizationAdjustment: adjustment,           // [A] learned factor + ensemble blend
    autoPostShare: round2(dispositions.auto_post / carriers.length),
    escalations: dispositions.escalate,
    reviews: dispositions.review,
  };

  // ══ EXECUTION PLANE ═════════════════════════════════════════════════
  // Do the work: DATA -> PROCESSING -> OUTCOME. Each stage carries its own
  // determinism tag so the overseer can see exactly where rules end and
  // statistical judgment begins.
  const pipeline = {
    data: {
      tag: 'D', title: 'Data', subtitle: 'Ingest & normalize',
      stat: `${shipments.length}`, statLabel: 'shipments priced',
      items: [
        `${shipments.length} shipments parsed & normalized`,
        `${dq.duplicate || 0} duplicate removed · ${dq.weight_estimated || 0} weights inferred`,
        `${invoices.length} historical invoices for calibration`,
      ],
    },
    processing: {
      tag: 'D→A', title: 'Processing', subtitle: 'Price · calibrate · estimate',
      stat: `${money(portfolio.contractual)}`, statLabel: 'contract baseline [D]',
      items: [
        `Deterministic rate engine prices every lane from the contract`,
        `Realization factor learned from ${calibration.peak.months}+ months of actuals [A]`,
        `Regime-aware ensemble blends engine vs trailing baseline [A]`,
      ],
    },
    outcome: {
      tag: 'gate', title: 'Outcome', subtitle: 'Book & gate',
      stat: `${money(portfolio.point)}`, statLabel: 'booked accrual',
      items: [
        `Balanced JE staged: ${je.lines.length} lines`,
        `${dispositions.auto_post} auto-post · ${dispositions.review} review · ${dispositions.escalate} escalate`,
        `${exceptions.length} exceptions raised for the overseer`,
      ],
    },
  };

  // ══ RECURSIVE IMPROVEMENT PLANE ═════════════════════════════════════
  // LEARN. Forward replay with no look-ahead: reconcile booked vs actual,
  // regrade the factor and baseline, feed the result back into policy.
  const learning = forwardLearn();
  learning.proposals = buildProposals(learning, calibration, carriers);

  // ══ EVENT LEDGER ════════════════════════════════════════════════════
  // Immutable system-of-record. Every material thing the OS did this cycle,
  // tagged by plane. This is the spine the three planes hang from.
  const events = buildEventLedger({ shipments, invoices, dq, carriers, calibration, dispositions, exceptions, je, learning, portfolio });

  return {
    period,
    generatedAt: new Date().toISOString(),
    ingestion: {
      shipments: shipments.length,
      invoicesAnalyzed: invoices.length,
      dataQuality,
      dataQualitySummary: dq,
    },
    carriers,
    portfolio,
    calibration,
    exceptions,
    exceptionSummary,
    je,
    lines: accrual.lines,
    materialityThreshold, maxCv,
    // plane structures
    control: { dispositions, gateMatrix, overseerQueue, posture },
    pipeline,
    learning,
    events,
    estDetail: est.carriers,
  };
}

const money = (n) => (n == null ? '--' : '$' + Math.round(n).toLocaleString('en-US'));
function decisionVerb(d) { return d === 'escalate' ? 'escalate to overseer' : d === 'review' ? 'flag for review' : 'auto-post'; }

// Improvement-plane proposals: concrete, data-driven next actions the loop surfaces.
function buildProposals(learning, calibration, carriers) {
  const out = [];
  // 1. widest-error carrier from the backtest
  let worst = null;
  for (const c of ['peak', 'heartland', 'coastal']) {
    const m = learning.maeByCarrier[c];
    if (!worst || m.engine > worst.mae) worst = { carrier: c, mae: m.engine, vsDenise: m.denise };
  }
  if (worst) out.push({
    severity: worst.mae > worst.vsDenise ? 'warning' : 'info',
    title: `Tighten ${worst.carrier} calibration`,
    detail: `Forward MAE ${money(worst.mae)} (Denise ${money(worst.vsDenise)}). Add promo-month flag to the realization factor so discount cycles stop widening the band.`,
  });
  // 2. high-spread carrier -> more history
  for (const c of carriers) {
    if (c.factorSpread > 0.16) {
      out.push({
        severity: 'info',
        title: `Collect more ${c.key} history`,
        detail: `Factor spread ${c.factorSpread.toFixed(3)} keeps the band wide. ${calibration[c.key].months} months observed; target 12+ to halve the interval.`,
      });
      break;
    }
  }
  // 3. coverage health
  out.push({
    severity: learning.coverage.pct >= 90 ? 'good' : 'warning',
    title: `Band coverage ${learning.coverage.pct}%`,
    detail: learning.coverage.pct >= 90
      ? `Calibrated: ${learning.coverage.hits}/${learning.coverage.total} actuals landed inside the 90% band. No action.`
      : `Under target. Re-fit spread on the last ${learning.monthsReplayed} cycles.`,
  });
  return out;
}

// Synthesize the ordered event ledger for this run, tagged by plane.
function buildEventLedger({ shipments, invoices, dq, carriers, calibration, dispositions, exceptions, je, learning, portfolio }) {
  const ev = [];
  let seq = 0;
  const push = (plane, tag, type, message) => ev.push({ seq: ++seq, plane, tag, type, message });

  push('execution', 'D', 'INGEST', `${shipments.length} shipments ingested and normalized`);
  if (dq.duplicate) push('execution', 'D', 'DEDUPE', `${dq.duplicate} duplicate shipment removed`);
  if (dq.weight_estimated) push('execution', 'D', 'IMPUTE', `${dq.weight_estimated} missing weights inferred from unit medians`);
  push('execution', 'D', 'PRICE', `Deterministic engine priced ${carriers.reduce((s, c) => s + c.shipmentCount, 0)} lanes from contract`);
  push('improvement', 'A', 'CALIBRATE', `Realization factors learned: Peak ${calibration.peak.factor}, Heartland ${calibration.heartland.factor}, Coastal ${calibration.coastal.factor}`);
  for (const c of carriers) {
    if (c.mixShift > 0.01) push('execution', 'A', 'REGIME', `${c.label}: volume/mix shift detected (engine weight lifted to ${Math.round(c.engineWeight * 100)}%)`);
  }
  push('execution', 'A', 'ESTIMATE', `Ensemble booked ${money(portfolio.point)} with 90% band`);
  for (const c of carriers) push('control', 'gate', c.decision.toUpperCase(), `${c.label} → ${decisionVerb(c.decision)} (${money(c.point)})`);
  for (const x of exceptions.filter((e) => e.severity === 'critical')) push('control', 'gate', 'EXCEPTION', `Critical: ${x.message} (${x.shipmentId || ''})`);
  push('execution', 'ledger', 'STAGE_JE', `Balanced journal entry staged: ${money(je.total)} to 2150 Accrued Freight`);
  push('improvement', 'A', 'RECONCILE', `Forward replay scored ${learning.monthsReplayed} cycles · ${learning.coverage.pct}% band coverage`);
  return ev.reverse(); // newest first
}

function summarize(arr, key) {
  const o = {};
  for (const x of arr) o[x[key]] = (o[x[key]] || 0) + 1;
  return o;
}
function monthEnd(period) {
  const [m, y] = period.split(' ');
  const idx = MONTHS.indexOf(m);
  const last = new Date(parseInt(y, 10), idx + 1, 0).getDate();
  return `${y}-${String(idx + 1).padStart(2, '0')}-${last}`;
}

module.exports = { runAccrual, CARRIER_META };
