const prisma = require('../services/db');
const { executeRun } = require('../services/accrual/runService');
(async () => {
  await prisma.accrualRun.deleteMany({});
  const r = await executeRun({ period: 'April 2026', mode: 'manual' });
  console.log('Canonical run created:', r.runId, r.status, '$'+r.point);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
