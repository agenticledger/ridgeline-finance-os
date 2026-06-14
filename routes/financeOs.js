// Finance OS — operational surfaces (Monitor / Execute / Improve / Setup) and
// run actions, all driven by the persisted Process/Run/Step model.
//
// Routes:
//   GET  /                         -> latest run, Monitor
//   GET  /process/:slug            -> Monitor (default)
//   GET  /process/:slug/:tab       -> monitor | execute | improve | setup
//        ?run=<id>                 -> select a specific run
//   POST /process/:slug/run        -> execute a new run
//   POST /run/:runId/signoff       -> sign off (posts the JE, advances the run)
//   POST /run/:runId/freeze        -> freeze (period close)

const express = require('express');
const path = require('path');
const prisma = require('../services/db');
const { signOff, freezeRun, getRun, listRuns, listRunHistory, PROCESS_SLUG } = require('../services/accrual/runService');
const { runProcess } = require('../services/runner/processRunner');
const { buildOverview } = require('../services/runner/overviewBuilder');
const { generateInsight } = require('../services/runner/insightService');
const { reconcileRun } = require('../services/accrual/reconcileService');
const improve = require('../services/accrual/improveService');
const { listProcesses, SUBFUNCTIONS, SUBFUNCTION_SLUGS } = require('../services/accrual/processService');
const cfg = require('../services/accrual/configService');
const automator = require('../services/accrual/automatorService');
const { API_GROUPS, endpointCount } = require('../docs/catalog');
const { TOOL_GROUPS, toolCount } = require('../mcp/toolCatalog');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Build a copy-pasteable curl example for an endpoint (used by the API docs page).
function curlFor(e, baseUrl) {
  const p = e.path.replace(/:([A-Za-z0-9_]+)/g, (_, n) => `{${n}}`);
  const query = e.params.filter((x) => x.in === 'query');
  let url = baseUrl + p;
  if (query.length) url += '?' + query.map((x) => `${x.name}={${x.name}}`).join('&');
  const lines = [`curl -s -X ${e.method} ${url}`];
  if (e.auth === 'admin') lines.push(`  -H 'X-Admin-Key: <token>'`);
  if (e.body.length) {
    lines.push(`  -H 'Content-Type: application/json'`);
    const obj = {};
    for (const b of e.body) {
      obj[b.name] = b.type === 'string' ? '...'
        : b.type === 'boolean' ? false
        : (b.type === 'integer' || b.type === 'number') ? 0
        : b.type === 'array' ? [] : {};
    }
    lines.push(`  -d '${JSON.stringify(obj)}'`);
  }
  return lines.join(' \\\n');
}

const TOOL_TYPE_META = {
  automation: { label: 'Automation', blurb: 'A deterministic code engine that executes a step\u2019s logic.' },
  skill: { label: 'Skill', blurb: 'A reusable deterministic capability invoked by a step.' },
  agent: { label: 'Agent', blurb: 'An autonomous worker that owns or improves a process.' },
  prompt: { label: 'Prompt', blurb: 'A reusable prompt template invoked by a step or agent.' },
  mcp: { label: 'MCP', blurb: 'A system connector exposed over MCP.' },
};

const router = express.Router();
const TABS = ['monitor', 'execute', 'flow', 'improve', 'history', 'setup'];

async function loadProcessFull(slug) {
  return prisma.process.findFirst({
    where: { slug },
    include: {
      org: true,
      legalEntity: true,
      businessUnit: true,
      function: true,
      steps: { orderBy: { order: 'asc' }, include: { tool: true, stepTools: { include: { tool: true } } } },
      policies: { orderBy: { key: 'asc' }, include: { step: true } },
      tools: { include: { tool: true } },
    },
  });
}

