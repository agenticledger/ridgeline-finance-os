// Estimation + confidence layer [A]. Takes the deterministic accrual (contract
// math) and the learned calibration, and produces the number Finance actually
// books: a point estimate, a confidence interval, and a management-by-exception
// decision (auto-post vs escalate to the human overseer).
//
// Point estimate   = contractual x carrier realization factor
// Confidence band   = ±z * spread * contractual  (spread = stdev of the ratio)
// Decision gate      = materiality (band width vs threshold) x confidence (cv)

const { round2 } = require('./rateEngine');

const Z_90 = 1.645; // 90% two-sided interval

// Per-carrier estimate from the deterministic subtotal + calibration row.
// The realization factor is a COMMON monthly shock (one rate environment per month),
// so its uncertainty does NOT diversify away across shipments. The band therefore
// uses the month-to-month factor volatility (cal.spread) directly — this is the real
// uncertainty in the booked monthly number. (A small floor avoids an over-tight band
// when only a couple of months of history exist.)
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

// Gate a single estimate: how confident are we, and is the uncertainty material?
// materialityThreshold = dollars of band half-width above which a human looks.
function gate(est, { materialityThreshold = 1500, maxCv = 0.15 } = {}) {
  const cv = est.point ? est.halfBand / est.point : 0; // relative uncertainty
  const material = est.halfBand > materialityThreshold;
  const confident = cv <= maxCv;
  let decision;
  if (confident && !material) decision = 'auto_post';
  else if (!confident && material) decision = 'escalate';
  else decision = 'review';
  return { cv: round2(cv), material, confident, decision };
}

// Inverse-variance ensemble weight for the bottom-up engine vs a trailing baseline.
// Both estimators are ~unbiased; the optimal linear combination weights each by the
// inverse of its variance. The engine's relative variance is the calibration spread
// (carrier rate drift); the trailing baseline's is the carrier's month-to-month
// actual volatility. A carrier whose rates drift little (e.g. Heartland flat zones)
// trusts the engine; a promo-shock-prone carrier (e.g. Coastal) leans on the baseline.
function engineWeight(factorSpread, actualVolatility) {
  const ve = (factorSpread != null ? factorSpread : 0.12) ** 2;
  const vt = (actualVolatility != null ? actualVolatility : 0.10) ** 2;
  if (ve + vt === 0) return 0.5;
  const w = vt / (ve + vt);
  return Math.max(0.1, Math.min(0.9, w)); // never fully trust one estimator
}

// Mix-shift detector. If THIS month's bottom-up contractual sits far outside the
// historical contractual range, the deviation is a real volume/mix change (new lanes,
// heavier freight) that the engine has correctly priced — NOT rate noise to dampen.
// Returns a 0..0.9 strength that pulls the blend back toward the engine.
function mixShiftStrength(contractual, cal, mixShiftZ = 1) {
  if (!cal || !cal.contractualSd) return 0;
  const z = Math.abs((contractual - cal.contractualMean) / cal.contractualSd);
  return Math.max(0, Math.min(0.9, (z - mixShiftZ) / 2)); // z<=mixShiftZ normal; further out ⇒ trust the engine
}

// Blend the engine point estimate with a trailing baseline (Denise-style anchor).
// The blend dampens exogenous RATE drift (which mean-reverts) but must not erase a
// genuine volume/mix shift — so the engine weight is the inverse-variance weight
// lifted by any detected mix shift. The confidence band travels with the estimate.
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

// Apply calibration across a full deterministic accrual result (from compute.js).
// baselines (optional): { peak: { trailing, volatility }, ... } enables the ensemble.
function estimateAccrual(accrual, calibration, opts = {}) {
  const { baselines = {}, bandZ = Z_90, mixShiftZ = 1 } = opts;
  const carriers = {};
  let point = 0; let low = 0; let high = 0;
  for (const c of ['peak', 'heartland', 'coastal']) {
    const sub = accrual.byCarrier[c];
    let est = estimateCarrier(sub ? sub.total : 0, calibration[c], bandZ);
    est = blend(est, baselines[c], calibration[c], mixShiftZ);
    est.point = est.blended; // booked number = ensemble estimate
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

module.exports = { estimateCarrier, estimateAccrual, gate, blend, engineWeight, Z_90 };
