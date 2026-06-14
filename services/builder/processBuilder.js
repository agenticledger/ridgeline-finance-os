// Process Builder — the owner agent's "Builder hat".
//
// SPEC §11: the same Process Owner Agent that supervises runs also ENGINEERS its
// process agentically. These are the write-side primitives behind the fos__ builder
// tools. Every mutation is versioned at the OBJECT level (ObjectVersion, source
// 'agent') and the agent's own build_log AgentDocument records what it changed, so
// the package is fully auditable and the agent's knowledge of its own build is
// stored DB-as-truth (decision 7). Editing is AGENTIC ONLY (decision 8) — there is
// no manual UI behind these.
//
// Engines are written as plain files under services/engines/{slug}/ (decision 1: no
// sandboxing). The generic runner binds an engine by its slug via the ENGINES
// registry; a step's engineSource records WHICH engine ran it.

const path = require('path');
const fs = require('fs/promises');
const prisma = require('../db');
const { agentSlugFor } = require('../accrual/processAgentService');

const ENGINES_DIR = path.join(__dirname, '..', 'engines');

const VALID_DECISION = new Set(['policy_based', 'judgment_based', 'mixed']);
const VALID_TOOL_TYPE = new Set(['skill', 'mcp', 'agent', 'human', 'prompt', 'automation']);
const VALID_SCOPE = new Set(['org', 'function', 'process', 'step']);

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

// Load the process this agent owns, with its spine, by slug.
async function loadProcess(slug) {
  const process = await prisma.process.findFirst({
    where: { slug },
    include: { steps: { orderBy: { order: 'asc' } }, policies: true, tools: { include: { tool: true } } },
  });
  if (!process) throw new Error(`Process not found: ${slug}`);
  return process;
}

// Write an object-version ledger row (the audit spine for agent edits).
async function recordVersion(objectType, objectId, version, diff, actor) {
  return prisma.objectVersion.create({
    data: { objectType, objectId, version, diff, source: 'agent', approvedBy: actor || 'Owner Agent', approvedAt: new Date() },
  });
}

// Append a line to the owner agent's build_log AgentDocument (DB-as-truth knowledge).
async function logBuild(process, action, detail) {
  const agentId = process.agentId;
  if (!agentId) return null;
  const stamp = new Date().toISOString();
  const line = `[${stamp}] ${action} — ${detail}`;
  const existing = await prisma.agentDocument.findUnique({
    where: { agentId_docType_docKey: { agentId, docType: 'build_log', docKey: 'build_log' } },
  }).catch(() => null);
  if (existing) {
    return prisma.agentDocument.update({
      where: { id: existing.id },
      data: { content: `${existing.content}\n${line}` },
    });
  }
  return prisma.agentDocument.create({
    data: {
      agentId, docType: 'build_log', docKey: 'build_log',
      content: `# Build log — ${process.name}\nEvery agentic change to this process package, newest appended last.\n\n${line}`,
    },
  });
}

// Regenerate the owner agent's supervisor prompt so it reflects the new spine.
async function refreshOwnerPrompt(processId) {
  try {
    const { provisionOwnerAgent } = require('../accrual/processAgentService');
    await provisionOwnerAgent(processId, { regeneratePrompt: true });
  } catch (e) {
    // Non-fatal: the edit stands even if prompt refresh fails.
  }
}

// Register a step's bound engine as a registry Tool so the package feeds the
// tools registry. The processTool + stepTool links give the engine accurate
// process/step counts on /registry — the same wiring freight's engines have.
async function registerEngineTool(process, step, engineSource) {
  if (!engineSource) return null;
  const toolSlug = slugify(`${process.slug}-${step.key}-engine`);
  const tool = await prisma.tool.upsert({
    where: { slug: toolSlug },
    update: { config: { engineSource } },
    create: {
      type: 'automation',
      name: `${step.name} Engine`,
      slug: toolSlug,
      description: `Deterministic engine bound to the '${step.name}' step of ${process.name}.`,
      config: { engineSource },
    },
  });
  await prisma.processTool.upsert({
    where: { processId_toolId: { processId: process.id, toolId: tool.id } },
    update: { role: 'engine' },
    create: { processId: process.id, toolId: tool.id, role: 'engine' },
  });
  await prisma.stepTool.upsert({
    where: { stepId_toolId: { stepId: step.id, toolId: tool.id } },
    update: { role: 'engine' },
    create: { stepId: step.id, toolId: tool.id, role: 'engine' },
  });
  // Set the step's primary tool too — this is the relation the registry counts as
  // stepCount (matches how freight's seeded engines are wired to their steps).
  await prisma.step.update({ where: { id: step.id }, data: { toolId: tool.id } });
  return tool;
}

