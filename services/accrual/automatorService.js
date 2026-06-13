// Process automator — the AI that constructs a process from a brief.
//
// Give it a plain-language description of a finance process (plus any pasted
// source documents) and it proposes a full blueprint: definition, steps,
// policies, and tool bindings. The operator reviews the proposal, then applies
// it. Apply goes through configService.js — the same path the UI forms and the
// REST/MCP surface use — so an AI-built process is identical to a hand-built one.
//
// Two phases:
//   propose(brief)   -> ask clarifying questions OR return { ready, blueprint }
//   apply(blueprint) -> create/update the process via configService

const prisma = require('../db');
const { decrypt } = require('../encryption');
const { getProviderByName } = require('../llm');
const { createProcess, SUBFUNCTIONS } = require('./processService');
const cfg = require('./configService');

const SCOPES = ['whole', 'definition', 'steps', 'policies', 'tools'];

async function resolveLlm() {
  const config = await prisma.llmConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
  const provider = config?.provider || 'anthropic';
  const model = config?.model || 'claude-sonnet-4-6';
  let apiKey = null;
  const stored = await prisma.llmApiKey.findUnique({ where: { provider } }).catch(() => null);
  if (stored) apiKey = decrypt(stored.encryptedKey);
  if (!apiKey) {
    const envMap = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_API_KEY' };
    apiKey = process.env[envMap[provider]] || null;
  }
  return { provider, model, apiKey };
}

// The blueprint contract the model must emit. Tools are referenced by registry
// slug (resolved to ids at apply time). House rule: no em dashes in any output.
function buildSystemPrompt({ scope, tools, subfunctions }) {
  const toolList = tools.map((t) => `  - ${t.slug} (${t.type}): ${t.name}`).join('\n');
  const fnList = subfunctions.map((s) => `  - ${s.slug}: ${s.name}`).join('\n');
  const scopeLine = scope === 'whole'
    ? 'Build the WHOLE process: definition, steps, policies, tools, and improve trigger.'
    : `Focus ONLY on the "${scope}" section. Leave the other blueprint sections as null.`;

  return `You are the Ridgeline Finance OS Process Automator. You turn a finance process brief into a structured process blueprint that the platform can persist.

THE MODEL. A Process has:
  - definition: name, description, frequency (e.g. "monthly"), mode (auto | adhoc | manual), functionSlug (the finance sub-function it belongs to).
  - steps[]: the ordered checklist the process runs each period. Each step has name, description, decisionType (policy_based = rule-driven, judgment_based = needs estimation/AI, mixed), engineSource (a code/service file if one runs it, else null), isGate (true if it is a materiality/approval gate), pauseAfter (true if the run pauses for a human after this step).
  - policies[]: the rules and tunable parameters. Each has name, definition (plain English), and params (a flat object of typed key/values like thresholds, account codes, windows).
  - tools[]: bindings to the global tool registry, referenced by slug.
  - improve: { mode: auto | manual, lookbackRuns: integer } controlling the continuous-improvement loop.

FINANCE SUB-FUNCTIONS (functionSlug must be one of these):
${fnList}

TOOL REGISTRY (reference tools by these slugs only):
${toolList}

YOUR TASK. ${scopeLine}

CONVERSATION STYLE. If the brief is missing something important (cadence, the booking accounts, materiality threshold, which sub-function), ask ONE concise round of clarifying questions and set ready=false. Once you have enough to produce a solid first draft, set ready=true and include the blueprint. A good first draft is better than endless questions: when in doubt, propose sensible defaults and note your assumptions in the message.

HARD RULES.
  - Never use em dashes anywhere in your output. Use commas, periods, or parentheses.
  - Respond with ONE valid JSON object and NOTHING else. No markdown fences, no prose outside the JSON.
  - decisionType is one of: policy_based, judgment_based, mixed.
  - mode is one of: auto, adhoc, manual. improve.mode is one of: auto, manual.
  - Only reference tool slugs from the registry above. If none fit, use an empty tools array.

RESPONSE SHAPE (emit exactly this object):
{
  "message": "Your reply to the operator: questions, or a summary of what you built and your assumptions.",
  "ready": true | false,
  "scope": "${scope}",
  "blueprint": {
    "definition": { "name": "...", "description": "...", "frequency": "monthly", "mode": "manual", "functionSlug": "gl-close" } | null,
    "steps": [ { "name": "...", "description": "...", "decisionType": "policy_based", "engineSource": null, "isGate": false, "pauseAfter": false } ] | null,
    "policies": [ { "name": "...", "definition": "...", "params": { "materialityThreshold": 1500 } } ] | null,
    "tools": [ { "slug": "calibration-engine", "role": null } ] | null,
    "improve": { "mode": "auto", "lookbackRuns": 6 } | null
  } | null
}
When ready is false, blueprint should be null.`;
}

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch (_) { /* fall through */ }
  // Tolerate a fenced block or surrounding prose: grab the outermost {...}.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  try { return JSON.parse(trimmed.slice(first, last + 1)); } catch (_) { return null; }
}

// Strip em dashes defensively in case the model slips (house rule).
function deEm(s) {
  return typeof s === 'string' ? s.replace(/\s*[\u2014\u2013]\s*/g, ', ') : s;
}

