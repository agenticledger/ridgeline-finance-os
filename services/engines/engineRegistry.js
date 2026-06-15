// Engine registry — DB-as-truth versioning + materialization for agent-editable
// engines (the methodology layer). See docs/plans/agent-editable-engine.md.
//
// An engineKey (e.g. "freight-accrual/estimate") maps to a file under
// services/engines/{engineKey}.js. The file on disk is a MATERIALIZED POINTER to the
// currently-active EngineVersion; the DB row holds the source of truth + history, so
// rollback re-materializes a prior body. The deterministic runner loads the active
// engine via loadActive(); editing never runs untrusted code in the critical path —
// candidates are backtested in a worker (see engineWorker.js) before activation.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Worker } = require('worker_threads');
const prisma = require('../db');

const ENGINES_DIR = __dirname;

function filePathFor(engineKey) {
  return path.join(ENGINES_DIR, ...engineKey.split('/')) + '.js';
}

// Hot path: load the active engine impl from its materialized file. Cached, with the
// cache invalidated whenever a version is activated or rolled back. Returns null if
// the file is missing or fails to load, so callers can fall back to a built-in.
const cache = new Map();
function loadActive(engineKey) {
  if (cache.has(engineKey)) return cache.get(engineKey);
  let impl = null;
  const fp = filePathFor(engineKey);
  try {
    if (fs.existsSync(fp)) {
      delete require.cache[require.resolve(fp)];
      impl = require(fp);
    }
  } catch (e) {
    impl = null;
  }
  cache.set(engineKey, impl);
  return impl;
}

function invalidate(engineKey) {
  cache.delete(engineKey);
  const fp = filePathFor(engineKey);
  try { delete require.cache[require.resolve(fp)]; } catch (e) { /* not loaded */ }
}

async function materialize(engineKey, body) {
  const fp = filePathFor(engineKey);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await fsp.writeFile(fp, body, 'utf8');
  invalidate(engineKey);
}

async function listVersions(engineKey) {
  return prisma.engineVersion.findMany({
    where: { engineKey },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, status: true, language: true, rationale: true, backtest: true, authoredBy: true, approvedBy: true, approvedAt: true, createdAt: true },
  });
}

async function getVersion(engineKey, version) {
  return prisma.engineVersion.findUnique({ where: { engineKey_version: { engineKey, version } } });
}

async function getActiveVersion(engineKey) {
  return prisma.engineVersion.findFirst({ where: { engineKey, status: 'active' }, orderBy: { version: 'desc' } });
}

async function nextVersionNumber(engineKey) {
  const top = await prisma.engineVersion.findFirst({ where: { engineKey }, orderBy: { version: 'desc' }, select: { version: true } });
  return (top ? top.version : 0) + 1;
}

// Seed v1 from the canonical on-disk file as the ACTIVE version. Idempotent: does
// nothing if any version already exists. This binds the validated freight estimate
// methodology to the registry without changing a single number.
async function seedFromFile(engineKey, { authoredBy = 'system (seed)' } = {}) {
  const existing = await prisma.engineVersion.findFirst({ where: { engineKey } });
  if (existing) return { seeded: false, reason: 'versions already exist' };
  const fp = filePathFor(engineKey);
  if (!fs.existsSync(fp)) throw new Error(`Canonical engine file not found: ${fp}`);
  const body = await fsp.readFile(fp, 'utf8');
  const row = await prisma.engineVersion.create({
    data: {
      engineKey, version: 1, language: 'js', body, status: 'active',
      rationale: 'Seeded from the validated in-repo methodology.',
      authoredBy, approvedBy: authoredBy, approvedAt: new Date(),
    },
  });
  return { seeded: true, version: row.version };
}

// Write a new DRAFT version (not live). Returns the new version row.
async function createDraft(engineKey, { body, rationale = '', authoredBy = 'Owner Agent', language = 'js' }) {
  if (!body || !body.trim()) throw new Error('Engine body is required.');
  const version = await nextVersionNumber(engineKey);
  return prisma.engineVersion.create({
    data: { engineKey, version, language, body, status: 'draft', rationale, authoredBy },
  });
}

async function recordBacktest(engineKey, version, backtest) {
  return prisma.engineVersion.update({ where: { engineKey_version: { engineKey, version } }, data: { backtest } });
}

// Score a candidate body in an isolated worker (untrusted code never touches the main
// process). Rejects if the worker errors or exceeds the timeout (runaway guard).
function backtestBody(body, { language = 'js', timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(ENGINES_DIR, 'engineWorker.js'), { workerData: { body, language } });
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(arg); };
    const timer = setTimeout(() => done(reject, new Error(`Backtest timed out after ${timeoutMs}ms (possible infinite loop in candidate).`)), timeoutMs);
    worker.on('message', (msg) => (msg && msg.ok ? done(resolve, msg.result) : done(reject, new Error((msg && msg.error) || 'Candidate backtest failed.'))));
    worker.on('error', (err) => done(reject, err));
    worker.on('exit', (code) => { if (code !== 0) done(reject, new Error(`Backtest worker exited with code ${code}.`)); });
  });
}

// Backtest a stored version by id/number (drafts or any version).
async function backtestVersion(engineKey, version, opts = {}) {
  const row = await getVersion(engineKey, version);
  if (!row) throw new Error(`Engine version ${engineKey} v${version} not found.`);
  const result = await backtestBody(row.body, { language: row.language, ...opts });
  await recordBacktest(engineKey, version, result);
  return result;
}

// Activate a version: materialize its body to the live file, flip statuses, record
// the approval. Caller is responsible for the gate (passing backtest + human ok).
async function activate(engineKey, version, { approvedBy = 'Owner Agent (on human instruction)' } = {}) {
  const target = await getVersion(engineKey, version);
  if (!target) throw new Error(`Engine version ${engineKey} v${version} not found.`);
  await prisma.engineVersion.updateMany({ where: { engineKey, status: 'active' }, data: { status: 'superseded' } });
  await prisma.engineVersion.update({
    where: { engineKey_version: { engineKey, version } },
    data: { status: 'active', approvedBy, approvedAt: new Date() },
  });
  await materialize(engineKey, target.body);
  return target;
}

// Roll back to a prior version by re-activating it (a forward operation; history is
// preserved). The previously-active version is marked rolled_back for clarity.
async function rollback(engineKey, version, { approvedBy = 'Owner Agent (on human instruction)' } = {}) {
  const current = await getActiveVersion(engineKey);
  const target = await activate(engineKey, version, { approvedBy });
  if (current && current.version !== version) {
    await prisma.engineVersion.update({ where: { id: current.id }, data: { status: 'rolled_back' } }).catch(() => {});
  }
  return target;
}

module.exports = {
  filePathFor, loadActive, invalidate, materialize,
  listVersions, getVersion, getActiveVersion, nextVersionNumber,
  seedFromFile, createDraft, recordBacktest, backtestBody, backtestVersion, activate, rollback,
};
