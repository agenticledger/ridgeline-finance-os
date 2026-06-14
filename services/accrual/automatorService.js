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
const builder = require('../builder/processBuilder');
const runService = require('./runService');

const SCOPES = ['whole', 'definition', 'steps', 'policies', 'tools'];

// Match builder's key derivation so dependsOn/feedbackTo name references resolve
// to the same keys the builder assigns when it creates the steps.
function keyFromName(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

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
  - steps[]: the ordered checklist the process runs each period. Each step has name, description, decisionType (policy_based = rule-driven, judgment_based = needs estimation/AI, mixed), engineSource (a code/service file if one runs it, else null), isGate (true if it is a materiality/approval gate), pauseAfter (true if the run pauses for a human after this step), dependsOn (array of the NAMES of earlier steps whose output this step consumes, forming the data-flow DAG), and feedbackTo (the NAME of an earlier step this step proposes changes back to, e.g. a reconcile step feeding a calibration step; null if none).
  - policies[]: the rules and tunable parameters. Each has name, definition (plain English), and params (a flat object of typed key/values like thresholds, account codes, windows).
  - tools[]: bindings to the global tool registry, referenced by slug.
  - improve: { mode: auto | manual, lookbackRuns: integer } controlling the continuous-improvement loop.

HOW A RUN'S OUTPUT IS STRUCTURED (the overview). Every process renders the SAME templatized overview, regardless of type. After the status band (headline, KPI tiles, AI insight, action items) the page is three role-based zones, and an engine that emits its own overview must shape its result into them:
  - ANALYSIS: the working that justifies the number (the evidence, the breakdowns, the intermediate tables).
  - RESULT: the single artifact the process exists to hand off (the journal entry, the report, the forecast). One process, one primary deliverable. If no engine is bound to the posting step, RESULT is empty and the template shows an honest empty state.
  - OTHER DETAILS: optional appendix (provenance, run parameters, drill-in links). Renders nothing when empty.
Each zone is an ordered array of typed BLOCKS. A block is { kind, title, sub, ...payload } where kind is one of: "table" (columns[]+rows[]), "journal" (a balanced JE: status, date, lines[], total), "notes" (labelled bullets), "keyvalue" (label/value pairs), "links" (buttons). A table can live in ANY zone, the engine decides placement by which array it puts the block in. When you design or describe a process, be clear about what its RESULT artifact is (the one thing it produces) versus what belongs in ANALYSIS (the supporting working).

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
    "steps": [ { "name": "...", "description": "...", "decisionType": "policy_based", "engineSource": null, "isGate": false, "pauseAfter": false, "dependsOn": [], "feedbackTo": null } ] | null,
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
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(deEm).filter(Boolean) : [],
      feedbackTo: s.feedbackTo ? deEm(s.feedbackTo) : null,
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

// Build the EDIT-mode context: the current package plus a compact summary of the
// runs the operator selected to evaluate, and their optional focus. This is what
// turns "create" into "edit/improve" — same agent, same blueprint contract, but
// grounded in what the process already is and how its recent runs actually went.
async function buildEditContext(slug, runIds = [], focus = '') {
  const cfgObj = await cfg.getProcessConfig(slug).catch(() => null);
  const lines = [];
  if (cfgObj) {
    lines.push(`CURRENT PACKAGE — ${cfgObj.name} (${cfgObj.frequency} · ${cfgObj.mode}${cfgObj.function ? ` · ${cfgObj.function.slug}` : ''})`);
    if (cfgObj.description) lines.push(`  ${cfgObj.description}`);
    lines.push('  Steps:');
    (cfgObj.steps || []).forEach((s) => {
      const tags = [s.decisionType, s.isGate ? 'gate' : null, s.pauseAfter ? 'pause' : null, s.engineSource ? `engine:${s.engineSource}` : null].filter(Boolean).join(', ');
      lines.push(`    ${s.order}. ${s.name} (${tags})`);
      (s.policies || []).forEach((p) => lines.push(`        policy ${p.key} v${p.version} params=${JSON.stringify(p.params || {})}`));
    });
    if ((cfgObj.policies || []).length) {
      lines.push('  Process-scope policies:');
      cfgObj.policies.forEach((p) => lines.push(`    ${p.key} v${p.version} params=${JSON.stringify(p.params || {})}`));
    }
    if ((cfgObj.tools || []).length) lines.push(`  Tools: ${cfgObj.tools.map((t) => t.slug).filter(Boolean).join(', ')}`);
  }

  const runs = [];
  for (const id of (runIds || [])) {
    const r = await runService.getRun(id).catch(() => null);
    if (r) runs.push(r);
  }
  if (runs.length) {
    lines.push('', `SELECTED RUNS TO EVALUATE (${runs.length}):`);
    runs.forEach((r) => {
      const sum = r.summary || {};
      const carriers = sum.carriers || [];
      const exCount = (r.exceptions || []).length;
      const openItems = (r.actionItems || []).filter((a) => a.status === 'open').length;
      const totalItems = (r.actionItems || []).length;
      lines.push(`  - ${r.period} · ${r.status} · total ${r.totalAccrual != null ? '$' + Math.round(r.totalAccrual).toLocaleString('en-US') : 'n/a'} · ${exCount} exception(s) · ${openItems}/${totalItems} action items open`);
      carriers.slice(0, 6).forEach((c) => {
        if (c.denise != null && c.point != null) {
          const diff = c.point - c.denise;
          lines.push(`      ${c.label || c.key}: point ${Math.round(c.point)}, Denise ${Math.round(c.denise)}, delta ${diff >= 0 ? '+' : ''}${Math.round(diff)}${c.actual != null ? `, actual ${Math.round(c.actual)}` : ''}`);
        }
      });
    });
  }

  lines.push('', `OPERATOR FOCUS: ${focus && focus.trim() ? focus.trim() : '(none — use your judgment on what to improve)'}`);
  return lines.join('\n');
}

// Phase 1 — propose. messages is the running chat [{role,content}]. attachments
// are pasted source docs [{name, text}] folded into the latest user turn. When a
// slug is supplied the call is in EDIT mode: the current package and the selected
// runs are injected as grounding so the same agent proposes improvements.
async function propose({ messages = [], scope = 'whole', attachments = [], slug = null, runIds = [], focus = '' } = {}) {
  if (!SCOPES.includes(scope)) scope = 'whole';
  const { provider, model, apiKey } = await resolveLlm();
  if (!apiKey) {
    return { ready: false, message: 'No LLM API key is configured. Add one under Settings (LLM) or set ANTHROPIC_API_KEY, then try again.', blueprint: null, error: 'no_api_key' };
  }

  const [tools, subfunctions] = await Promise.all([cfg.listTools(), Promise.resolve(cfg.listSubfunctions())]);
  let system = buildSystemPrompt({ scope, tools, subfunctions });

  const chat = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  if (attachments.length) {
    const docBlock = attachments.map((a) => `--- DOCUMENT: ${a.name} ---\n${a.text}`).join('\n\n');
    const lastUser = [...chat].reverse().find((m) => m.role === 'user');
    if (lastUser) lastUser.content += `\n\nAttached source documents:\n${docBlock}`;
    else chat.push({ role: 'user', content: `Attached source documents:\n${docBlock}` });
  }

  if (slug) {
    const editCtx = await buildEditContext(slug, runIds, focus);
    system += `\n\nEDIT MODE. You are improving an EXISTING process, not building a new one. Below is the current package and the runs the operator chose to evaluate. Propose concrete, justified improvements to the steps, policies, engines, or tools. In the blueprint, return the FULL updated set for any section you change (the whole steps array, the whole policies array, etc.) and keep the parts you are not changing intact. Tie each change back to evidence in the runs or the operator's focus.\n\n${editCtx}`;
    if (!chat.some((m) => m.role === 'user')) {
      chat.push({ role: 'user', content: focus && focus.trim() ? `Evaluate the selected runs and suggest improvements. Focus: ${focus.trim()}` : 'Evaluate the selected runs and suggest improvements.' });
    }
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

// Phase 2 — apply. Creation is AGENTIC-ONLY (decision §14.8): the process is born
// together with its owner agent, and the blueprint is realized through the owner
// agent's Builder tools so every step/policy/tool is versioned (ObjectVersion,
// source 'agent') and written to the agent's build_log. On finalize we cut the
// package's v1 snapshot and seed the agent's context document. (A slug-targeted
// edit re-applies the sections present in the blueprint to an existing process.)
async function apply({ blueprint, slug } = {}) {
  const bp = sanitizeBlueprint(blueprint);
  if (!bp) throw Object.assign(new Error('No blueprint to apply.'), { status: 400 });

  if (!slug) return applyCreate(bp);
  return applyEdit(slug, bp);
}

// Fresh build — through the builder, finalized as package v1.
async function applyCreate(bp) {
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
  const slug = proc.slug;
  const actor = 'Owner Agent (Builder, automator)';

  if (bp.improve) await cfg.updateImproveTrigger(slug, bp.improve);

  // Realize the blueprint via the builder. Steps first (clearing the blank
  // starters), so dependsOn/feedbackTo name references resolve to created keys.
  if (bp.steps && bp.steps.length) {
    const existing = await cfg.getProcessConfig(slug);
    for (const s of existing.steps) await cfg.deleteStep(slug, s.id);
    const nameToKey = new Map(bp.steps.map((s) => [s.name, keyFromName(s.name)]));
    const created = new Set();
    for (const s of bp.steps) {
      const dependsOn = (s.dependsOn || []).map((n) => nameToKey.get(n) || keyFromName(n)).filter((k) => created.has(k));
      const feedbackTo = s.feedbackTo ? (nameToKey.get(s.feedbackTo) || keyFromName(s.feedbackTo)) : null;
      await builder.createStep(slug, {
        name: s.name, description: s.description, decisionType: s.decisionType,
        dependsOn, feedbackTo: feedbackTo && created.has(feedbackTo) ? feedbackTo : null,
        isGate: s.isGate, pauseAfter: s.pauseAfter, engineSource: s.engineSource,
      }, actor);
      created.add(keyFromName(s.name));
    }
  }

  if (bp.policies && bp.policies.length) {
    const existing = await cfg.getProcessConfig(slug);
    for (const p of existing.policies) await cfg.deletePolicy(slug, p.id);
    for (const p of bp.policies) {
      await builder.createPolicy(slug, { name: p.name, definition: p.definition, params: p.params }, actor);
    }
  }

  if (bp.tools && bp.tools.length) {
    for (const t of bp.tools) {
      await builder.attachTool(slug, { toolSlug: t.slug, role: t.role }, actor).catch(() => {});
    }
  }

  // Finalize: birth snapshot (package v1) + seed the agent's package context.
  await builder.snapshotPackage(slug, { note: 'Initial agentic build', initial: true }, actor);
  await builder.seedAgentContext(slug);

  const config = await cfg.getProcessConfig(slug);
  return { slug, created: true, config };
}

// Slug-targeted edit — re-apply the present sections to an existing process.
async function applyEdit(slug, bp) {
  if (bp.definition) await cfg.updateDefinition(slug, bp.definition);
  if (bp.improve) await cfg.updateImproveTrigger(slug, bp.improve);
  if (bp.steps) {
    const current = await cfg.getProcessConfig(slug);
    for (const s of current.steps) await cfg.deleteStep(slug, s.id);
    const nameToKey = new Map(bp.steps.map((s) => [s.name, keyFromName(s.name)]));
    const created = new Set();
    for (const s of bp.steps) {
      const dependsOn = (s.dependsOn || []).map((n) => nameToKey.get(n) || keyFromName(n)).filter((k) => created.has(k));
      const feedbackTo = s.feedbackTo ? (nameToKey.get(s.feedbackTo) || keyFromName(s.feedbackTo)) : null;
      await builder.createStep(slug, {
        name: s.name, description: s.description, decisionType: s.decisionType,
        dependsOn, feedbackTo: feedbackTo && created.has(feedbackTo) ? feedbackTo : null,
        isGate: s.isGate, pauseAfter: s.pauseAfter, engineSource: s.engineSource,
      }, 'Owner Agent (Builder, automator)');
      created.add(keyFromName(s.name));
    }
  }
  if (bp.policies) {
    const current = await cfg.getProcessConfig(slug);
    for (const p of current.policies) await cfg.deletePolicy(slug, p.id);
    for (const p of bp.policies) await builder.createPolicy(slug, { name: p.name, definition: p.definition, params: p.params }, 'Owner Agent (Builder, automator)');
  }
  if (bp.tools) {
    const registry = await cfg.listTools();
    const bySlug = new Map(registry.map((t) => [t.slug, t.id]));
    const current = await cfg.getProcessConfig(slug);
    for (const pt of current.tools) await cfg.unmapTool(slug, pt.toolId);
    for (const t of bp.tools) { if (bySlug.has(t.slug)) await builder.attachTool(slug, { toolSlug: t.slug, role: t.role }, 'Owner Agent (Builder, automator)').catch(() => {}); }
  }
  await builder.snapshotPackage(slug, { note: 'Agentic edit (automator)' }, 'Owner Agent (Builder, automator)');
  await builder.seedAgentContext(slug);
  const config = await cfg.getProcessConfig(slug);
  return { slug, created: false, config };
}

module.exports = { propose, apply, SCOPES };