async function buildView(req, res, slug, active) {
  const process = await loadProcessFull(slug);
  if (!process) return res.status(404).send('Process not found. Run: node prisma/seed.js');

  const runs = await listRuns(slug);
  const selectedId = req.query.run || (runs[0] && runs[0].id);
  const run = selectedId ? await getRun(selectedId) : null;
  const processes = await listProcesses();
  // Any process with steps can execute via the generic scaffold runner. Freight (and
  // any process whose steps carry an engineSource) is additionally "engine-bound".
  const runnable = Array.isArray(process.steps) && process.steps.length > 0;
  const engineBound = process.slug === PROCESS_SLUG
    || (process.steps || []).some((s) => s.engineSource);
  const SECTIONS = ['overview', 'steps'];
  const section = active === 'setup'
    ? (SECTIONS.includes(req.query.section) ? req.query.section : 'overview')
    : null;
  const allTools = active === 'setup'
    ? await prisma.tool.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] })
    : [];
  const orgUnits = active === 'setup' ? await cfg.listOrgUnits(slug) : [];
  // Improve plane: persisted proposals (scoped to the selected run) + version history.
  const proposals = active === 'improve' ? await improve.listProposals(slug, { runId: selectedId || null }) : [];
  const versions = active === 'improve' ? await improve.listVersions(slug) : [];
  // Run history: every run for this process with its headline numbers.
  const historyRuns = active === 'history' ? await listRunHistory(slug) : [];

  // The Process Owner Agent — the supervisor that watches this process. Surfaced
  // in the sub-header and the chat dock so the operator can talk to it live.
  let ownerAgent = null;
  try {
    if (process.agentId) {
      const a = await prisma.agent.findUnique({
        where: { id: process.agentId },
        select: { id: true, name: true, slug: true, description: true, defaultModel: true },
      });
      if (a) ownerAgent = a;
    }
  } catch (e) { /* non-fatal: dock just won't render */ }

  if (active === 'setup') {
    const allPolicies = process.policies || [];
    process.steps.forEach((s) => {
      s.tools = (s.stepTools || []).map((st) => ({
        stepToolId: st.id,
        toolId: st.toolId,
        role: st.role,
        name: st.tool.name,
        type: st.tool.type,
        slug: st.tool.slug,
        description: st.tool.description,
      }));
      s.policies = allPolicies
        .filter((p) => p.stepId === s.id)
        .map((p) => ({ id: p.id, name: p.name, version: p.version, definition: p.definition, params: p.params, key: p.key }));
    });
    // Process-scope policies = those not pinned to a step.
    process.policies = allPolicies.filter((p) => !p.stepId);
  }

  res.render('fos', {
    active,
    section,
    process,
    processes,
    runnable,
    engineBound,
    justRan: !!req.query.ran,
    runs,
    run,
    allTools,
    orgUnits,
    proposals,
    versions,
    historyRuns,
    ownerAgent,
    subfunctions: SUBFUNCTIONS,
    summary: run ? run.summary : null,
    overview: run ? buildOverview({ proc: process, run, summary: run.summary }) : null,
    pageTitle: `Ridgeline Finance OS — ${process.name} · ${active[0].toUpperCase() + active.slice(1)}`,
    pageDescription: `${process.name} — ${active}. Beats the trailing-3-month average with an auditable, gated accrual.`,
  });
}

router.get('/', (req, res, next) => buildView(req, res, PROCESS_SLUG, 'monitor').catch(next));

// Manual /process/new form was removed (decision §14.8). New processes are born
// agentically via the automator (the owner agent builds the package).

// Process automator — AI-built processes. Page + propose/apply JSON endpoints.
router.get('/automator', async (req, res, next) => {
  try {
    const processes = await listProcesses();
    const slug = req.query.slug || '';
    const target = slug ? processes.find((p) => p.slug === slug) || null : null;
    res.render('automator', {
      processes,
      targetSlug: target ? target.slug : '',
      targetName: target ? target.name : '',
      org: processes[0] ? processes[0].org : 'Ridgeline Foods, Inc.',
      pageTitle: 'Ridgeline Finance OS — Process Automator',
      pageDescription: 'Describe a finance process and let AI construct its definition, steps, policies, and tools.',
    });
  } catch (e) { next(e); }
});

