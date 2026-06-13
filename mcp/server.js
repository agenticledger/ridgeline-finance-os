#!/usr/bin/env node
// Ridgeline Finance OS — MCP server.
//
// Exposes the freight-accrual process as reusable Model Context Protocol tools so
// any agent (Claude Desktop, the Improve agent, an external close orchestrator) can
// drive the loop: estimate, run, inspect, sign off, freeze, reconcile, and read/tune
// the versioned policy params.
//
// Two layers of tools:
//   * Deterministic, no-DB:  freight_estimate, freight_price_shipment — run the
//     validated engine live from the data files. Safe, side-effect free, fast.
//   * Stateful, DB-backed:   freight_run_accrual, freight_get_run, freight_list_runs,
//     freight_sign_off, freight_freeze_run, freight_reconcile, freight_get_policies,
//     freight_set_policy — create and advance persisted runs, the system of record.
//
// Transport: stdio. Start with `node mcp/server.js` or `npm run mcp`.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { runAccrual } = require('../services/accrual/accrualService');
const { computeAccrual } = require('../services/accrual/compute');
const { normalizeCarrier } = require('../services/accrual/normalize');
const {
  executeRun, signOff, freezeRun, getRun, listRuns, loadProcessContext, PROCESS_SLUG,
} = require('../services/accrual/runService');
const { reconcileRun, getReconciliation } = require('../services/accrual/reconcileService');
const improve = require('../services/accrual/improveService');
const { listProcesses, createProcess } = require('../services/accrual/processService');
const cfg = require('../services/accrual/configService');
const supervisor = require('../services/accrual/supervisorService');
const { provisionOwnerAgent } = require('../services/accrual/processAgentService');
const prisma = require('../services/db');

