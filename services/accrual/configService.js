// Process configuration service — the construct-a-process surface.
//
// Every mutation a human can make on the Configure (Setup) page is exposed here
// as a clean function that takes/returns plain JSON. Both the browser HTML form
// routes (routes/financeOs.js) and the agent-facing JSON API (routes/fosConfigApi.js)
// call into these, so there is exactly one implementation of each mutation.
//
// This is what makes the platform agent-driveable: an agent (or the process
// automator) can create a process and define its definition, steps, policies and
// tool bindings entirely through the API, identical to a human using the UI.

const prisma = require('../db');
const { SUBFUNCTIONS, SUBFUNCTION_SLUGS } = require('./processService');

const RUN_MODES = ['auto', 'adhoc', 'manual'];
const DECISION_TYPES = ['policy_based', 'judgment_based', 'mixed'];

async function getProcessOrThrow(slug) {
  const proc = await prisma.process.findFirst({ where: { slug } });
  if (!proc) {
    const e = new Error(`Process not found: ${slug}`);
    e.status = 404;
    throw e;
  }
  return proc;
}

// Full configuration read — the definition spine plus steps, policies and tool
// bindings. This is the canonical "what does this process look like" payload an
// agent reads before editing.
async function getProcessConfig(slug) {
  const proc = await prisma.process.findFirst({
    where: { slug },
    include: {
      org: true,
      legalEntity: true,
      businessUnit: true,
      function: true,
      steps: {
        orderBy: { order: 'asc' },
        include: {
          stepTools: { include: { tool: true } },
          policies: { orderBy: { key: 'asc' } },
        },
      },
      policies: { orderBy: { key: 'asc' } },
      tools: { include: { tool: true } },
    },
  });
  if (!proc) {
    const e = new Error(`Process not found: ${slug}`);
    e.status = 404;
    throw e;
  }
  const mapStepTool = (st) => ({
    stepToolId: st.id, toolId: st.toolId, role: st.role,
    name: st.tool ? st.tool.name : null, type: st.tool ? st.tool.type : null,
    slug: st.tool ? st.tool.slug : null, description: st.tool ? st.tool.description : null,
  });
  const mapPolicy = (p) => ({
    id: p.id, key: p.key, name: p.name, definition: p.definition,
    params: p.params || {}, scope: p.scope, stepId: p.stepId, version: p.version,
  });
  return {
    id: proc.id,
    slug: proc.slug,
    name: proc.name,
    description: proc.description,
    frequency: proc.frequency,
    mode: proc.mode,
    improveTrigger: proc.improveTrigger || { mode: 'auto', lookbackRuns: 6 },
    org: proc.org ? proc.org.name : null,
    legalEntity: proc.legalEntity ? proc.legalEntity.name : null,
    businessUnit: proc.businessUnit ? proc.businessUnit.name : null,
    function: proc.function ? { slug: proc.function.slug, name: proc.function.name } : null,
    steps: proc.steps.map((s) => ({
      id: s.id, order: s.order, key: s.key, name: s.name, description: s.description,
      decisionType: s.decisionType, engineSource: s.engineSource, toolId: s.toolId,
      isGate: s.isGate, pauseAfter: s.pauseAfter, version: s.version,
      // Everything that runs inside a step: its tools (automations/agents/...) and its policies.
      tools: (s.stepTools || []).map(mapStepTool),
      policies: (s.policies || []).map(mapPolicy),
    })),
    // Process-scope policies (not pinned to any step).
    policies: proc.policies.filter((p) => !p.stepId).map(mapPolicy),
    tools: proc.tools.map((pt) => ({
      processToolId: pt.id, toolId: pt.toolId, role: pt.role,
      name: pt.tool ? pt.tool.name : null, type: pt.tool ? pt.tool.type : null,
      slug: pt.tool ? pt.tool.slug : null,
    })),
  };
}

// The global tool registry (skills, agents, prompts, integrations) processes can map.
async function listTools() {
  const tools = await prisma.tool.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] });
  return tools.map((t) => ({ id: t.id, slug: t.slug, name: t.name, type: t.type, description: t.description }));
}

// The canonical finance sub-functions a process can be homed to.
function listSubfunctions() {
  return SUBFUNCTIONS.map((s) => ({ slug: s.slug, name: s.name }));
}

