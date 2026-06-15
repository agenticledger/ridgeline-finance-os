// CANONICAL EDITABLE ENGINE — freight-accrual / estimate (the methodology).
//
// This is the calculation methodology the Owner Agent edits. It is a SELF-CONTAINED
// pure module (no external requires) so a candidate version can be backtested in an
// isolated worker before it is ever allowed to post a real number. The runner loads
// the ACTIVE version of this file via services/engines/engineRegistry; running stays
// deterministic. Every edit is a new EngineVersion (DB-as-truth) — see the plan at
// docs/plans/agent-editable-engine.md.
//
// Contract:  estimateAccrual(accrual, calibration, opts) -> { carriers, portfolio }
//   accrual      = { byCarrier: { peak|heartland|coastal: { total } }, total }
//   calibration  = { peak|heartland|coastal: { factor, spread, months, contractualMean, contractualSd } }
//   opts         = { baselines, bandZ, mixShiftZ, materialityThreshold, maxCv }
//
// Point estimate = contractual x carrier realization factor, blended with a trailing
// baseline by inverse-variance weight (lifted by any detected mix shift). Confidence
// band = ±z * spread * contractual. Decision gate = materiality x confidence.

const round2 = (n) => (n == null ? n : Math.round(n * 100) / 100);

const Z_90 = 1.645; // 90% two-sided interval

function estimateCarrier(contractual, cal, bandZ = Z_90) {
  const factor = cal && cal.factor ? cal.factor : 1;
  const spread = Math.max(cal && cal.spread != null ? cal.spread : 0.12, 0.04);
  const months = cal && cal.months ? cal.months : 0;
  const point = round2(contractual * factor);
  const halfBand = round2(bandZ * spread * contractual);
  return {
    contractual: round2(contractual),
    factor,
    spread,
    point,
    low: round2(point - halfBand),
    high: round2(point + halfBand),
    halfBand,
    months,
  };
}

function gate(est, { materialityThreshold = 1500, maxCv = 0.15 } = {}) {
  const cv = est.point ? est.halfBand / est.point : 0;
  const material = est.halfBand > materialityThreshold;
  const confident = cv <= maxCv;
  let decision;
  if (confident && !material) decision = 'auto_post';
  else if (!confident && material) decision = 'escalate';
  else decision = 'review';
  return { cv: round2(cv), material, confident, decision };
}

function engineWeight(factorSpread, actualVolatility) {
  const ve = (factorSpread != null ? factorSpread : 0.12) ** 2;
  const vt = (actualVolatility != null ? actualVolatility : 0.10) ** 2;
  if (ve + vt === 0) return 0.5;
  const w = vt / (ve + vt);
  return Math.max(0.1, Math.min(0.9, w));
}

function mixShiftStrength(contractual, cal, mixShiftZ = 1) {
  if (!cal || !cal.contractualSd) return 0;
  const z = Math.abs((contractual - cal.contractualMean) / cal.contractualSd);
  return Math.max(0, Math.min(0.9, (z - mixShiftZ) / 2));
}

function blend(est, baseline, cal, mixShiftZ = 1) {
  if (!baseline || baseline.trailing == null) return { ...est, blended: est.point, engineWeight: 1 };
  const wInvVar = engineWeight(est.spread, baseline.volatility);
  const mix = mixShiftStrength(est.contractual, cal, mixShiftZ);
  const w = Math.max(wInvVar, mix);
  const blended = round2(w * est.point + (1 - w) * baseline.trailing);
  const shift = round2(blended - est.point);
  return {
    ...est,
    blended,
    engineWeight: Math.round(w * 100) / 100,
    invVarWeight: Math.round(wInvVar * 100) / 100,
    mixShift: Math.round(mix * 100) / 100,
    baseline: round2(baseline.trailing),
    low: round2(est.low + shift),
    high: round2(est.high + shift),
  };
}

function estimateAccrual(accrual, calibration, opts = {}) {
  const { baselines = {}, bandZ = Z_90, mixShiftZ = 1 } = opts;
  const carriers = {};
  let point = 0; let low = 0; let high = 0;
  for (const c of ['peak', 'heartland', 'coastal']) {
    const sub = accrual.byCarrier[c];
    let est = estimateCarrier(sub ? sub.total : 0, calibration[c], bandZ);
    est = blend(est, baselines[c], calibration[c], mixShiftZ);
    est.point = est.blended;
    est.decision = gate(est, opts);
    carriers[c] = est;
    point += est.point; low += est.low; high += est.high;
  }
  const portfolio = {
    contractual: round2(accrual.total),
    point: round2(point),
    low: round2(low),
    high: round2(high),
  };
  portfolio.decision = gate(
    { point: portfolio.point, halfBand: round2((portfolio.high - portfolio.low) / 2) },
    opts,
  );
  return { carriers, portfolio };
}

module.exports = { estimateCarrier, estimateAccrual, gate, blend, engineWeight, mixShiftStrength, Z_90 };