router.post('/api/automator/propose', async (req, res) => {
  try {
    const out = await automator.propose({
      messages: Array.isArray(req.body.messages) ? req.body.messages : [],
      scope: req.body.scope || 'whole',
      attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
    });
    res.json({ ok: true, data: out });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message || String(e) }); }
});

router.post('/api/automator/apply', async (req, res) => {
  try {
    const out = await automator.apply({ blueprint: req.body.blueprint, slug: req.body.slug || null });
    res.json({ ok: true, data: out });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message || String(e) }); }
});

// Agents admin — the multiagent console. The page is a thin shell; all CRUD
// runs client-side against the existing /api/agents, /api/capabilities, and
// /api/chat JSON surface (admin token via /api/admin/login, X-Admin-Key header).
router.get('/agents', async (req, res, next) => {
  try {
    const processes = await listProcesses().catch(() => []);
    res.render('chat', {
      org: processes[0] ? processes[0].org : 'Ridgeline Foods, Inc.',
      pageTitle: 'Ridgeline Finance OS — Agents',
      pageDescription: 'Chat with the agents that own and improve finance processes — switch agents, ask about live process state, and trigger or sign off steps.',
    });
  } catch (e) { next(e); }
});

router.get('/process/:slug/:tab?', (req, res, next) => {
  const tab = TABS.includes(req.params.tab) ? req.params.tab : 'monitor';
  buildView(req, res, req.params.slug, tab).catch(next);
});

router.get('/processes', async (req, res, next) => {
  try {
    const processes = await listProcesses();
    res.render('processes', {
      processes,
      subfunctions: SUBFUNCTIONS,
      org: processes[0] ? processes[0].org : 'Ridgeline Foods',
      pageTitle: 'Ridgeline Finance OS — Command center',
      pageDescription: 'Every finance process running on the Ridgeline Finance OS model.',
    });
  } catch (e) { next(e); }
});

