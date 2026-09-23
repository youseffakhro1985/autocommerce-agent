/**
 * Durable scheduler (section 20). Postgres advisory locks => safe with N worker replicas; job_runs table => restart-safe.
 * Every job is idempotent (unique keys / state machines), so a double run cannot double-order.
 */
import { db } from './db/pool.js';
import { runResearch } from './agents/research.js';
import { runSourcing } from './agents/sourcing.js';
import { runEvaluation } from './agents/evaluation.js';
import { runListing } from './agents/listing.js';
import { runInventory } from './agents/inventory.js';
import { runPricing } from './agents/pricing.js';
import { runOrderCycle, syncTracking, reconcileSupplierOrders } from './agents/orders.js';
import { runHealth } from './agents/health.js';
import { runReturns } from './agents/support.js';
import { runDailyReport, runWeeklyStrategy } from './agents/reports.js';
import { runSelfCheck, runFx } from './agents/ops.js';

export interface JobDef { name: string; everyMin: number; timeoutMin: number; run: () => Promise<unknown>; when?: () => boolean }

const isMondayMorning = () => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date());
  return p.find((x) => x.type === 'weekday')?.value === 'Mon' && Number(p.find((x) => x.type === 'hour')?.value) >= 7;
};

export const JOBS: JobDef[] = [
  { name: 'ops.selfcheck', everyMin: 30, timeoutMin: 5, run: runSelfCheck },
  { name: 'ops.fx', everyMin: 360, timeoutMin: 5, run: runFx },
  { name: 'orders.cycle', everyMin: 5, timeoutMin: 10, run: runOrderCycle },           // + webhook-triggered
  { name: 'orders.reconcile', everyMin: 10, timeoutMin: 5, run: reconcileSupplierOrders },
  { name: 'orders.tracking', everyMin: 30, timeoutMin: 10, run: syncTracking },
  { name: 'inventory.sync', everyMin: 15, timeoutMin: 10, run: runInventory },
  { name: 'pricing.reprice', everyMin: 60, timeoutMin: 15, run: runPricing },
  { name: 'research.discover', everyMin: 360, timeoutMin: 30, run: () => runResearch() }, // 4×/day
  { name: 'sourcing.match', everyMin: 360, timeoutMin: 30, run: runSourcing },
  { name: 'evaluation.run', everyMin: 60, timeoutMin: 20, run: () => runEvaluation() },
  { name: 'listing.publish', everyMin: 60, timeoutMin: 20, run: runListing },
  { name: 'health.check', everyMin: 240, timeoutMin: 15, run: runHealth },
  { name: 'support.returns', everyMin: 60, timeoutMin: 10, run: runReturns },
  { name: 'reports.daily', everyMin: 30, timeoutMin: 10, run: () => runDailyReport() },  // self-dedupes per day
  { name: 'reports.weekly', everyMin: 60, timeoutMin: 10, run: runWeeklyStrategy, when: isMondayMorning },
];

function lockId(name: string) { let h = 0; for (const ch of name) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0; return h; }

export async function runJob(job: JobDef, force = false): Promise<'OK' | 'FAILED' | 'SKIPPED' | 'LOCKED' | 'NOT_DUE'> {
  const client = await db().connect();
  try {
    const got = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [lockId(job.name)])).rows[0].ok;
    if (!got) return 'LOCKED';
    try {
      if (!force) {
        const last = (await client.query(`SELECT started_at, status FROM job_runs WHERE job=$1 AND status IN ('OK','FAILED') ORDER BY started_at DESC LIMIT 1`, [job.name])).rows[0];
        const backoff = last?.status === 'FAILED' ? Math.min(job.everyMin, 5) : job.everyMin; // retry failed jobs sooner
        if (last && Date.now() - new Date(last.started_at).getTime() < backoff * 60_000) return 'NOT_DUE';
        if (job.when && !job.when()) return 'NOT_DUE';
      }
      // Mark runs orphaned by a crash as FAILED so they are visible.
      await client.query(`UPDATE job_runs SET status='FAILED', error='orphaned (process restart)', finished_at=now() WHERE job=$1 AND status='RUNNING'`, [job.name]);
      const id = (await client.query(`INSERT INTO job_runs(job) VALUES ($1) RETURNING id`, [job.name])).rows[0].id;
      try {
        // Timeout is reported (alert via self-check) but the lock is held until the job really finishes,
        // so a slow job can never overlap with its next run.
        const timer = setTimeout(() => console.error(`[job ${job.name}] exceeded ${job.timeoutMin} min`), job.timeoutMin * 60_000);
        const summary = await job.run().finally(() => clearTimeout(timer));
        const skipped = summary && typeof summary === 'object' && 'skipped' in (summary as object);
        await client.query(`UPDATE job_runs SET status=$2, finished_at=now(), summary=$3 WHERE id=$1`, [id, skipped ? 'SKIPPED' : 'OK', JSON.stringify(summary ?? null)]);
        return skipped ? 'SKIPPED' : 'OK';
      } catch (e: any) {
        await client.query(`UPDATE job_runs SET status='FAILED', finished_at=now(), error=$2 WHERE id=$1`, [id, String(e?.stack ?? e).slice(0, 2000)]);
        console.error(`[job ${job.name}] failed:`, e?.message);
        return 'FAILED';
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId(job.name)]);
    }
  } finally {
    client.release();
  }
}

/** Sequential run of all due jobs (used by tests / simulation). */
export async function tick() {
  for (const j of JOBS) await runJob(j);
}

/**
 * Worker mode: jobs run concurrently (max MAX_PARALLEL) so a long research run never delays order handling.
 * Each job holds a Postgres advisory lock for its whole duration — no two replicas run the same job.
 */
const running = new Set<string>();
const MAX_PARALLEL = 5;
export function tickConcurrent() {
  for (const j of JOBS) {
    if (running.has(j.name) || running.size >= MAX_PARALLEL) continue;
    running.add(j.name);
    runJob(j).catch((e) => console.error(`[job ${j.name}]`, e?.message)).finally(() => running.delete(j.name));
  }
}
export function runningJobs() { return [...running]; }
