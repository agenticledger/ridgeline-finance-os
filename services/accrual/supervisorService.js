// Proactive supervision — the part of "the agent can act on crons."
//
// A Process Owner Agent is a supervisor, not in the critical path, but with a
// schedule it can act: kick off a run when one is due, and nudge a run that has been
// stuck awaiting a human. tick() is deterministic and idempotent-by-period: it never
// double-runs a period and it throttles nudges. The internal scheduler in server.js
// calls tick() for active processes; the same logic is exposed over REST + MCP so an
// external cron (or the agent itself) can drive it.

const prisma = require('../db');
const runService = require('./runService');

const NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // don't renudge a stuck gate more than every 6h

// Has a run already executed for this period?
async function runExistsForPeriod(processId, period) {
  const r = await prisma.accrualRun.findFirst({ where: { processId, period } });
  return !!r;
}

// One supervision tick for a single process.
async function tick(slug, { now = new Date() } = {}) {
  const process = await prisma.process.findFirst({ where: { slug } });
  if (!process) return { slug, skipped: 'process-not-found' };

  const actions = [];
  const runs = await runService.listRuns(slug);
  const latest = runs[0] || null;
  const engineBound = slug === runService.PROCESS_SLUG;

  // 1. Auto-run when due: mode=auto, engine-bound, and no run for the target period.
  const targetPeriod = (process.improveTrigger && process.improveTrigger.period) || 'April 2026';
  if (process.mode === 'auto' && engineBound) {
    const exists = await runExistsForPeriod(process.id, targetPeriod);
    if (!exists) {
      const r = await runService.executeRun({ period: targetPeriod, mode: 'auto', actor: 'Owner Agent (scheduler)' });
      actions.push({ type: 'auto_run', period: targetPeriod, runId: r.runId, status: r.status, autoPosted: r.autoPosted });
      return { slug, actions };
    }
  }

  // 2. Nudge a stuck gate: latest run awaiting a human, throttled.
  if (latest && (latest.status === 'awaiting_human' || latest.status === 'needs_review')) {
    const recentNudge = await prisma.ledgerEvent.findFirst({
      where: { runId: latest.id, action: 'SUPERVISOR_NUDGE' },
      orderBy: { createdAt: 'desc' },
    });
    const due = !recentNudge || (now - new Date(recentNudge.createdAt)) > NUDGE_COOLDOWN_MS;
    if (due) {
      await prisma.ledgerEvent.create({
        data: {
          runId: latest.id, actor: 'Owner Agent (scheduler)', action: 'SUPERVISOR_NUDGE',
          detail: { message: `Run for ${latest.period} has been awaiting sign-off. The journal entry is staged but not posted. A controller needs to review and sign off.`, status: latest.status },
        },
      });
      actions.push({ type: 'nudge', runId: latest.id, period: latest.period, status: latest.status });
    }
  }

  return { slug, actions, latest: latest ? { runId: latest.id, period: latest.period, status: latest.status } : null };
}

// Tick every active process (the scheduler entry point).
async function tickAll(opts = {}) {
  const processes = await prisma.process.findMany({ where: { isActive: true }, select: { slug: true } });
  const results = [];
  for (const p of processes) {
    try { results.push(await tick(p.slug, opts)); }
    catch (e) { results.push({ slug: p.slug, error: e.message }); }
  }
  return results;
}

let timer = null;
function startScheduler({ intervalMs = 15 * 60 * 1000 } = {}) {
  if (timer) return timer;
  // Defer first tick so the server finishes booting and seeds.
  timer = setInterval(() => {
    tickAll().then((r) => {
      const acted = r.filter((x) => x.actions && x.actions.length);
      if (acted.length) console.log('[supervisor] tick acted on', acted.map((x) => x.slug).join(', '));
    }).catch((e) => console.error('[supervisor] tick error:', e.message));
  }, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[supervisor] scheduler started (every ${Math.round(intervalMs / 60000)}m)`);
  return timer;
}

module.exports = { tick, tickAll, startScheduler };