// Live Map — the same processes as /processes, rendered as a living org graph
// (Org → Sub-function → Process → owning Agents) with flowing particles on the
// spine. Pure SVG/CSS animation; no external libs. Toggle from the Command Center.
router.get('/processes/live', async (req, res, next) => {
  try {
    const ATTENTION = new Set(['awaiting_human', 'needs_review', 'blocked']);
    const POSTED = new Set(['approved', 'posted', 'reconciled']);
    const rank = { attention: 3, live: 2, posted: 1, idle: 0 };
    const rows = await prisma.process.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      include: {
        org: true,
        function: true,
        ownerAgent: true,
        runs: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, period: true } },
        _count: { select: { runs: true, steps: true } },
      },
    });
    const orgName = rows[0] && rows[0].org ? rows[0].org.name : 'Ridgeline Foods';
    const nodes = [];
    const edges = [];
    const ORG_ID = 'org';
    nodes.push({ id: ORG_ID, type: 'org', label: orgName, sublabel: `${rows.length} processes`, signal: 'idle', col: 0 });

    // Group processes by sub-function, preserving the canonical SUBFUNCTIONS order.
    const order = new Map(SUBFUNCTIONS.map((s, i) => [s.slug, i]));
    const byFn = new Map();
    rows.forEach((p) => {
      const slug = p.function ? p.function.slug : 'unassigned';
      if (!byFn.has(slug)) byFn.set(slug, { slug, name: p.function ? p.function.name : 'Unassigned', list: [] });
      byFn.get(slug).list.push(p);
    });
    const groups = [...byFn.values()].sort((a, b) => (order.has(a.slug) ? order.get(a.slug) : 99) - (order.has(b.slug) ? order.get(b.slug) : 99));

    // Architecture read: Org → Area (sub-function) → Process. The owning agent is
    // NOT a sibling here — it lives inside each process's schematic view.
    const nav = [];
    const laneCards = new Map(); // fn slug -> [{ ...process card }]
    groups.forEach((g) => {
      const fnId = `fn:${g.slug}`;
      let fnSignal = 'idle';
      const navProcs = [];
      g.list.forEach((p) => {
        const status = p.runs[0] ? p.runs[0].status : null;
        let signal = 'idle';
        if (status && ATTENTION.has(status)) signal = 'attention';
        else if (status === 'processing') signal = 'live';
        else if (status && POSTED.has(status)) signal = 'posted';
        if (rank[signal] > rank[fnSignal]) fnSignal = signal;

        const pid = `pr:${p.id}`;
        const card = {
          id: pid, label: p.name, slug: p.slug, signal,
          steps: p._count.steps, runs: p._count.runs,
          frequency: p.frequency, mode: p.mode,
          period: p.runs[0] ? p.runs[0].period : null,
        };
        nodes.push({ ...card, type: 'process', col: 2, sublabel: `${p._count.steps} steps · ${p._count.runs} runs`, fn: g.name, fnSlug: g.slug });
        edges.push({ from: fnId, to: pid, signal });
        navProcs.push({ slug: p.slug, name: p.name });
        if (!laneCards.has(g.slug)) laneCards.set(g.slug, []);
        laneCards.get(g.slug).push(card);
      });
      nodes.push({ id: fnId, type: 'function', label: g.name, slug: g.slug, signal: fnSignal, col: 1, sublabel: `${g.list.length} process${g.list.length === 1 ? '' : 'es'}` });
      edges.push({ from: ORG_ID, to: fnId, signal: fnSignal });
      nav.push({ slug: g.slug, name: g.name, processes: navProcs });
    });

    // Swimlanes: one per canonical sub-function (ALWAYS shown, even empty), then any
    // non-canonical buckets (e.g. Unassigned). Each lane carries its process cards.
    const laneFor = (slug, name, icon) => {
      const procs = laneCards.get(slug) || [];
      const signal = procs.reduce((acc, c) => (rank[c.signal] > rank[acc] ? c.signal : acc), 'idle');
      return { slug, name, icon: icon || null, signal, processes: procs };
    };
    const lanes = SUBFUNCTIONS.map((s) => laneFor(s.slug, s.name, s.icon));
    groups.filter((g) => !SUBFUNCTION_SLUGS.has(g.slug)).forEach((g) => lanes.push(laneFor(g.slug, g.name, null)));

    const counts = {
      total: rows.length,
      attention: nodes.filter((n) => n.type === 'process' && n.signal === 'attention').length,
      live: nodes.filter((n) => n.type === 'process' && n.signal === 'live').length,
      posted: nodes.filter((n) => n.type === 'process' && n.signal === 'posted').length,
    };

    res.render('processes-live', {
      graph: { nodes, edges, mode: 'overview', lanes },
      counts, nav, org: orgName, hud: null, current: null,
      pageTitle: 'Ridgeline Finance OS — Live Map',
      pageDescription: 'A living view of every finance process and the agents running them.',
    });
  } catch (e) { next(e); }
});