// ── Step authoring ──────────────────────────────────────────────────────────

async function createStep(slug, { key, name, description = '', decisionType = 'policy_based', dependsOn = [], feedbackTo = null, isGate = false, pauseAfter = false, engineSource = null }, actor) {
  const process = await loadProcess(slug);
  const stepKey = slugify(key || name);
  if (!stepKey) throw new Error('Step key/name is required.');
  if (!name) throw new Error('Step name is required.');
  if (!VALID_DECISION.has(decisionType)) throw new Error(`decisionType must be one of ${[...VALID_DECISION].join(', ')}.`);
  if (process.steps.some((s) => s.key === stepKey)) throw new Error(`Step '${stepKey}' already exists.`);
  const known = new Set(process.steps.map((s) => s.key));
  for (const d of dependsOn) if (!known.has(d)) throw new Error(`dependsOn references unknown step '${d}'.`);
  if (feedbackTo && !known.has(feedbackTo)) throw new Error(`feedbackTo references unknown step '${feedbackTo}'.`);

  const order = (process.steps.reduce((m, s) => Math.max(m, s.order), 0)) + 1;
  const step = await prisma.step.create({
    data: {
      processId: process.id, order, key: stepKey, name, description,
      decisionType, dependsOn, feedbackTo, isGate: !!isGate, pauseAfter: !!pauseAfter,
      engineSource, version: 1,
    },
  });
  await recordVersion('step', step.id, 1, { created: { key: stepKey, name, decisionType, dependsOn, feedbackTo, isGate, pauseAfter } }, actor);
  if (engineSource) await registerEngineTool(process, step, engineSource);
  await logBuild(process, 'create_step', `added step #${order} '${name}' (${stepKey}); dependsOn=[${dependsOn.join(',')}]${isGate ? ' [GATE]' : ''}`);
  await refreshOwnerPrompt(process.id);
  return { ok: true, stepKey, order, stepId: step.id };
}

async function updateStep(slug, key, patch = {}, actor) {
  const process = await loadProcess(slug);
  const step = process.steps.find((s) => s.key === key);
  if (!step) throw new Error(`Step '${key}' not found.`);
  const allowed = ['name', 'description', 'decisionType', 'dependsOn', 'feedbackTo', 'isGate', 'pauseAfter', 'engineSource'];
  const data = {};
  const diff = {};
  for (const f of allowed) {
    if (patch[f] === undefined) continue;
    if (f === 'decisionType' && !VALID_DECISION.has(patch[f])) throw new Error(`decisionType must be one of ${[...VALID_DECISION].join(', ')}.`);
    if (f === 'dependsOn') {
      const known = new Set(process.steps.map((s) => s.key));
      for (const d of patch[f]) if (!known.has(d)) throw new Error(`dependsOn references unknown step '${d}'.`);
    }
    if (f === 'feedbackTo' && patch[f]) {
      const known = new Set(process.steps.map((s) => s.key));
      if (!known.has(patch[f])) throw new Error(`feedbackTo references unknown step '${patch[f]}'.`);
    }
    data[f] = patch[f];
    diff[f] = { before: step[f], after: patch[f] };
  }
  if (!Object.keys(data).length) throw new Error('No updatable fields provided.');
  const newVersion = step.version + 1;
  data.version = newVersion;
  await prisma.step.update({ where: { id: step.id }, data });
  await recordVersion('step', step.id, newVersion, diff, actor);
  await logBuild(process, 'update_step', `edited '${step.name}' (${key}): ${Object.keys(diff).join(', ')}`);
  await refreshOwnerPrompt(process.id);
  return { ok: true, stepKey: key, version: newVersion, changed: Object.keys(diff) };
}