async function updateDefinition(slug, { name, description, frequency, mode, functionSlug, legalEntityId, businessUnitId } = {}) {
  const proc = await getProcessOrThrow(slug);
  let functionId = proc.functionId;
  if (functionSlug !== undefined) {
    if (!functionSlug) functionId = null;
    else {
      const fn = await prisma.orgFunction.findUnique({ where: { slug: functionSlug } });
      functionId = fn ? fn.id : proc.functionId;
    }
  }

  // Legal entity is editable but must stay within the process's organization.
  let nextLegalEntityId = proc.legalEntityId;
  if (legalEntityId !== undefined && legalEntityId && legalEntityId !== proc.legalEntityId) {
    const le = await prisma.legalEntity.findFirst({ where: { id: legalEntityId, orgId: proc.orgId } });
    if (le) nextLegalEntityId = le.id;
  }

  // Business unit is editable (nullable) but must belong to the chosen legal entity.
  let nextBusinessUnitId = proc.businessUnitId;
  if (businessUnitId !== undefined) {
    if (!businessUnitId) {
      nextBusinessUnitId = null;
    } else {
      const bu = await prisma.businessUnit.findFirst({ where: { id: businessUnitId, legalEntityId: nextLegalEntityId } });
      nextBusinessUnitId = bu ? bu.id : null;
    }
  }
  // If the legal entity changed and the existing BU no longer belongs to it, drop it.
  if (nextLegalEntityId !== proc.legalEntityId && nextBusinessUnitId === proc.businessUnitId && nextBusinessUnitId) {
    const stillValid = await prisma.businessUnit.findFirst({ where: { id: nextBusinessUnitId, legalEntityId: nextLegalEntityId } });
    if (!stillValid) nextBusinessUnitId = null;
  }

  await prisma.process.update({
    where: { id: proc.id },
    data: {
      name: name && String(name).trim() ? String(name).trim() : proc.name,
      description: description ?? proc.description,
      frequency: frequency && String(frequency).trim() ? String(frequency).trim() : proc.frequency,
      mode: RUN_MODES.includes(mode) ? mode : proc.mode,
      functionId,
      legalEntityId: nextLegalEntityId,
      businessUnitId: nextBusinessUnitId,
    },
  });
  return getProcessConfig(slug);
}

// Org tree for the Definition selects: legal entities (+ their business units)
// under the process's organization. Used to make LE/BU editable.
async function listOrgUnits(slug) {
  const proc = await getProcessOrThrow(slug);
  const legalEntities = await prisma.legalEntity.findMany({
    where: { orgId: proc.orgId },
    orderBy: { name: 'asc' },
    include: { businessUnits: { orderBy: { name: 'asc' } } },
  });
  return legalEntities.map((le) => ({
    id: le.id, name: le.name,
    businessUnits: le.businessUnits.map((bu) => ({ id: bu.id, name: bu.name })),
  }));
}

async function updateImproveTrigger(slug, { mode, lookbackRuns } = {}) {
  const proc = await getProcessOrThrow(slug);
  const it = proc.improveTrigger || {};
  const nextMode = ['auto', 'manual'].includes(mode) ? mode : (it.mode || 'auto');
  const nextLookback = Math.max(1, parseInt(lookbackRuns, 10) || it.lookbackRuns || 6);
  await prisma.process.update({
    where: { id: proc.id },
    data: { improveTrigger: { ...it, mode: nextMode, lookbackRuns: nextLookback } },
  });
  return getProcessConfig(slug);
}

function normalizeStepData(b, { partial } = { partial: true }) {
  const data = {};
  if (b.name !== undefined) data.name = String(b.name).trim() || undefined;
  if (b.description !== undefined) data.description = b.description;
  if (b.decisionType !== undefined && DECISION_TYPES.includes(b.decisionType)) data.decisionType = b.decisionType;
  if (b.engineSource !== undefined) data.engineSource = (String(b.engineSource ?? '').trim()) || null;
  if (b.toolId !== undefined) data.toolId = b.toolId || null;
  if (b.isGate !== undefined) data.isGate = !!b.isGate;
  if (b.pauseAfter !== undefined) data.pauseAfter = !!b.pauseAfter;
  return data;
}

async function addStep(slug, body = {}) {
  const proc = await getProcessOrThrow(slug);
  const last = await prisma.step.findFirst({ where: { processId: proc.id }, orderBy: { order: 'desc' } });
  const order = (last ? last.order : 0) + 1;
  const data = normalizeStepData(body, { partial: false });
  if (!data.name) throw Object.assign(new Error('Step name is required.'), { status: 400 });
  const key = (body.key && String(body.key).trim())
    || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `step-${order}`;
  const step = await prisma.step.create({
    data: {
      processId: proc.id, order, key, name: data.name,
      description: data.description ?? null,
      decisionType: data.decisionType || 'policy_based',
      engineSource: data.engineSource ?? null,
      toolId: data.toolId ?? null,
      isGate: data.isGate ?? false,
      pauseAfter: data.pauseAfter ?? false,
      version: 1,
    },
  });
  return getProcessConfig(slug);
}

async function updateStep(slug, stepId, body = {}) {
  await getProcessOrThrow(slug);
  const data = normalizeStepData(body, { partial: true });
  await prisma.step.update({
    where: { id: stepId },
    data: { ...data, version: { increment: 1 } },
  });
  return getProcessConfig(slug);
}

