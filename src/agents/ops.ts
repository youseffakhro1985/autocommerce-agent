/** Ops/self-check agent: owner actions for missing credentials, FX refresh, stuck jobs. */
import { many } from '../db/pool.js';
import { raiseAlert, resolveAlert } from '../services/alerts.js';
import { refreshEcbRates } from '../services/fx.js';
import { ctx } from './context.js';

export async function runSelfCheck() {
  const c = await ctx();
  for (const m of c.reg.missing) await raiseAlert({ severity: 'WARNING', category: 'OWNER_ACTION', title: `NEEDS OWNER ACTION: ${m}`, dedupeKey: `missing:${m}`, requiresOwner: true });
  if (!c.s.AUTOMATION_ENABLED) await raiseAlert({ severity: 'INFO', category: 'SYSTEM', title: 'Automation globally disabled (AUTOMATION_ENABLED=false)', dedupeKey: 'kill-switch' });
  else await resolveAlert('kill-switch');
  const failing = await many(`SELECT job FROM (SELECT job, status, row_number() OVER (PARTITION BY job ORDER BY started_at DESC) rn FROM job_runs) x
    WHERE rn <= 3 GROUP BY job HAVING count(*) FILTER (WHERE status='FAILED') = 3`);
  for (const f of failing) await raiseAlert({ severity: 'CRITICAL', category: 'SYSTEM', title: `Job ${f.job} failed 3 times in a row`, dedupeKey: `jobfail:${f.job}` });
  return { missing: c.reg.missing.length, failingJobs: failing.map((f) => f.job) };
}

export async function runFx() {
  const c = await ctx();
  if (c.mode === 'simulation') return { skipped: 'simulation uses fixed FX' };
  return { rates: await refreshEcbRates() };
}