async function reorderSteps(slug, orderedKeys, actor) {
  const process = await loadProcess(slug);
  const keys = process.steps.map((s) => s.key);
  const set = new Set(orderedKeys);
  if (orderedKeys.length !== keys.length || keys.some((k) => !set.has(k))) {
    throw new Error(`order must list every step key exactly once: ${keys.join(', ')}`);
  }
  // Two-phase to avoid the unique(processId, order) collision: park into a high range, then settle.
  await prisma.$transaction(orderedKeys.map((k, i) => {
    const step = process.steps.find((s) => s.key === k);
    return prisma.step.update({ where: { id: step.id }, data: { order: 1000 + i } });
  }));
  await prisma.$transaction(orderedKeys.map((k, i) => {
    const step = process.steps.find((s) => s.key === k);
    return prisma.step.update({ where: { id: step.id }, data: { order: i + 1 } });
  }));
  await logBuild(process, 'reorder_steps', `new order: ${orderedKeys.join(' -> ')}`);
  await refreshOwnerPrompt(process.id);
  return { ok: true, order: orderedKeys };
}

// ── Engine binding ──────────────────────────────────────────────────────────

// Bind an engine to a step. Writes the engine file under services/engines/{slug}/
// (decision 1: no sandboxing) and records engineSource on the step. The generic
// runner runs the step as a scaffold; engineSource is the auditable "what ran it".
async function setEngine(slug, stepKey, { language = 'js', code = null, engineName = null } = {}, actor) {
  const process = await loadProcess(slug);
  const step = process.steps.find((s) => s.key === stepKey);
  if (!step) throw new Error(`Step '${stepKey}' not found.`);
  const ext = language === 'py' ? 'py' : 'js';
  const dir = path.join(ENGINES_DIR, slug);
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${stepKey}.${ext}`;
  const filePath = path.join(dir, fileName);
  const body = code || (ext === 'py'
    ? `# Engine for step '${stepKey}' of process '${slug}'.\n# Authored by the ${process.name} Owner Agent (Builder hat).\n\ndef run(context):\n    raise NotImplementedError("engine body not yet authored")\n`
    : `// Engine for step '${stepKey}' of process '${slug}'.\n// Authored by the ${process.name} Owner Agent (Builder hat).\n\nmodule.exports = function run(context) {\n  throw new Error('engine body not yet authored');\n};\n`);
  await fs.writeFile(filePath, body, 'utf8');

  const engineSource = engineName || `engines/${slug}/${fileName}`;
  const newVersion = step.version + 1;
  await prisma.step.update({ where: { id: step.id }, data: { engineSource, version: newVersion } });
  await recordVersion('step', step.id, newVersion, { engineSource: { before: step.engineSource, after: engineSource }, file: `services/${engineSource.startsWith('engines/') ? engineSource : `engines/${slug}/${fileName}`}` }, actor);
  await registerEngineTool(process, step, engineSource);
  await logBuild(process, 'set_engine', `bound engine '${engineSource}' to step '${step.name}' (${stepKey}); wrote services/engines/${slug}/${fileName}`);
  await refreshOwnerPrompt(process.id);
  return { ok: true, stepKey, engineSource, file: `services/engines/${slug}/${fileName}` };
}

// ── Policy authoring ────────────────────────────────────────────────────────

