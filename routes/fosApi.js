// Finance OS REST API — JSON over every object. Mirrors the MCP tool surface so
// the Improve agent (and any external system) can drive the process. Expanded in
// Phase 7; this is the working core.

const express = require('express');
const prisma = require('../services/db');
const { executeRun, signOff, freezeRun, getRun, listRuns, PROCESS_SLUG } = require('../services/accrual/runService');
const { reconcileRun, getReconciliation } = require('../services/accrual/reconcileService');
const improve = require('../services/accrual/improveService');
const { listProcesses, createProcess } = require('../services/accrual/processService');
const cfg = require('../services/accrual/configService');
const supervisor = require('../services/accrual/supervisorService');
const { provisionOwnerAgent, backfillOwnerAgents } = require('../services/accrual/processAgentService');

const router = express.Router();
const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, e, code) => res.status(code || e.status || 500).json({ ok: false, error: e.message || String(e) });

// Health
router.get('/health', (req, res) => ok(res, { status: 'up', ts: new Date().toISOString() }));

// Process + its objects
router.get('/process/:slug', async (req, res) => {
  try {
    const process = await prisma.process.findFirst({
      where: { slug: req.params.slug },
      include: { org: true, legalEntity: true, steps: { orderBy: { order: 'asc' } }, policies: true, tools: { include: { tool: true } } },
    });
    if (!process) return fail(res, new Error('not found'), 404);
    ok(res, process);
  } catch (e) { fail(res, e); }
});

// Runs
router.get('/runs', async (req, res) => { try { ok(res, await listRuns(req.query.slug || PROCESS_SLUG)); } catch (e) { fail(res, e); } });
router.get('/run/:id', async (req, res) => { try { ok(res, await getRun(req.params.id)); } catch (e) { fail(res, e); } });
router.post('/run', async (req, res) => { try { ok(res, await executeRun({ period: req.body.period, mode: req.body.mode })); } catch (e) { fail(res, e); } });
router.post('/run/:id/signoff', async (req, res) => { try { ok(res, await signOff(req.params.id, req.body || {})); } catch (e) { fail(res, e); } });
router.post('/run/:id/freeze', async (req, res) => { try { ok(res, await freezeRun(req.params.id, req.body || {})); } catch (e) { fail(res, e); } });

// Improve plane — reconcile actuals, propose, apply (versioned), read versions
router.post('/run/:id/reconcile', async (req, res) => { try { ok(res, await reconcileRun(req.params.id, req.body || {})); } catch (e) { fail(res, e); } });
router.get('/run/:id/reconciliation', async (req, res) => { try { ok(res, await getReconciliation(req.params.id)); } catch (e) { fail(res, e); } });
router.get('/proposals', async (req, res) => { try { ok(res, await improve.listProposals(req.query.slug || PROCESS_SLUG, { runId: req.query.run || null })); } catch (e) { fail(res, e); } });
router.post('/proposals/generate', async (req, res) => { try { ok(res, await improve.generateProposals(req.body.slug || PROCESS_SLUG, { runId: req.body.run || null })); } catch (e) { fail(res, e); } });
router.post('/proposals/:id/apply', async (req, res) => { try { ok(res, await improve.applyProposal(req.params.id, req.body || {})); } catch (e) { fail(res, e); } });
router.get('/versions', async (req, res) => { try { ok(res, await improve.listVersions(req.query.slug || PROCESS_SLUG)); } catch (e) { fail(res, e); } });

// Policies (Improve target — params are versioned objects)
router.get('/policies', async (req, res) => {
  try {
    const process = await prisma.process.findFirst({ where: { slug: req.query.slug || PROCESS_SLUG } });
    ok(res, await prisma.policy.findMany({ where: { processId: process.id }, orderBy: { key: 'asc' } }));
  } catch (e) { fail(res, e); }
});

// ── Process Owner Agent — the supervisor that owns each process ───────────
// The owner agent for a process (so the UI can open a chat with it).
router.get('/process/:slug/agent', async (req, res) => {
  try {
    const process = await prisma.process.findFirst({
      where: { slug: req.params.slug },
      include: { ownerAgent: { select: { id: true, name: true, slug: true, description: true, defaultModel: true, features: true } } },
    });
    if (!process) return fail(res, new Error('process not found'), 404);
    ok(res, process.ownerAgent || null);
  } catch (e) { fail(res, e); }
});