// Process schematic — the inside of one process: owner agent + ordered steps,
// each step's policies (left) and tools (right), typed by decision type, with the
// latest run's per-step status lighting the spine. Read-only architecture view.
router.get('/processes/live/:slug', async (req, res, next) => {
  try {
    const ATTENTION = new Set(['awaiting_human', 'needs_review', 'blocked']);
    const POSTED = new Set(['approved', 'posted', 'reconciled']);
    const p = await prisma.process.findFirst({
      where: { slug: req.params.slug, isActive: true },
      include: {
        org: true, businessUnit: true, function: true, ownerAgent: true,
        steps: {
          orderBy: { order: 'asc' },
          include: { tool: true, stepTools: { include: { tool: true } }, policies: true },
        },
        policies: true,
        tools: { include: { tool: true } },
        runs: { orderBy: { createdAt: 'desc' }, take: 1, include: { steps: true } },
      },
    });
    if (!p) return res.redirect('/processes/live');

    const orgName = p.org ? p.org.name : 'Ridgeline Foods';
    const lastRun = p.runs[0] || null;
    const runStatus = lastRun ? lastRun.status : null;
    let procSignal = 'idle';
    if (runStatus && ATTENTION.has(runStatus)) procSignal = 'attention';
    else if (runStatus === 'processing') procSignal = 'live';
    else if (runStatus && POSTED.has(runStatus)) procSignal = 'posted';

    // Map latest run's StepExecutions onto step status by stepId, falling back to key/order.
    const execByStep = new Map();
    const execByKey = new Map();
    (lastRun ? lastRun.steps : []).forEach((se) => {
      if (se.stepId) execByStep.set(se.stepId, se);
      if (se.key) execByKey.set(se.key, se);
    });
    const STEP_SIG = { done: 'posted', running: 'live', awaiting_human: 'attention', error: 'attention', skipped: 'idle', pending: 'idle' };

    const nodes = [];
    const edges = [];
    const AGENT_ID = 'agent';
    nodes.push({
      id: AGENT_ID, type: 'agent',
      label: p.ownerAgent ? p.ownerAgent.name : 'Owner Agent',
      slug: p.ownerAgent ? p.ownerAgent.slug : null,
      sublabel: 'supervisor · not in critical path', signal: procSignal,
    });

    let prevSpineId = AGENT_ID;
    p.steps.forEach((s) => {
      const exec = execByStep.get(s.id) || execByKey.get(s.key) || null;
      const signal = exec ? (STEP_SIG[exec.status] || 'idle') : 'idle';
      const sid = `st:${s.id}`;

      // Step-scoped policies (left branch).
      const pols = (s.policies || []).map((po) => ({
        id: `po:${po.id}`, type: 'policy', label: po.name, key: po.key,
        definition: po.definition || '', params: po.params || {}, version: po.version,
      }));
      // Step tools + engine (right branch): step.tool, stepTools, then engineSource.
      const toolList = [];
      const seenTool = new Set();
      if (s.tool) { seenTool.add(s.tool.id); toolList.push({ id: `to:${sid}:${s.tool.id}`, type: 'tool', label: s.tool.name, ttype: s.tool.type, slug: s.tool.slug }); }
      (s.stepTools || []).forEach((st) => {
        if (!st.tool || seenTool.has(st.tool.id)) return;
        seenTool.add(st.tool.id);
        toolList.push({ id: `to:${sid}:${st.tool.id}`, type: 'tool', label: st.tool.name, ttype: st.tool.type, slug: st.tool.slug, role: st.role || null });
      });
      if (s.engineSource) toolList.push({ id: `eng:${sid}`, type: 'tool', label: s.engineSource, ttype: 'engine', engine: true });

      nodes.push({
        id: sid, type: 'step', label: s.name, key: s.key, order: s.order,
        decisionType: s.decisionType, isGate: s.isGate, pauseAfter: s.pauseAfter,
        engineSource: s.engineSource || null, signal,
        policies: pols, tools: toolList,
        exec: exec ? { status: exec.status, outcome: exec.outcome || {}, policiesApplied: exec.policiesApplied || [] } : null,
      });
      pols.forEach((po) => { nodes.push(po); edges.push({ from: sid, to: po.id, signal, branch: 'policy' }); });
      toolList.forEach((t) => { nodes.push(t); edges.push({ from: sid, to: t.id, signal, branch: 'tool' }); });
      edges.push({ from: prevSpineId, to: sid, signal, spine: true });
      prevSpineId = sid;
    });

    // Process-level policies (scope !== step, i.e. no stepId) + process tools → side rail.
    const rail = {
      policies: (p.policies || []).filter((po) => !po.stepId).map((po) => ({
        id: `rpo:${po.id}`, type: 'policy', label: po.name, key: po.key, scope: po.scope,
        definition: po.definition || '', params: po.params || {},
      })),
      tools: (p.tools || []).map((pt) => ({
        id: `rto:${pt.id}`, type: 'tool', label: pt.tool ? pt.tool.name : 'tool',
        ttype: pt.tool ? pt.tool.type : null, role: pt.role || null,
      })),
    };

    // Fast-travel nav: all areas + their processes (same shape as overview).
    const allRows = await prisma.process.findMany({
      where: { isActive: true }, orderBy: { createdAt: 'asc' },
      include: { function: true },
    });
    const order = new Map(SUBFUNCTIONS.map((s, i) => [s.slug, i]));
    const byFn = new Map();
    allRows.forEach((pr) => {
      const slug = pr.function ? pr.function.slug : 'unassigned';
      if (!byFn.has(slug)) byFn.set(slug, { slug, name: pr.function ? pr.function.name : 'Unassigned', processes: [] });
      byFn.get(slug).processes.push({ slug: pr.slug, name: pr.name });
    });
    const nav = [...byFn.values()].sort((a, b) => (order.has(a.slug) ? order.get(a.slug) : 99) - (order.has(b.slug) ? order.get(b.slug) : 99));

    res.render('processes-live', {
      graph: { nodes, edges, mode: 'schematic', rail },
      counts: null, nav, org: orgName,
      current: { slug: p.slug, name: p.name, fnSlug: p.function ? p.function.slug : null },
      hud: {
        name: p.name,
        area: p.function ? p.function.name : (p.businessUnit ? p.businessUnit.name : ''),
        agent: p.ownerAgent ? p.ownerAgent.name : null,
        agentSlug: p.ownerAgent ? p.ownerAgent.slug : null,
        frequency: p.frequency, mode: p.mode,
        status: runStatus || 'idle', signal: procSignal,
        period: lastRun ? lastRun.period : null,
        steps: p.steps.length,
      },
      pageTitle: `Ridgeline Finance OS — ${p.name}`,
      pageDescription: `Live schematic of the ${p.name} process — agent, steps, policies and tools.`,
    });
  } catch (e) { next(e); }
});