async function createPolicy(slug, { key, name, definition = '', params = {}, scope = 'process', stepKey = null }, actor) {
  const process = await loadProcess(slug);
  const policyKey = slugify(key || name).replace(/-/g, '_');
  if (!policyKey) throw new Error('Policy key/name is required.');
  if (!name) throw new Error('Policy name is required.');
  if (!VALID_SCOPE.has(scope)) throw new Error(`scope must be one of ${[...VALID_SCOPE].join(', ')}.`);
  const dup = await prisma.policy.findFirst({ where: { processId: process.id, key: policyKey } });
  if (dup) throw new Error(`Policy '${policyKey}' already exists.`);
  let stepId = null;
  if (stepKey) {
    const step = process.steps.find((s) => s.key === stepKey);
    if (!step) throw new Error(`Step '${stepKey}' not found for policy binding.`);
    stepId = step.id;
  }
  const policy = await prisma.policy.create({
    data: { processId: process.id, stepId, scope, key: policyKey, name, definition, params, version: 1 },
  });
  await recordVersion('policy', policy.id, 1, { created: { key: policyKey, name, scope, params } }, actor);
  await logBuild(process, 'create_policy', `added policy '${name}' (${policyKey}, scope=${scope}) params=${JSON.stringify(params)}`);
  await refreshOwnerPrompt(process.id);
  return { ok: true, policyKey, policyId: policy.id };
}

async function updatePolicy(slug, key, patch = {}, actor) {
  const process = await loadProcess(slug);
  const policy = await prisma.policy.findFirst({ where: { processId: process.id, key } });
  if (!policy) throw new Error(`Policy '${key}' not found.`);
  const data = {};
  const diff = {};
  if (patch.name !== undefined) { data.name = patch.name; diff.name = { before: policy.name, after: patch.name }; }
  if (patch.definition !== undefined) { data.definition = patch.definition; diff.definition = { before: policy.definition, after: patch.definition }; }
  if (patch.params !== undefined) {
    const before = { ...(policy.params || {}) };
    // Merge so a partial params patch only touches named keys (matches improve loop).
    const after = { ...before, ...patch.params };
    data.params = after;
    diff.params = { before, after };
  }
  if (!Object.keys(data).length) throw new Error('No updatable fields provided (name, definition, params).');
  const newVersion = policy.version + 1;
  data.version = newVersion;
  await prisma.policy.update({ where: { id: policy.id }, data });
  await recordVersion('policy', policy.id, newVersion, diff, actor);
  await logBuild(process, 'update_policy', `edited policy '${policy.name}' (${key}): ${Object.keys(diff).join(', ')}`);
  await refreshOwnerPrompt(process.id);
  return { ok: true, policyKey: key, version: newVersion, changed: Object.keys(diff) };
}

// ── Tool attachment ─────────────────────────────────────────────────────────

// Attach a tool to the process (and optionally a step). Reuses a tool from the
// global registry by slug, or creates one from a definition.
async function attachTool(slug, { toolSlug = null, type = null, name = null, description = '', config = {}, stepKey = null, role = null }, actor) {
  const process = await loadProcess(slug);
  let tool = null;
  if (toolSlug) {
    tool = await prisma.tool.findUnique({ where: { slug: toolSlug } });
    if (!tool) throw new Error(`Tool '${toolSlug}' not found in the registry. Provide type+name to create it.`);
  } else {
    if (!type || !name) throw new Error('Provide toolSlug, or type+name to create a new tool.');
    if (!VALID_TOOL_TYPE.has(type)) throw new Error(`type must be one of ${[...VALID_TOOL_TYPE].join(', ')}.`);
    const tslug = slugify(name);
    tool = await prisma.tool.findUnique({ where: { slug: tslug } });
    if (!tool) tool = await prisma.tool.create({ data: { type, name, slug: tslug, description, config } });
  }
  await prisma.processTool.upsert({
    where: { processId_toolId: { processId: process.id, toolId: tool.id } },
    update: { role },
    create: { processId: process.id, toolId: tool.id, role },
  });
  let stepAttached = null;
  if (stepKey) {
    const step = process.steps.find((s) => s.key === stepKey);
    if (!step) throw new Error(`Step '${stepKey}' not found for tool attachment.`);
    await prisma.stepTool.upsert({
      where: { stepId_toolId: { stepId: step.id, toolId: tool.id } },
      update: { role },
      create: { stepId: step.id, toolId: tool.id, role },
    });
    stepAttached = stepKey;
  }
  await logBuild(process, 'attach_tool', `attached tool '${tool.name}' (${tool.slug}, ${tool.type})${stepAttached ? ` to step '${stepAttached}'` : ''}`);
  return { ok: true, tool: { slug: tool.slug, name: tool.name, type: tool.type }, attachedToStep: stepAttached };
}

