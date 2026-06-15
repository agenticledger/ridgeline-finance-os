// Worker entry — backtest a CANDIDATE engine body in isolation.
//
// A just-authored methodology edit is untrusted code. We never require() it into the
// main server to score it; instead we run it here in a worker_thread, write the body
// to a throwaway temp file, load it, and run the backtest harness against its
// estimateAccrual. A crash, infinite loop guard (caller timeout), or bad export stays
// contained in the worker and cannot take down the live process.

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

function main() {
  const { body, language = 'js' } = workerData || {};
  if (!body) throw new Error('No candidate body provided to worker.');
  if (language !== 'js') throw new Error(`Unsupported engine language for backtest: ${language}`);

  const tmpFile = path.join(os.tmpdir(), `engine-candidate-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, body, 'utf8');
  try {
    const candidate = require(tmpFile);
    if (!candidate || typeof candidate.estimateAccrual !== 'function') {
      throw new Error('Candidate must export an estimateAccrual(accrual, calibration, opts) function.');
    }
    const { runBacktest } = require('./backtestHarness');
    const result = runBacktest(candidate.estimateAccrual);
    parentPort.postMessage({ ok: true, result });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
  }
}

try {
  main();
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
