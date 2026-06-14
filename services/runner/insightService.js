// AI insight for the templatized overview.
//
// The overview dashboard already assembles every process's data into the standard
// slot schema (hero, tiles, action items, table, journal, decision notes). This
// service turns that assembled view into 3-4 executive insight bullets by calling
// the process's Owner Agent with a *summary prompt stored in the tools registry*.
//
//   - One canonical default prompt lives as a `prompt`-type Tool (slug
//     `overview-insights`), lazily upserted so it shows up in the registry.
//   - Any process can override it with its own `<slug>-insights` prompt Tool.
//   - The result is cached on the run (summary.aiInsight) so it doesn't re-bill on
//     every page load; the Generate/Refresh button regenerates it.
//
// This is a READ-ONLY narration layer: the engine owns the numbers, the agent only
// explains them. We never recompute — we hand the model the already-computed values.

const prisma = require('../db');
const { decrypt } = require('../encryption');
const { getProviderForModel } = require('../llm');
const { buildOverview } = require('./overviewBuilder');
const runService = require('../accrual/runService');

const DEFAULT_PROMPT_SLUG = 'overview-insights';

const DEFAULT_PROMPT = `You are producing a short executive insight summary for a finance process overview dashboard. You are given the live, already-computed data for the most recent run — the headline figure, KPI tiles, action items, the primary table, the journal entry, and the decision notes.

Read everything and surface the 3-4 insights a CFO or controller actually cares about: what matters, what changed, what needs attention, and why.

Rules:
- Use ONLY the data provided. Never invent or recompute a number — quote the figures you are given.
- One sentence per bullet. Lead with the signal, then the number.
- Call out anything awaiting a human, any escalation, and how the estimate sits against its benchmark and confidence band.
- This is read-only narration. You are explaining, not deciding — the deterministic engine owns the numbers.
- Output 3-4 markdown bullets starting with "- ". No preamble, no closing line.`;