// Tools Registry — platform-wide inventory of skills, agents, prompts, and MCP servers.
router.get('/registry', async (req, res, next) => {
  try {
    // Non-agent tools come from the shared tool registry.
    const rows = await prisma.tool.findMany({
      where: { type: { not: 'agent' } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { processTools: true, steps: true } } },
    });
    const toolCards = rows.map((t) => ({
      slug: t.slug, name: t.name, type: t.type,
      typeLabel: (TOOL_TYPE_META[t.type] || {}).label || t.type,
      description: t.description,
      processCount: t._count.processTools, stepCount: t._count.steps,
      href: `/registry/${t.slug}`,
    }));
    // Agents come live from the real Agent table so the registry always matches
    // Admin → Agent Management. One source of truth — no placeholder duplicates.
    const agents = await prisma.agent.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { ownedProcesses: true } } },
    });
    const agentCards = agents.map((a) => ({
      slug: a.slug, name: a.name, type: 'agent',
      typeLabel: TOOL_TYPE_META.agent.label,
      description: a.description,
      processCount: a._count.ownedProcesses, stepCount: 0,
      href: `/agents?agent=${encodeURIComponent(a.slug)}`,
    }));
    const tools = [...agentCards, ...toolCards];
    res.render('registry', {
      tools,
      typeMeta: TOOL_TYPE_META,
      pageTitle: 'Ridgeline Finance OS — Tools Registry',
      pageDescription: 'Platform-wide inventory of automations, skills, agents, prompts, and MCP servers.',
    });
  } catch (e) { next(e); }
});

router.get('/registry/:slug', async (req, res, next) => {
  try {
    const tool = await prisma.tool.findUnique({
      where: { slug: req.params.slug },
      include: {
        processTools: { include: { process: { include: { function: true } } } },
        steps: { include: { process: true } },
      },
    });
    if (!tool) return res.status(404).send('Tool not found.');
    res.render('registry-detail', {
      tool,
      meta: TOOL_TYPE_META[tool.type] || { label: tool.type, blurb: '' },
      typeMeta: TOOL_TYPE_META,
      pageTitle: `Ridgeline Finance OS — ${tool.name}`,
      pageDescription: `${tool.name} — ${tool.description || 'A tool in the Ridgeline Finance OS registry.'}`,
    });
  } catch (e) { next(e); }
});