// ── Package snapshot / versioning ─────────────────────────────────────────────

// Capture the whole package as a process_package ObjectVersion and bump
// Process.version (decision 3b: version at both package and object level).
// On `initial` (the finalize of a fresh build) we record at the CURRENT version
// (v1) without bumping — that's the package's birth snapshot.
async function snapshotPackage(slug, { note = '', initial = false } = {}, actor) {
  const process = await loadProcess(slug);
  const newVersion = initial ? process.version : process.version + 1;
  const snapshot = {
    process: { name: process.name, slug: process.slug, description: process.description, frequency: process.frequency, mode: process.mode },
    steps: process.steps.map((s) => ({ order: s.order, key: s.key, name: s.name, decisionType: s.decisionType, dependsOn: s.dependsOn, feedbackTo: s.feedbackTo, isGate: s.isGate, pauseAfter: s.pauseAfter, engineSource: s.engineSource, version: s.version })),
    policies: process.policies.map((p) => ({ key: p.key, name: p.name, scope: p.scope, params: p.params, version: p.version })),
    tools: process.tools.map((pt) => ({ slug: pt.tool.slug, type: pt.tool.type, role: pt.role })),
  };
  if (!initial) await prisma.process.update({ where: { id: process.id }, data: { version: newVersion } });
  const version = await recordVersion('process_package', process.id, newVersion, { note, initial, snapshot }, actor);
  await logBuild(process, 'snapshot_package', `${initial ? 'born at' : 'froze'} package v${newVersion}${note ? ` — ${note}` : ''} (${snapshot.steps.length} steps, ${snapshot.policies.length} policies)`);
  return { ok: true, packageVersion: newVersion, versionId: version.id, steps: snapshot.steps.length, policies: snapshot.policies.length };
}

// Seed the owner agent's `context` AgentDocument from the built package — the
// agent's DB-as-truth knowledge of what it owns (decision 7). Regenerated whole
// each time so it always mirrors the current package.
async function seedAgentContext(slug) {
  const process = await loadProcess(slug);
  if (!process.agentId) return null;
  const stepLines = process.steps.map((s) => {
    const deps = (s.dependsOn || []).length ? ` ← [${s.dependsOn.join(', ')}]` : '';
    const fb = s.feedbackTo ? ` ⟲ proposes changes to ${s.feedbackTo}` : '';
    const gate = s.isGate ? ' [GATE]' : '';
    const eng = s.engineSource ? ` · engine: ${s.engineSource}` : '';
    return `  ${s.order}. ${s.name} (${s.key}, ${s.decisionType})${gate}${deps}${fb}${eng}`;
  }).join('\n');
  const policyLines = process.policies.map((p) => `  - ${p.name} (${p.key}, v${p.version}): ${p.definition || ''} params=${JSON.stringify(p.params || {})}`).join('\n');
  const toolLines = process.tools.map((pt) => `  - ${pt.tool.name} (${pt.tool.slug}, ${pt.tool.type})${pt.role ? ` [${pt.role}]` : ''}`).join('\n');
  const content = `# Package context — ${process.name} (v${process.version})
This is the package you own and engineer. ${process.description || ''}
Frequency: ${process.frequency}. Mode: ${process.mode}.

## Steps (the DAG)
${stepLines || '  (none)'}

## Policies
${policyLines || '  (none)'}

## Tools
${toolLines || '  (none)'}
`;
  const existing = await prisma.agentDocument.findUnique({
    where: { agentId_docType_docKey: { agentId: process.agentId, docType: 'context', docKey: 'package' } },
  }).catch(() => null);
  if (existing) {
    return prisma.agentDocument.update({ where: { id: existing.id }, data: { content } });
  }
  return prisma.agentDocument.create({
    data: { agentId: process.agentId, docType: 'context', docKey: 'package', content },
  });
}

module.exports = {
  createStep, updateStep, reorderSteps, setEngine,
  createPolicy, updatePolicy, attachTool, snapshotPackage, seedAgentContext,
  loadProcess, agentSlugFor,
};
