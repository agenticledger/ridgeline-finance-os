const { executeRun, getRun, signOff } = require('../services/accrual/runService');
(async () => {
  const r = await executeRun({ period: 'April 2026', mode: 'manual' });
  console.log('executeRun ->', r);
  const full = await getRun(r.runId);
  console.log('status:', full.status, '| frozen:', full.frozen, '| total:', full.totalAccrual);
  console.log('steps:', full.steps.map(s => `${s.order}.${s.key}=${s.status}`).join('  '));
  console.log('lines:', full.lines.length, '| exceptions:', full.exceptions.length, '| events:', full.events.length);
  const postStep = full.steps.find(s => s.key === 'post_je');
  console.log('post_je status:', postStep.status, '| posted:', postStep.outcome.posted);
  const so = await signOff(r.runId, { actor: 'M. Chen (Controller)', note: 'Reviewed bands; comfortable booking.' });
  console.log('signOff ->', so);
  const after = await getRun(r.runId);
  console.log('after sign-off status:', after.status, '| post_je:', after.steps.find(s=>s.key==='post_je').status);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
