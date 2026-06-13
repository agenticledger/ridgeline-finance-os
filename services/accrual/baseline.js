// Trailing baseline [D] — the Denise-style anchor used by the ensemble. For each
// carrier it returns the trailing-N-month average of actual invoiced dollars and
// the relative month-to-month volatility of those actuals (used to weight the blend).
//
// reconciliations: chronological [{ carrier, actualInvoiced }] (oldest → newest),
// already filtered to the months PRIOR to the one being estimated (no look-ahead).

function trailingBaselines(reconciliationsByCarrier, { window = 3 } = {}) {
  const out = {};
  for (const c of ['peak', 'heartland', 'coastal']) {
    const series = (reconciliationsByCarrier[c] || []).map((r) => r.actualInvoiced).filter((x) => x != null);
    if (series.length === 0) { out[c] = { trailing: null, volatility: null, n: 0 }; continue; }
    const recent = series.slice(-window);
    const trailing = recent.reduce((s, x) => s + x, 0) / recent.length;
    // relative volatility across the full known series (coefficient of variation)
    const mean = series.reduce((s, x) => s + x, 0) / series.length;
    const variance = series.length > 1
      ? series.reduce((s, x) => s + (x - mean) ** 2, 0) / (series.length - 1)
      : 0;
    const volatility = mean ? Math.sqrt(variance) / mean : null;
    out[c] = { trailing: Math.round(trailing * 100) / 100, volatility, n: series.length };
  }
  return out;
}

module.exports = { trailingBaselines };
