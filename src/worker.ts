/** 24/7 worker process. Restart-safe: state lives in Postgres. */
import { env } from './config/env.js';
import { migrate } from './db/migrate.js';
import { closeDb } from './db/pool.js';
import { tickConcurrent, runningJobs } from './scheduler.js';

let stopping = false;
async function main() {
  const e = env();
  console.log(`[worker] starting in ${e.APP_MODE} mode`);
  await migrate();
  while (!stopping) {
    try { tickConcurrent(); } catch (err: any) { console.error('[worker] tick error', err?.message); }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  while (runningJobs().length) await new Promise((r) => setTimeout(r, 1000)); // let in-flight jobs finish
  await closeDb();
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { console.log('[worker] stopping after current tick'); stopping = true; });
process.on('unhandledRejection', (e) => console.error('[worker] unhandledRejection', e));
main().catch((e) => { console.error(e); process.exit(1); });