async function deleteStep(slug, stepId) {
  await getProcessOrThrow(slug);
  await prisma.step.delete({ where: { id: stepId } });
  return getProcessConfig(slug);
}

async function addPolicy(slug, { key, name, definition, params, scope, stepId } = {}) {
  const proc = await getProcessOrThrow(slug);
  if (!name || !String(name).trim()) throw Object.assign(new Error('Policy name is required.'), { status: 400 });
  const pkey = (key && String(key).trim())
    || String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'policy';
  // A policy can be pinned to a step (its rule lives "inside" that step) or left
  // at process scope. Validate the step belongs to this process before pinning.
  let pinnedStepId = null;
  if (stepId) {
    const step = await prisma.step.findFirst({ where: { id: stepId, processId: proc.id } });
    if (step) pinnedStepId = step.id;
  }
  await prisma.policy.create({
    data: {
      processId: proc.id, key: pkey, name: String(name).trim(),
      definition: definition ?? '', params: params && typeof params === 'object' ? params : {},
      scope: pinnedStepId ? 'step' : (scope || 'process'), stepId: pinnedStepId, version: 1,
    },
  });
  return getProcessConfig(slug);
}

async function updatePolicy(slug, policyId, { definition, params } = {}) {
  await getProcessOrThrow(slug);
  const policy = await prisma.policy.findUnique({ where: { id: policyId } });
  if (!policy) throw Object.assign(new Error('Policy not found.'), { status: 404 });
  await prisma.policy.update({
    where: { id: policy.id },
    data: {
      definition: definition ?? policy.definition,
      params: params && typeof params === 'object' ? params : policy.params,
      version: { increment: 1 },
    },
  });
  return getProcessConfig(slug);
}

async function deletePolicy(slug, policyId) {
  await getProcessOrThrow(slug);
  await prisma.policy.delete({ where: { id: policyId } });
  return getProcessConfig(slug);
}

// Attach a tool from the shared registry to a single step. Keeps a ProcessTool
// mapping in sync so the registry's "used by" stays accurate.
async function attachStepTool(slug, stepId, { toolId, role } = {}) {
  const proc = await getProcessOrThrow(slug);
  if (!toolId) throw Object.assign(new Error('toolId is required.'), { status: 400 });
  const step = await prisma.step.findFirst({ where: { id: stepId, processId: proc.id } });
  if (!step) throw Object.assign(new Error('Step not found on this process.'), { status: 404 });
  const tool = await prisma.tool.findUnique({ where: { id: toolId } });
  if (!tool) throw Object.assign(new Error('Tool not found.'), { status: 404 });
  await prisma.stepTool.upsert({
    where: { stepId_toolId: { stepId: step.id, toolId } },
    update: { role: role || null },
    create: { stepId: step.id, toolId, role: role || null },
  });
  // Mirror into ProcessTool so the platform registry knows this process uses it.
  await prisma.processTool.upsert({
    where: { processId_toolId: { processId: proc.id, toolId } },
    update: {},
    create: { processId: proc.id, toolId, role: role || null },
  });
  return getProcessConfig(slug);
}

// Detach a tool from a step. If no other step on the process still uses the
// tool, also drop the ProcessTool mapping so the registry stays honest.
async function detachStepTool(slug, stepToolId) {
  const proc = await getProcessOrThrow(slug);
  const st = await prisma.stepTool.findUnique({ where: { id: stepToolId }, include: { step: true } });
  if (!st || !st.step || st.step.processId !== proc.id) {
    throw Object.assign(new Error('Step tool not found on this process.'), { status: 404 });
  }
  const toolId = st.toolId;
  await prisma.stepTool.delete({ where: { id: stepToolId } });
  const stillUsed = await prisma.stepTool.count({
    where: { toolId, step: { processId: proc.id } },
  });
  if (!stillUsed) {
    await prisma.processTool.deleteMany({ where: { processId: proc.id, toolId } });
  }
  return getProcessConfig(slug);
}

async function mapTool(slug, { toolId, role } = {}) {
  const proc = await getProcessOrThrow(slug);
  if (!toolId) throw Object.assign(new Error('toolId is required.'), { status: 400 });
  await prisma.processTool.upsert({
    where: { processId_toolId: { processId: proc.id, toolId } },
    update: { role: role || null },
    create: { processId: proc.id, toolId, role: role || null },
  });
  return getProcessConfig(slug);
}

async function unmapTool(slug, toolId) {
  const proc = await getProcessOrThrow(slug);
  await prisma.processTool.deleteMany({ where: { processId: proc.id, toolId } });
  return getProcessConfig(slug);
}

module.exports = {
  RUN_MODES, DECISION_TYPES,
  getProcessConfig, listTools, listSubfunctions, listOrgUnits,
  updateDefinition, updateImproveTrigger,
  addStep, updateStep, deleteStep,
  addPolicy, updatePolicy, deletePolicy,
  attachStepTool, detachStepTool,
  mapTool, unmapTool,
};