// (Re)provision a process's owner agent.
router.post('/process/:slug/agent/provision', async (req, res) => {
  try {
    const process = await prisma.process.findFirst({ where: { slug: req.params.slug } });
    if (!process) return fail(res, new Error('process not found'), 404);
    ok(res, await provisionOwnerAgent(process.id, { regeneratePrompt: true }));
  } catch (e) { fail(res, e); }
});

// Provision/refresh owner agents across all processes.
router.post('/agents/backfill', async (req, res) => {
  try { ok(res, await backfillOwnerAgents({ refresh: req.body && req.body.refresh === true })); } catch (e) { fail(res, e); }
});

// Proactive supervision — run one tick (auto-run when due, nudge a stuck gate).
router.post('/supervisor/:slug/tick', async (req, res) => { try { ok(res, await supervisor.tick(req.params.slug)); } catch (e) { fail(res, e); } });
router.post('/supervisor/tick', async (req, res) => { try { ok(res, await supervisor.tickAll()); } catch (e) { fail(res, e); } });

// ── Configuration surface (construct-a-process) ───────────────────────────
// Every mutation a human can make on the Setup page, as JSON. This is what lets
// an agent (and the process automator) build a process end to end.

// Registry + taxonomy reads
router.get('/processes', async (req, res) => { try { ok(res, await listProcesses()); } catch (e) { fail(res, e); } });
router.get('/tools', async (req, res) => { try { ok(res, await cfg.listTools()); } catch (e) { fail(res, e); } });
router.get('/subfunctions', (req, res) => { try { ok(res, cfg.listSubfunctions()); } catch (e) { fail(res, e); } });

// Full config read for one process
router.get('/process/:slug/config', async (req, res) => { try { ok(res, await cfg.getProcessConfig(req.params.slug)); } catch (e) { fail(res, e); } });

// Create a process (template: 'blank' | 'clone')
router.post('/process', async (req, res) => {
  try { ok(res, await createProcess(req.body || {})); } catch (e) { fail(res, e, e.status || 400); }
});

// Definition + improve trigger
router.patch('/process/:slug', async (req, res) => { try { ok(res, await cfg.updateDefinition(req.params.slug, req.body || {})); } catch (e) { fail(res, e); } });
router.put('/process/:slug/improve', async (req, res) => { try { ok(res, await cfg.updateImproveTrigger(req.params.slug, req.body || {})); } catch (e) { fail(res, e); } });

// Steps
router.post('/process/:slug/steps', async (req, res) => { try { ok(res, await cfg.addStep(req.params.slug, req.body || {})); } catch (e) { fail(res, e); } });
router.patch('/process/:slug/steps/:stepId', async (req, res) => { try { ok(res, await cfg.updateStep(req.params.slug, req.params.stepId, req.body || {})); } catch (e) { fail(res, e); } });
router.delete('/process/:slug/steps/:stepId', async (req, res) => { try { ok(res, await cfg.deleteStep(req.params.slug, req.params.stepId)); } catch (e) { fail(res, e); } });

// Policies
router.post('/process/:slug/policies', async (req, res) => { try { ok(res, await cfg.addPolicy(req.params.slug, req.body || {})); } catch (e) { fail(res, e); } });
router.patch('/process/:slug/policies/:policyId', async (req, res) => { try { ok(res, await cfg.updatePolicy(req.params.slug, req.params.policyId, req.body || {})); } catch (e) { fail(res, e); } });
router.delete('/process/:slug/policies/:policyId', async (req, res) => { try { ok(res, await cfg.deletePolicy(req.params.slug, req.params.policyId)); } catch (e) { fail(res, e); } });

// Tool bindings
router.post('/process/:slug/tools', async (req, res) => { try { ok(res, await cfg.mapTool(req.params.slug, req.body || {})); } catch (e) { fail(res, e); } });
router.delete('/process/:slug/tools/:toolId', async (req, res) => { try { ok(res, await cfg.unmapTool(req.params.slug, req.params.toolId)); } catch (e) { fail(res, e); } });

// Step-tool bindings (attach a library tool to a single step / detach it)
router.post('/process/:slug/steps/:stepId/tools', async (req, res) => { try { ok(res, await cfg.attachStepTool(req.params.slug, req.params.stepId, req.body || {})); } catch (e) { fail(res, e); } });
router.delete('/process/:slug/steps/:stepId/tools/:stepToolId', async (req, res) => { try { ok(res, await cfg.detachStepTool(req.params.slug, req.params.stepToolId)); } catch (e) { fail(res, e); } });

module.exports = router;