// ── Formatting (matches overviewBuilder's tags so the serialized view reads right) ─
const fmt0 = (n) => (n == null ? '--' : '$' + Math.round(n).toLocaleString('en-US'));
const fmt2 = (n) => (n == null ? '--' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signed = (n) => (n == null ? '--' : (n >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US'));
const pct = (n) => (n == null ? '--' : (n * 100).toFixed(1) + '%');

function fmtRaw(v, tag) {
  switch (tag) {
    case 'money0': case 'money0strong': return fmt0(v);
    case 'money2': return fmt2(v);
    case 'signed': return signed(v);
    case 'pct': return pct(v);
    case 'num3': return v == null ? '--' : Number(v).toFixed(3);
    default: return v == null ? '--' : String(v);
  }
}

// Flatten the overview slot schema into a compact, model-friendly briefing.
function serializeOverview(ov, run, proc) {
  const lines = [];
  lines.push(`Process: ${proc.name}`);
  if (proc.description) lines.push(proc.description);
  lines.push(`Period: ${run.period} · status ${run.status}${run.frozen ? ' (frozen)' : ''}`);
  lines.push('');
  lines.push('--- OVERVIEW DATA (already computed; do not recompute) ---');

  const h = ov.hero || {};
  if (h.label || h.title) lines.push(`STATUS: ${h.label || ''} — ${h.title || ''}`.trim());
  if (h.figure) {
    lines.push(`HEADLINE: ${h.figure.label} = ${fmtRaw(h.figure.value, h.figure.format)}`
      + (h.figure.sub ? ` (${h.figure.sub})` : '')
      + (h.figure.delta ? ` · ${h.figure.delta.text}` : ''));
  }
  if (h.meta && h.meta.length) lines.push('META: ' + h.meta.map((m) => `${m.label} ${m.value}`).join(' · '));

  if (ov.tiles && ov.tiles.length) {
    lines.push('TILES:');
    ov.tiles.forEach((t) => lines.push(`  - ${t.label}: ${fmtRaw(t.value, t.format)}${t.note ? ` (${t.note})` : ''}`));
  }

  if (ov.actions && ov.actions.items && ov.actions.items.length) {
    lines.push(`ACTION ITEMS (${ov.actions.sub}):`);
    ov.actions.items.forEach((a) => lines.push(`  - [${a.severity}] ${a.title}: ${a.detail}${a.amount != null ? ` ${fmtRaw(a.amount, a.amountFormat)}` : ''}`));
  } else {
    lines.push('ACTION ITEMS: none awaiting a human');
  }

  // Zones are role-based block arrays: analysis (the working), result (the
  // deliverable), details (appendix). Walk each block by kind.
  function serializeBlock(b) {
    if (!b) return;
    if (b.kind === 'table' && b.rows && b.rows.length) {
      const cols = b.columns || [];
      lines.push(`  TABLE — ${b.title}${b.sub ? ` (${b.sub})` : ''}:`);
      b.rows.slice(0, 12).forEach((row) => {
        const cells = cols.map((c) => {
          const v = row[c.key];
          if (c.type === 'band') return `band ${fmtRaw(row.low, 'money0')}-${fmtRaw(row.high, 'money0')}`;
          if (v && typeof v === 'object' && v.label != null) return `${c.label}:${v.label}`;
          return `${c.label}:${fmtRaw(v, c.type)}`;
        });
        lines.push('    - ' + cells.join(' · '));
      });
    } else if (b.kind === 'journal') {
      lines.push(`  JOURNAL — ${b.title || 'Journal entry'}: ${b.status}, balanced total ${fmtRaw(b.total, 'money2')}`);
    } else if (b.kind === 'notes' && b.items && b.items.length) {
      lines.push(`  NOTES — ${b.title}:`);
      b.items.forEach((n) => lines.push(`    - ${n.label}: ${n.body}`));
    } else if (b.kind === 'keyvalue' && b.items && b.items.length) {
      lines.push(`  ${b.title}:`);
      b.items.forEach((it) => lines.push(`    - ${it.label}: ${fmtRaw(it.value, it.format)}${it.note ? ` (${it.note})` : ''}`));
    } else if (b.kind === 'links' && b.items && b.items.length) {
      lines.push(`  ${b.title}: ${b.items.map((l) => l.label).join(' · ')}`);
    }
  }

  if (ov.analysis && ov.analysis.length) {
    lines.push('ANALYSIS (the working that justifies the number):');
    ov.analysis.forEach(serializeBlock);
  }

  lines.push('RESULT (the artifact this run hands off):');
  if (ov.result && ov.result.length) ov.result.forEach(serializeBlock);
  else lines.push('  none — no engine bound to this process\u2019s posting step');

  if (ov.details && ov.details.length) {
    lines.push('OTHER DETAILS (appendix / provenance):');
    ov.details.forEach(serializeBlock);
  }

  return lines.join('\n');
}

// ── Registry: the summary prompt as a first-class Tool ────────────────────────
async function ensureDefaultPromptTool() {
  return prisma.tool.upsert({
    where: { slug: DEFAULT_PROMPT_SLUG },
    update: {}, // never clobber a customized prompt
    create: {
      type: 'prompt',
      name: 'Overview Insights',
      slug: DEFAULT_PROMPT_SLUG,
      description: 'The summary prompt the owner agent runs to turn an overview dashboard into 3-4 executive insight bullets. Global default — a process can override it with its own <slug>-insights prompt.',
      config: { prompt: DEFAULT_PROMPT },
    },
  });
}

async function resolvePromptTool(slug) {
  const override = await prisma.tool.findUnique({ where: { slug: `${slug}-insights` } });
  if (override && override.config && override.config.prompt) return override;
  return ensureDefaultPromptTool();
}

// ── LLM key resolution (self-contained; mirrors routes/chat.js) ───────────────
async function resolveApiKey(provider) {
  const stored = await prisma.llmApiKey.findUnique({ where: { provider } });
  if (stored) return decrypt(stored.encryptedKey);
  const envMap = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_API_KEY' };
  return envMap[provider] ? (process.env[envMap[provider]] ?? null) : null;
}

// Generate (and cache) the AI insight for a run. Returns the insight record.
async function generateInsight({ slug, runId }) {
  const proc = await prisma.process.findFirst({
    where: { slug },
    select: { id: true, name: true, slug: true, description: true, agentId: true },
  });
  if (!proc) { const e = new Error('Process not found'); e.status = 404; throw e; }

  // Resolve the run (explicit, else the latest).
  let id = runId;
  if (!id) {
    const runs = await runService.listRuns(slug);
    id = runs[0] && runs[0].id;
  }
  if (!id) { const e = new Error('No run to summarize yet'); e.status = 400; throw e; }
  const run = await runService.getRun(id);
  if (!run) { const e = new Error('Run not found'); e.status = 404; throw e; }

  const ov = buildOverview({ proc, run, summary: run.summary });
  if (!ov) { const e = new Error('No overview to summarize'); e.status = 400; throw e; }

  const agent = proc.agentId
    ? await prisma.agent.findUnique({ where: { id: proc.agentId }, select: { name: true, defaultModel: true } })
    : null;

  const promptTool = await resolvePromptTool(slug);
  const briefing = serializeOverview(ov, run, proc);

  const system = `${agent ? `You are ${agent.name}. ` : ''}${promptTool.config.prompt}`;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: briefing },
  ];

  const model = (agent && agent.defaultModel) || 'claude-sonnet-4-6';
  const provider = getProviderForModel(model);
  const apiKey = await resolveApiKey(provider.id);
  if (!apiKey) { const e = new Error(`No API key configured for provider: ${provider.id}`); e.status = 500; throw e; }

  const result = await provider.generate(messages, model, apiKey);
  const text = (result.text || '').trim();
  if (!text) { const e = new Error('The agent returned no insight'); e.status = 502; throw e; }

  const insight = {
    text,
    generatedAt: new Date().toISOString(),
    model,
    promptSlug: promptTool.slug,
    promptName: promptTool.name,
  };

  await prisma.accrualRun.update({
    where: { id: run.id },
    data: { summary: { ...(run.summary || {}), aiInsight: insight } },
  });

  return insight;
}

module.exports = { generateInsight, ensureDefaultPromptTool, DEFAULT_PROMPT_SLUG, DEFAULT_PROMPT };