// ── Documentation — API docs + MCP docs (the agent-ready surface) ──────────
router.get('/docs/api', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.render('docs/api', {
    groups: API_GROUPS,
    count: endpointCount(),
    baseUrl,
    curlFor,
    pageTitle: 'Ridgeline Finance OS — API Documentation',
    pageDescription: 'Every REST endpoint on the Ridgeline Finance OS platform.',
  });
});

router.get('/docs/mcp', (req, res) => {
  res.render('docs/mcp', {
    groups: TOOL_GROUPS,
    count: toolCount(),
    cwd: PROJECT_ROOT,
    pageTitle: 'Ridgeline Finance OS — MCP Documentation',
    pageDescription: 'The Model Context Protocol tool surface for the freight accrual loop.',
  });
});

router.post('/process/:slug/run', async (req, res, next) => {
  try {
    const r = await runProcess({ processSlug: req.params.slug, period: req.body.period || 'April 2026', mode: req.body.mode || 'manual' });
    res.redirect(`/process/${req.params.slug}/monitor?run=${r.runId}&ran=1`);
  } catch (e) { next(e); }
});

// AI insight — the owner agent narrates the overview into a few bullets, using a
// summary prompt stored in the registry. Cached on the run; JSON for the UI button.
router.post('/process/:slug/insight', async (req, res) => {
  try {
    const out = await generateInsight({ slug: req.params.slug, runId: req.body.run || req.query.run || null });
    res.json({ ok: true, data: out });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message || String(e) }); }
});

router.post('/run/:runId/signoff', async (req, res, next) => {
  try {
    await signOff(req.params.runId, { actor: req.body.actor || 'Controller', note: req.body.note || '' });
    res.redirect(`/process/${req.body.slug || PROCESS_SLUG}/monitor?run=${req.params.runId}`);
  } catch (e) { next(e); }
});

router.post('/run/:runId/freeze', async (req, res, next) => {
  try {
    await freezeRun(req.params.runId, { actor: req.body.actor || 'Controller' });
    res.redirect(`/process/${req.body.slug || PROCESS_SLUG}/monitor?run=${req.params.runId}`);
  } catch (e) { next(e); }
});

// ── Improve plane: reconcile actuals · propose · apply (versioned) ────────────
router.post('/run/:runId/reconcile', async (req, res, next) => {
  try {
    await reconcileRun(req.params.runId, { actor: req.body.actor || 'Reconciliation Agent' });
    res.redirect(`/process/${req.body.slug || PROCESS_SLUG}/improve?run=${req.params.runId}`);
  } catch (e) { next(e); }
});

router.post('/process/:slug/improve/propose', async (req, res, next) => {
  try {
    await improve.generateProposals(req.params.slug, { runId: req.body.run || null });
    res.redirect(`/process/${req.params.slug}/improve${req.body.run ? `?run=${req.body.run}` : ''}`);
  } catch (e) { next(e); }
});

router.post('/improve/proposal/:proposalId/apply', async (req, res, next) => {
  try {
    await improve.applyProposal(req.params.proposalId, { approvedBy: req.body.actor || 'Controller' });
    res.redirect(`/process/${req.body.slug || PROCESS_SLUG}/improve${req.body.run ? `?run=${req.body.run}` : ''}`);
  } catch (e) { next(e); }
});

// Manual process create + step/policy/tool edit FORM endpoints were REMOVED
// (decision §14.8: agentic-only creation AND modification). A process is created
// and modified ONLY through its owner agent (the automator + the fos__ Builder
// tools). The Setup tab is now read-only package inspection; the JSON API
// (/api/fos/...) remains for programmatic access.

module.exports = router;