function sanitizeBlueprint(bp) {
  if (!bp || typeof bp !== 'object') return null;
  const out = {};
  if (bp.definition) {
    out.definition = {
      name: deEm(bp.definition.name),
      description: deEm(bp.definition.description),
      frequency: bp.definition.frequency || 'monthly',
      mode: ['auto', 'adhoc', 'manual'].includes(bp.definition.mode) ? bp.definition.mode : 'manual',
      functionSlug: bp.definition.functionSlug || null,
    };
  }
  if (Array.isArray(bp.steps)) {
    out.steps = bp.steps.map((s) => ({
      name: deEm(s.name),
      description: deEm(s.description),
      decisionType: ['policy_based', 'judgment_based', 'mixed'].includes(s.decisionType) ? s.decisionType : 'policy_based',
      engineSource: s.engineSource || null,
      isGate: !!s.isGate,
      pauseAfter: !!s.pauseAfter,
    })).filter((s) => s.name);
  }
  if (Array.isArray(bp.policies)) {
    out.policies = bp.policies.map((p) => ({
      name: deEm(p.name),
      definition: deEm(p.definition),
      params: p.params && typeof p.params === 'object' ? p.params : {},
    })).filter((p) => p.name);
  }
  if (Array.isArray(bp.tools)) {
    out.tools = bp.tools.map((t) => ({ slug: t.slug, role: t.role || null })).filter((t) => t.slug);
  }
  if (bp.improve) {
    out.improve = {
      mode: ['auto', 'manual'].includes(bp.improve.mode) ? bp.improve.mode : 'auto',
      lookbackRuns: Math.max(1, parseInt(bp.improve.lookbackRuns, 10) || 6),
    };
  }
  return out;
}

// Phase 1 — propose. messages is the running chat [{role,content}]. attachments
// are pasted source docs [{name, text}] folded into the latest user turn.
async function propose({ messages = [], scope = 'whole', attachments = [] } = {}) {
  if (!SCOPES.includes(scope)) scope = 'whole';
  const { provider, model, apiKey } = await resolveLlm();
  if (!apiKey) {
    return { ready: false, message: 'No LLM API key is configured. Add one under Settings (LLM) or set ANTHROPIC_API_KEY, then try again.', blueprint: null, error: 'no_api_key' };
  }

  const [tools, subfunctions] = await Promise.all([cfg.listTools(), Promise.resolve(cfg.listSubfunctions())]);
  const system = buildSystemPrompt({ scope, tools, subfunctions });

  const chat = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  if (attachments.length) {
    const docBlock = attachments.map((a) => `--- DOCUMENT: ${a.name} ---\n${a.text}`).join('\n\n');
    const lastUser = [...chat].reverse().find((m) => m.role === 'user');
    if (lastUser) lastUser.content += `\n\nAttached source documents:\n${docBlock}`;
    else chat.push({ role: 'user', content: `Attached source documents:\n${docBlock}` });
  }

  const provObj = getProviderByName(provider);
  const result = await provObj.generate([{ role: 'system', content: system }, ...chat], model, apiKey);
  const parsed = extractJson(result.text);
  if (!parsed) {
    return { ready: false, message: deEm(result.text) || 'I could not form a structured proposal. Could you restate the process you want to build?', blueprint: null };
  }
  const ready = !!parsed.ready && !!parsed.blueprint;
  return {
    ready,
    message: deEm(parsed.message) || (ready ? 'Here is the proposed process. Review it, then apply.' : 'Tell me a bit more so I can draft this.'),
    blueprint: ready ? sanitizeBlueprint(parsed.blueprint) : null,
    scope,
  };
}

// Phase 2 — apply. Persists the blueprint. With no slug, creates a fresh process
// and replaces its starter steps/policies with the blueprint. With a slug, the
// sections present in the blueprint REPLACE the existing ones on that process.
async function apply({ blueprint, slug } = {}) {
  const bp = sanitizeBlueprint(blueprint);
  if (!bp) throw Object.assign(new Error('No blueprint to apply.'), { status: 400 });

  let targetSlug = slug;
  let created = false;
  if (!targetSlug) {
    const name = bp.definition?.name;
    if (!name) throw Object.assign(new Error('Blueprint needs a definition.name to create a process.'), { status: 400 });
    const proc = await createProcess({
      name,
      functionSlug: bp.definition.functionSlug || undefined,
      frequency: bp.definition.frequency,
      mode: bp.definition.mode,
      description: bp.definition.description || '',
      template: 'blank',
    });
    targetSlug = proc.slug;
    created = true;
  }

  // Definition (skip the fields createProcess already set on a fresh build, but a
  // patch is harmless and keeps slug-targeted edits working).
  if (bp.definition) {
    await cfg.updateDefinition(targetSlug, bp.definition);
  }
  if (bp.improve) {
    await cfg.updateImproveTrigger(targetSlug, bp.improve);
  }

  // Steps: replace the full list with the blueprint's.
  if (bp.steps) {
    const current = await cfg.getProcessConfig(targetSlug);
    for (const s of current.steps) await cfg.deleteStep(targetSlug, s.id);
    for (const s of bp.steps) await cfg.addStep(targetSlug, s);
  }

  // Policies: replace the full list.
  if (bp.policies) {
    const current = await cfg.getProcessConfig(targetSlug);
    for (const p of current.policies) await cfg.deletePolicy(targetSlug, p.id);
    for (const p of bp.policies) await cfg.addPolicy(targetSlug, p);
  }

  // Tools: resolve slugs to ids, replace mappings.
  if (bp.tools) {
    const registry = await cfg.listTools();
    const bySlug = new Map(registry.map((t) => [t.slug, t.id]));
    const current = await cfg.getProcessConfig(targetSlug);
    for (const pt of current.tools) await cfg.unmapTool(targetSlug, pt.toolId);
    for (const t of bp.tools) {
      const toolId = bySlug.get(t.slug);
      if (toolId) await cfg.mapTool(targetSlug, { toolId, role: t.role });
    }
  }

  const config = await cfg.getProcessConfig(targetSlug);
  return { slug: targetSlug, created, config };
}

module.exports = { propose, apply, SCOPES };