const round2 = (n) => Math.round(n * 100) / 100;
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e.message || String(e)}` }] });

const server = new McpServer({
  name: 'ridgeline-finance-os',
  version: '1.0.0',
});

// ── 1. Estimate (deterministic, no DB) ────────────────────────────────────────
server.registerTool(
  'freight_estimate',
  {
    title: 'Estimate freight accrual',
    description:
      'Run the deterministic freight-accrual engine live from the data files and return the point estimate, 90% confidence band, per-carrier breakdown, calibration factors, and the side-by-side vs Denise\'s trailing-3-month average. Side-effect free: does NOT persist a run. Use this to preview a number before committing it.',
    inputSchema: {
      period: z.string().default('April 2026').describe('Accrual period, e.g. "April 2026".'),
      materialityThreshold: z.number().default(1500).describe('Dollar materiality used by the gate (policy default 1500).'),
      maxCv: z.number().default(0.15).describe('Max coefficient of variation before a carrier escalates (policy default 0.15).'),
    },
  },
  async ({ period, materialityThreshold, maxCv }) => {
    try {
      const r = runAccrual({ period, materialityThreshold, maxCv });
      return text({
        period,
        point: r.portfolio.point,
        band90: { low: r.portfolio.low, high: r.portfolio.high },
        denise: r.portfolio.denise,
        vsDenise: r.portfolio.vsDenise,
        contractual: r.portfolio.contractual,
        carriers: r.carriers.map((c) => ({
          carrier: c.key, label: c.label, contractual: c.contractual, factor: c.factor,
          point: c.point, low: c.low, high: c.high, cv: c.cv, decision: c.decision, vsDenise: c.vsDenise,
        })),
        calibration: {
          peak: r.calibration.peak.factor, heartland: r.calibration.heartland.factor, coastal: r.calibration.coastal.factor,
        },
        dispositions: r.control.dispositions,
        exceptions: r.exceptionSummary,
        je: r.je,
      });
    } catch (e) { return fail(e); }
  },
);

// ── 2. Price a single shipment (deterministic, no DB) ─────────────────────────
server.registerTool(
  'freight_price_shipment',
  {
    title: 'Price a single shipment',
    description:
      'Deterministically price one shipment against the correct carrier rate card (Peak per-mile, Heartland zone flat, Coastal per-pound), including fuel, accessorials, floors, and residential surcharge. Returns the full charge breakdown. Useful for spot-checks and "why is this number what it is" audits.',
    inputSchema: {
      carrier: z.string().describe('Carrier name (peak / heartland / coastal, or a messy variant).'),
      destination_zip: z.string().describe('Destination ZIP code (drives zone/region/lane).'),
      destination_city: z.string().optional().describe('Destination city (Peak mileage lookup).'),
      weight_lbs: z.number().describe('Billable weight in pounds.'),
      residential: z.boolean().default(false).describe('Residential delivery flag.'),
      special_handling: z.string().optional().describe('Accessorials, e.g. "liftgate", "inside", "appointment".'),
    },
  },
  async (s) => {
    try {
      const carrier = normalizeCarrier(s.carrier);
      if (!carrier) return text({ note: `Unrecognized carrier "${s.carrier}". Expected Peak / Heartland / Coastal.` });
      const ship = {
        shipmentId: 'AD-HOC', date: '2026-04-15',
        originCity: 'Denver', originState: 'CO',
        destCity: s.destination_city || null, destState: null, destZip: s.destination_zip || null,
        carrierRaw: s.carrier, carrier,
        serviceLevelRaw: null, serviceLevel: 'Standard',
        weightLbs: s.weight_lbs, weightEstimated: false, units: null,
        residential: !!s.residential, specialHandling: s.special_handling || null, period: 'April 2026',
      };
      const out = computeAccrual([ship]);
      const line = (out.lines && out.lines[0]) || null;
      if (!line) return text({ note: 'Could not price shipment — check destination/weight.', carrier, exceptions: out.exceptions });
      return text({
        shipmentId: line.shipmentId, carrier: line.carrier,
        base: round2(line.baseCharge || 0), fuel: round2(line.fuelSurcharge || 0),
        accessorials: round2(line.accessorialFees || 0), total: round2(line.total || 0),
        breakdown: line.breakdown || {}, flags: line.flags || [],
      });
    } catch (e) { return fail(e); }
  },
);

// ── 3. Run accrual (DB-backed, creates the system-of-record run) ──────────────
server.registerTool(
  'freight_run_accrual',
  {
    title: 'Run and persist a freight accrual',
    description:
      'Execute the full stepped accrual and persist it as the system-of-record run: ingest, price, calibrate, baseline, estimate, exceptions, materiality gate, staged JE, reconcile. The materiality gate sits BEFORE the JE post: if any carrier escalates the run pauses at awaiting_human with the JE staged (not posted) until a human signs off. Returns the runId and gate disposition.',
    inputSchema: {
      period: z.string().default('April 2026').describe('Accrual period.'),
      mode: z.enum(['manual', 'auto']).default('manual').describe('manual = overseer-triggered, auto = scheduled.'),
      actor: z.string().default('MCP Agent').describe('Who triggered the run (for the event ledger).'),
    },
  },
  async ({ period, mode, actor }) => {
    try { return text(await executeRun({ period, mode, actor })); } catch (e) { return fail(e); }
  },
);

// ── 4. List runs ──────────────────────────────────────────────────────────────
server.registerTool(
  'freight_list_runs',
  {
    title: 'List accrual runs',
    description: 'List all persisted freight-accrual runs (newest first) with status, period, total, and frozen flag.',
    inputSchema: { slug: z.string().default(PROCESS_SLUG).describe('Process slug.') },
  },
  async ({ slug }) => { try { return text(await listRuns(slug)); } catch (e) { return fail(e); } },
);

// ── 5. Get a run (full detail) ────────────────────────────────────────────────
server.registerTool(
  'freight_get_run',
  {
    title: 'Get a run',
    description: 'Fetch one persisted run in full: summary, per-carrier outcomes, step executions, exceptions, the event ledger, and the journal entry. This is the audit trail.',
    inputSchema: { runId: z.string().describe('Run id (uuid). Omit to get the latest.').optional() },
  },
  async ({ runId }) => {
    try {
      let id = runId;
      if (!id) { const runs = await listRuns(); if (!runs.length) return text({ note: 'No runs yet.' }); id = runs[0].id; }
      const run = await getRun(id);
      if (!run) return text({ note: 'Run not found.', runId: id });
      return text({
        id: run.id, period: run.period, status: run.status, mode: run.mode, frozen: run.frozen,
        totalAccrual: run.totalAccrual, summary: run.summary,
        steps: (run.steps || []).map((s) => ({ order: s.order, key: s.key, name: s.name, status: s.status, decisionType: s.decisionType })),
        exceptions: (run.exceptions || []).map((x) => ({ shipmentId: x.shipmentId, type: x.type, severity: x.severity, message: x.message })),
        events: (run.events || []).map((e) => ({ at: e.createdAt, actor: e.actor, action: e.action, detail: e.detail })),
      });
    } catch (e) { return fail(e); }
  },
);

// ── 6. Sign off (post the staged JE) ──────────────────────────────────────────
server.registerTool(
  'freight_sign_off',
  {
    title: 'Sign off and post the JE',
    description:
      'Human-in-the-loop approval. Advances a run that is awaiting_human or needs_review: posts the staged balanced journal entry (debit Freight Expense, credit Accrued Freight Liability) and records the sign-off on the event ledger. This is the "go on" gate.',
    inputSchema: {
      runId: z.string().describe('Run id to sign off.'),
      actor: z.string().default('Controller').describe('Approver name for the audit trail.'),
      note: z.string().default('').describe('Optional sign-off note.'),
    },
  },
  async ({ runId, actor, note }) => { try { return text(await signOff(runId, { actor, note })); } catch (e) { return fail(e); } },
);

// ── 7. Freeze a run (lock for period close) ───────────────────────────────────
server.registerTool(
  'freight_freeze_run',
  {
    title: 'Freeze a run for close',
    description: 'Lock a posted run immutable for period close. After freezing, it cannot be modified; a new run must be created to revise.',
    inputSchema: { runId: z.string().describe('Run id to freeze.'), actor: z.string().default('Controller') },
  },
  async ({ runId, actor }) => { try { return text(await freezeRun(runId, { actor })); } catch (e) { return fail(e); } },
);

// ── 8. Reconcile / backtest accuracy (Improve evidence) ───────────────────────
server.registerTool(
  'freight_reconcile',
  {
    title: 'Reconcile and backtest accuracy',
    description:
      'Run the forward-replay self-review: backtest this engine vs Denise\'s trailing-average over the historical months, report mean-absolute-error by carrier, 90% band coverage, and the improvement proposals. This is the evidence that the engine beats the baseline.',
    inputSchema: { period: z.string().default('April 2026') },
  },
  async ({ period }) => {
    try {
      const r = runAccrual({ period });
      return text({
        coverage: r.learning.coverage,
        monthsReplayed: r.learning.monthsReplayed,
        maeByCarrier: r.learning.maeByCarrier,
        proposals: r.learning.proposals,
      });
    } catch (e) { return fail(e); }
  },
);

// ── 9. Read policies (the Improve target) ─────────────────────────────────────
server.registerTool(
  'freight_get_policies',
  {
    title: 'Get versioned policies',
    description: 'Return the versioned policy objects that parameterize the process (materiality gate, baseline window, estimation method, calibration method, JE accounts, improve trigger). These params are what the Improve loop tunes; the algorithms stay in code.',
    inputSchema: { slug: z.string().default(PROCESS_SLUG) },
  },
  async ({ slug }) => {
    try {
      const process = await prisma.process.findFirst({ where: { slug } });
      if (!process) return text({ note: 'Process not seeded.' });
      const policies = await prisma.policy.findMany({ where: { processId: process.id }, orderBy: { key: 'asc' } });
      return text(policies.map((p) => ({ key: p.key, name: p.name, version: p.version, scope: p.scope, definition: p.definition, params: p.params })));
    } catch (e) { return fail(e); }
  },
);

// ── 10. Set a policy param (Improve action — new version) ──────────────────────
server.registerTool(
  'freight_set_policy',
  {
    title: 'Tune a policy param (new version)',
    description:
      'Apply an Improve proposal: update one or more params on a versioned policy, bumping its version. Changes affect FUTURE runs only (runs pin the version they used). Use to act on a reconciliation proposal, e.g. tighten the materiality threshold or change the baseline window.',
    inputSchema: {
      key: z.string().describe('Policy key, e.g. "materiality_gate", "baseline_window", "estimation_method".'),
      params: z.record(z.any()).describe('Param fields to merge into the policy, e.g. { "materialityThreshold": 1200 }.'),
      slug: z.string().default(PROCESS_SLUG),
      approvedBy: z.string().default('Controller').describe('Who approved the change.'),
    },
  },
  async ({ key, params, slug, approvedBy }) => {
    try {
      const process = await prisma.process.findFirst({ where: { slug } });
      if (!process) return text({ note: 'Process not seeded.' });
      const policy = await prisma.policy.findFirst({ where: { processId: process.id, key } });
      if (!policy) return text({ note: `Policy "${key}" not found.` });
      const before = policy.params || {};
      const after = { ...before, ...params };
      const updated = await prisma.policy.update({
        where: { id: policy.id },
        data: { params: after, version: policy.version + 1 },
      });
      // Record the version bump as an immutable ObjectVersion (audit of the Improve action).
      await prisma.objectVersion.create({
        data: {
          objectType: 'policy', objectId: policy.id, version: updated.version,
          diff: { before, after }, source: 'improve', approvedBy, approvedAt: new Date(),
        },
      }).catch(() => {});
      return text({ key, newVersion: updated.version, before, after, note: 'Applies to future runs only.' });
    } catch (e) { return fail(e); }
  },
);

// ── 10b. Reconcile a posted run against actuals (writes Reconciliation) ───────
server.registerTool(
  'freight_reconcile_run',
  {
    title: 'Reconcile a run against actuals',
    description:
      'Post-close reconciliation: compare a posted/frozen run\'s booked accrual to the real invoiced actuals, writing immutable per-carrier Reconciliation rows and a variance. If the portfolio variance breaches materiality, a true-up JE is staged. Actuals are resolved from the period\'s invoiced truth unless supplied. This is the real post-period half of the loop (freight_reconcile only replays history).',
    inputSchema: {
      runId: z.string().describe('The run to reconcile (must be posted or frozen).'),
      actuals: z.record(z.number()).optional().describe('Optional actuals by carrier, e.g. { "peak": 34216.86 }. Omit to use the period truth.'),
      actor: z.string().default('Reconciliation Agent'),
    },
  },
  async ({ runId, actuals, actor }) => {
    try { return text(await reconcileRun(runId, { actuals: actuals || null, actor })); }
    catch (e) { return fail(e); }
  },
);

// ── 10c. Generate improvement proposals (param-targeted) ──────────────────────
server.registerTool(
  'freight_propose',
  {
    title: 'Generate improvement proposals',
    description:
      'Run the self-review and persist concrete, param-targeted improvement proposals (e.g. widen band z, lower mix-shift z, extend baseline window). Each applyable proposal names the exact policy param it would change. Returns the proposals and band-coverage evidence.',
    inputSchema: { slug: z.string().default(PROCESS_SLUG), runId: z.string().optional() },
  },
  async ({ slug, runId }) => {
    try { return text(await improve.generateProposals(slug, { runId: runId || null })); }
    catch (e) { return fail(e); }
  },
);

// ── 10d. Apply a proposal → bump policy version + ObjectVersion ───────────────
server.registerTool(
  'freight_apply_proposal',
  {
    title: 'Apply an improvement proposal',
    description:
      'Approve and apply a param-targeted proposal: tunes the policy param, bumps the policy version, and writes an immutable ObjectVersion (before → after). Affects FUTURE runs only. Advisory (methodology) proposals cannot be auto-applied.',
    inputSchema: { proposalId: z.string(), approvedBy: z.string().default('Controller') },
  },
  async ({ proposalId, approvedBy }) => {
    try { return text(await improve.applyProposal(proposalId, { approvedBy })); }
    catch (e) { return fail(e); }
  },
);

// ── 10e. Read the policy version history (audit of Improve actions) ───────────
server.registerTool(
  'freight_list_versions',
  {
    title: 'List policy version history',
    description: 'Return the ObjectVersion audit trail for the process\'s policies — every Improve action that changed a param, with before → after diffs and who approved it.',
    inputSchema: { slug: z.string().default(PROCESS_SLUG) },
  },
  async ({ slug }) => {
    try { return text(await improve.listVersions(slug)); }
    catch (e) { return fail(e); }
  },
);

// ── 11–24. Process configuration (construct-a-process surface) ────────────────
// These let an agent define ANY process end to end — definition, steps, policies,
// tool bindings — the exact mutations a human makes on the Setup page. They share
// services/accrual/configService.js with the REST API and the UI forms.

server.registerTool(
  'process_list',
  {
    title: 'List processes',
    description: 'List every active process with its org, function, latest run status, and step/run counts. Use this to discover slugs before configuring.',
    inputSchema: {},
  },
  async () => { try { return text(await listProcesses()); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_get_config',
  {
    title: 'Get a process configuration',
    description: 'Read a process\'s full configuration: definition, ordered steps, policies, tool bindings, and improve trigger. Read this before editing so you have current step/policy ids.',
    inputSchema: { slug: z.string().describe('Process slug.') },
  },
  async ({ slug }) => { try { return text(await cfg.getProcessConfig(slug)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_list_tools',
  {
    title: 'List the tool registry',
    description: 'List the global tool registry (skills, agents, prompts, integrations) that processes can bind to steps. Returns tool ids needed for process_map_tool.',
    inputSchema: {},
  },
  async () => { try { return text(await cfg.listTools()); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_create',
  {
    title: 'Create a process',
    description: 'Create a new process from a blank starter (neutral 6-step checklist) or by cloning the freight blueprint. Returns the new slug. Follow up with process_update_definition / process_add_step / process_add_policy to flesh it out.',
    inputSchema: {
      name: z.string().describe('Process name.'),
      functionSlug: z.string().optional().describe('Sub-function slug to home it to (e.g. "gl-close").'),
      frequency: z.string().default('monthly').describe('Cadence.'),
      mode: z.enum(['auto', 'adhoc', 'manual']).default('manual'),
      description: z.string().optional(),
      template: z.enum(['blank', 'clone']).default('blank').describe('blank starter or clone the freight accrual shape.'),
    },
  },
  async (a) => { try { return text(await createProcess(a)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_update_definition',
  {
    title: 'Update process definition',
    description: 'Update a process\'s name, description, cadence, run mode, or sub-function. Any subset of fields.',
    inputSchema: {
      slug: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      frequency: z.string().optional(),
      mode: z.enum(['auto', 'adhoc', 'manual']).optional(),
      functionSlug: z.string().optional().describe('Sub-function slug; empty string clears it.'),
    },
  },
  async ({ slug, ...patch }) => { try { return text(await cfg.updateDefinition(slug, patch)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_set_improve_trigger',
  {
    title: 'Set the improvement trigger',
    description: 'Configure the improvement loop: auto vs manual, and how many prior runs it ingests.',
    inputSchema: {
      slug: z.string(),
      mode: z.enum(['auto', 'manual']).optional(),
      lookbackRuns: z.number().int().min(1).optional(),
    },
  },
  async ({ slug, ...patch }) => { try { return text(await cfg.updateImproveTrigger(slug, patch)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_add_step',
  {
    title: 'Add a step',
    description: 'Append a step to the process checklist. Returns the updated config so you can read the new step id.',
    inputSchema: {
      slug: z.string(),
      name: z.string().describe('Step name.'),
      description: z.string().optional(),
      decisionType: z.enum(['policy_based', 'judgment_based', 'mixed']).default('policy_based'),
      engineSource: z.string().optional().describe('Engine/service file that runs the step, if bound.'),
      toolId: z.string().optional().describe('Tool id to bind to the step.'),
      isGate: z.boolean().default(false).describe('Is this a materiality gate?'),
      pauseAfter: z.boolean().default(false).describe('Pause the run for a human after this step?'),
    },
  },
  async ({ slug, ...body }) => { try { return text(await cfg.addStep(slug, body)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_update_step',
  {
    title: 'Update a step',
    description: 'Edit a step (any subset of fields). Bumps the step version.',
    inputSchema: {
      slug: z.string(),
      stepId: z.string().describe('Step id (uuid) from process_get_config.'),
      name: z.string().optional(),
      description: z.string().optional(),
      decisionType: z.enum(['policy_based', 'judgment_based', 'mixed']).optional(),
      engineSource: z.string().optional(),
      toolId: z.string().optional(),
      isGate: z.boolean().optional(),
      pauseAfter: z.boolean().optional(),
    },
  },
  async ({ slug, stepId, ...body }) => { try { return text(await cfg.updateStep(slug, stepId, body)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_delete_step',
  {
    title: 'Delete a step',
    description: 'Remove a step from the process.',
    inputSchema: { slug: z.string(), stepId: z.string().describe('Step id (uuid).') },
  },
  async ({ slug, stepId }) => { try { return text(await cfg.deleteStep(slug, stepId)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_add_policy',
  {
    title: 'Add a policy',
    description: 'Add a policy to the process. params is a free-form typed object the engine reads (thresholds, account codes, windows).',
    inputSchema: {
      slug: z.string(),
      name: z.string().describe('Policy name.'),
      definition: z.string().optional().describe('Human-readable description.'),
      params: z.record(z.any()).optional().describe('Typed key/value params.'),
      scope: z.enum(['process', 'step']).default('process'),
    },
  },
  async ({ slug, ...body }) => { try { return text(await cfg.addPolicy(slug, body)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_update_policy',
  {
    title: 'Update a policy',
    description: 'Edit a policy\'s definition and/or params. Bumps the policy version. (For tuning freight policy params specifically, freight_set_policy also records an ObjectVersion audit.)',
    inputSchema: {
      slug: z.string(),
      policyId: z.string().describe('Policy id (uuid) from process_get_config.'),
      definition: z.string().optional(),
      params: z.record(z.any()).optional().describe('Replacement typed params object.'),
    },
  },
  async ({ slug, policyId, ...body }) => { try { return text(await cfg.updatePolicy(slug, policyId, body)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_delete_policy',
  {
    title: 'Delete a policy',
    description: 'Remove a policy from the process.',
    inputSchema: { slug: z.string(), policyId: z.string().describe('Policy id (uuid).') },
  },
  async ({ slug, policyId }) => { try { return text(await cfg.deletePolicy(slug, policyId)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_map_tool',
  {
    title: 'Bind a tool to a process',
    description: 'Map a registry tool to the process (idempotent). Use process_list_tools to get tool ids.',
    inputSchema: {
      slug: z.string(),
      toolId: z.string().describe('Tool id from the registry.'),
      role: z.string().optional().describe('Optional role label for the binding.'),
    },
  },
  async ({ slug, toolId, role }) => { try { return text(await cfg.mapTool(slug, { toolId, role })); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_unmap_tool',
  {
    title: 'Unbind a tool from a process',
    description: 'Remove a tool binding from the process.',
    inputSchema: { slug: z.string(), toolId: z.string().describe('Tool id (uuid).') },
  },
  async ({ slug, toolId }) => { try { return text(await cfg.unmapTool(slug, toolId)); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_attach_step_tool',
  {
    title: 'Attach a tool to a step',
    description: 'Attach a library tool to a single step. Use process_get_config for step ids and process_list_tools for tool ids. The binding is mirrored into the process-level tool map so the registry stays accurate.',
    inputSchema: {
      slug: z.string(),
      stepId: z.string().describe('Step id (uuid) from process_get_config.'),
      toolId: z.string().describe('Tool id from the registry.'),
      role: z.string().optional().describe('Optional role label, e.g. "engine" for the primary automation.'),
    },
  },
  async ({ slug, stepId, toolId, role }) => { try { return text(await cfg.attachStepTool(slug, stepId, { toolId, role })); } catch (e) { return fail(e); } },
);

server.registerTool(
  'process_detach_step_tool',
  {
    title: 'Detach a tool from a step',
    description: 'Detach a tool from a step using its StepTool join id (from process_get_config). The process-level tool map entry is removed only if no other step still uses that tool.',
    inputSchema: { slug: z.string(), stepToolId: z.string().describe('StepTool join id (uuid).') },
  },
  async ({ slug, stepToolId }) => { try { return text(await cfg.detachStepTool(slug, stepToolId)); } catch (e) { return fail(e); } },
);

// ── 31–33. Process Owner Agent & proactive supervision ───────────────────────
// Every process is owned by one supervisor agent (auto-provisioned on create).
// The agent is NOT in the critical path — it observes, explains, and can trigger
// or nudge. These tools let an external orchestrator read the owner agent and run
// supervision ticks (auto-run when due, nudge a stuck gate) on a schedule.

server.registerTool(
  'process_get_owner_agent',
  {
    title: 'Get a process owner agent',
    description: 'Get the Process Owner Agent (the supervisor) for a process: its id, name, and supervisor features. Every process is owned by exactly one such agent.',
    inputSchema: { slug: z.string().describe('Process slug.') },
  },
  async ({ slug }) => {
    try {
      const process = await prisma.process.findFirst({
        where: { slug },
        include: { ownerAgent: { select: { id: true, name: true, slug: true, description: true, defaultModel: true, features: true } } },
      });
      if (!process) return fail(new Error('process not found'));
      return text(process.ownerAgent || null);
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  'process_provision_owner_agent',
  {
    title: 'Provision a process owner agent',
    description: '(Re)provision the owner agent for a process, regenerating its supervisor system prompt from the current definition. Idempotent by agent slug.',
    inputSchema: { slug: z.string().describe('Process slug.') },
  },
  async ({ slug }) => {
    try {
      const process = await prisma.process.findFirst({ where: { slug } });
      if (!process) return fail(new Error('process not found'));
      return text(await provisionOwnerAgent(process.id, { regeneratePrompt: true }));
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  'process_supervise',
  {
    title: 'Run a supervision tick',
    description: 'Run one proactive supervision tick for a process: auto-run the target period if due (mode=auto, engine-bound, no run yet) and nudge a run stuck awaiting a human (throttled). Deterministic and idempotent-by-period — safe to call on a cron. Omit slug to tick every active process.',
    inputSchema: { slug: z.string().optional().describe('Process slug. Omit to tick all active processes.') },
  },
  async ({ slug }) => {
    try { return text(slug ? await supervisor.tick(slug) : await supervisor.tickAll()); }
    catch (e) { return fail(e); }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP channel.
  console.error('Ridgeline Finance OS MCP server running on stdio. 33 tools registered.');
}

main().catch((e) => { console.error('MCP fatal:', e); process.exit(1); });
