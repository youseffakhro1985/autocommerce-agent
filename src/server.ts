/** Web process: owner dashboard, approvals, settings, webhooks. */
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from './config/env.js';
import { migrate } from './db/migrate.js';
import { db, one, tx } from './db/pool.js';
import { updateSetting, DEFAULT_SETTINGS } from './domain/settings.js';
import { audit } from './services/audit.js';
import { raiseAlert } from './services/alerts.js';
import { loadDashboard, renderDashboard } from './web/dashboard.js';
import { JOBS, runJob, runDueJobs } from './scheduler.js';

export async function buildServer() {
  const e = env();
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] }, trustProxy: true });
  await app.register(formbody);

  const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

  // No database yet (fresh Vercel project): show a setup page instead of crashing.
  if (!e.DATABASE_URL) {
    app.get('/*', async (_req, reply) => reply.code(503).type('text/html; charset=utf-8').send(setupPage()));
    return app;
  }
  let migrated: Promise<void> | null = null;
  app.addHook('onRequest', async () => { migrated ??= migrate(); await migrated; });

  // Scheduler entry for serverless hosts (Vercel Cron sends Authorization: Bearer $CRON_SECRET; external pingers may use ?secret=).
  app.get<{ Querystring: { secret?: string } }>('/api/cron', async (req, reply) => {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const given = bearer || String(req.query.secret ?? '');
    if (!e.CRON_SECRET || !safeEq(given, e.CRON_SECRET)) return reply.code(401).send({ ok: false });
    return runDueJobs(Number(process.env.CRON_BUDGET_MS ?? 240_000));
  });

  // Public, secret-less heartbeat for external schedulers (GitHub Actions). It can only run jobs that are
  // already due (all idempotent, all spend-limited) and is throttled to one run per 4 minutes.
  app.get('/api/tick', async (_req, reply) => {
    const last = await db().query(`SELECT max(started_at) t FROM job_runs WHERE job='orders.cycle'`);
    const t = last.rows[0]?.t ? new Date(last.rows[0].t).getTime() : 0;
    if (Date.now() - t < 4 * 60_000) return reply.code(202).send({ ok: true, throttled: true });
    const r = await runDueJobs(Number(process.env.CRON_BUDGET_MS ?? 240_000));
    return { ok: true, ms: r.ms, ran: Object.entries(r.results).filter(([, v]) => v === 'OK' || v === 'FAILED').map(([k, v]) => `${k}:${v}`) };
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz' || req.url.startsWith('/webhooks/') || req.url.startsWith('/api/cron') || req.url === '/api/tick') return;
    // Basic auth (HTTPS terminates at the platform). Simulation without password = local only.
    if (e.DASHBOARD_PASSWORD) {
      const h = req.headers.authorization ?? '';
      const [user, pass] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString().split(':');
      if (!h.startsWith('Basic ') || !safeEq(user ?? '', e.DASHBOARD_USER) || !safeEq(pass ?? '', e.DASHBOARD_PASSWORD)) {
        return reply.code(401).header('www-authenticate', 'Basic realm="AutoCommerce"').send('Authentication required');
      }
    } else if (e.APP_MODE !== 'simulation') return reply.code(503).send('DASHBOARD_PASSWORD not configured');
    // CSRF: state-changing requests must originate from this dashboard.
    if (req.method === 'POST') {
      const origin = String(req.headers.origin ?? req.headers.referer ?? '');
      if (origin && !origin.includes(String(req.headers.host))) return reply.code(403).send('Cross-site request blocked');
    }
  });

  app.get('/healthz', async () => {
    await db().query('SELECT 1');
    return { ok: true, mode: e.APP_MODE };
  });

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(renderDashboard(await loadDashboard())));
  app.get('/api/summary', async () => {
    const d = await loadDashboard();
    return { today: d.today, products: d.products, finance30d: d.finance, marketplaces: d.marketplaces, openAlerts: d.alerts.length, approvals: d.approvals.length };
  });

  app.post<{ Body: { key: string; value: string } }>('/settings', async (req, reply) => {
    const { key, value } = req.body;
    const def = (DEFAULT_SETTINGS as any)[key];
    if (!def) return reply.code(400).send('unknown setting');
    const v = typeof def.v === 'boolean' ? value === 'true' : Number(value);
    if (typeof v === 'number' && !Number.isFinite(v)) return reply.code(400).send('invalid number');
    await updateSetting(key, v, 'owner');
    return reply.redirect('/');
  });

  app.post<{ Params: { id: string; decision: string } }>('/approvals/:id/:decision', async (req, reply) => {
    const decision = req.params.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    const a = await one(`UPDATE approval_requests SET status=$2, decided_by='owner', decided_at=now() WHERE id=$1 AND status='PENDING' RETURNING *`, [Number(req.params.id), decision]);
    if (a) {
      await audit('owner', 'approval_requests', a.id, { decision, kind: a.kind, subject: a.subject_ref });
      await db().query(`UPDATE alerts SET resolved_at=now() WHERE dedupe_key=$1 AND resolved_at IS NULL`, [`approval:${a.kind}:${a.subject_ref}`]);
      if (a.kind === 'REFUND' && decision === 'APPROVED') {
        await raiseAlert({ severity: 'WARNING', category: 'OWNER_ACTION', title: `Issue approved refund for ${a.subject_ref} in Seller Central / eBay (refund API not automated yet)`, dedupeKey: `refund-exec:${a.subject_ref}`, requiresOwner: true });
      }
    }
    return reply.redirect('/');
  });

  app.post<{ Params: { id: string } }>('/alerts/:id/resolve', async (req, reply) => {
    await db().query(`UPDATE alerts SET resolved_at=now() WHERE id=$1`, [Number(req.params.id)]);
    await audit('owner', 'alerts', req.params.id, { resolved: true });
    return reply.redirect('/');
  });

  app.post<{ Params: { id: string } }>('/suppliers/:id/verify', async (req, reply) => {
    await tx(async (q) => {
      const s = (await q.query(`UPDATE suppliers SET status='VERIFIED', agreement_signed=true, company_verified=true, blind_dropship=true WHERE id=$1 AND is_wholesaler RETURNING code`, [Number(req.params.id)])).rows[0];
      if (s) {
        await audit('owner', 'suppliers', req.params.id, { verified: true, attested: ['dropshipping agreement signed', 'blind shipping / owner as seller of record', 'company details checked'] }, q);
        await q.query(`UPDATE alerts SET resolved_at=now() WHERE dedupe_key=$1 AND resolved_at IS NULL`, [`verify-supplier:${s.code}`]);
      }
    });
    return reply.redirect('/');
  });

  app.post<{ Params: { code: string } }>('/marketplaces/:code/resume', async (req, reply) => {
    await db().query(`UPDATE marketplaces SET automation_state='ACTIVE' WHERE code=$1`, [req.params.code]);
    await audit('owner', 'marketplaces', req.params.code, { automation_state: 'ACTIVE' });
    return reply.redirect('/');
  });

  app.post<{ Params: { name: string } }>('/jobs/:name/run', async (req, reply) => {
    const job = JOBS.find((j) => j.name === req.params.name);
    if (!job) return reply.code(404).send('unknown job');
    await audit('owner', 'job_runs', job.name, { manualRun: true });
    const r = await Promise.race([runJob(job, true), new Promise((res) => setTimeout(() => res('RUNNING'), 8000))]);
    req.log.info({ job: job.name, result: r }, 'manual job run');
    return reply.redirect('/');
  });

  // ---- Webhooks
  // Event trigger (e.g. SP-API ORDER_CHANGE via SQS->HTTP bridge, eBay notifications). Polling remains the safety net.
  app.post<{ Querystring: { secret?: string } }>('/webhooks/orders', async (req, reply) => {
    if (!e.WEBHOOK_SHARED_SECRET || !safeEq(String(req.query.secret ?? ''), e.WEBHOOK_SHARED_SECRET)) return reply.code(401).send();
    const job = JOBS.find((j) => j.name === 'orders.cycle')!;
    runJob(job, true).catch(() => {});
    return reply.code(202).send({ accepted: true });
  });

  // eBay Marketplace Account Deletion (required for production keyset). Challenge = sha256(challengeCode + token + endpoint).
  app.get<{ Querystring: { challenge_code?: string } }>('/webhooks/ebay/account-deletion', async (req, reply) => {
    if (!e.EBAY_VERIFICATION_TOKEN || !e.PUBLIC_BASE_URL || !req.query.challenge_code) return reply.code(400).send();
    const endpoint = `${e.PUBLIC_BASE_URL}/webhooks/ebay/account-deletion`;
    const challengeResponse = createHash('sha256').update(req.query.challenge_code + e.EBAY_VERIFICATION_TOKEN + endpoint).digest('hex');
    return reply.type('application/json').send({ challengeResponse });
  });
  app.post<{ Body: any }>('/webhooks/ebay/account-deletion', async (req, reply) => {
    const username = (req.body as any)?.notification?.data?.username;
    if (typeof username === 'string' && username.length < 200) {
      await db().query(`UPDATE customers SET external_buyer_ref='deleted:'||id, country=NULL WHERE marketplace_code LIKE 'EBAY_%' AND external_buyer_ref=$1`, ['ebay:' + username]);
    }
    return reply.code(200).send();
  });

  return app;
}

function setupPage() {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>AutoCommerce – setup</title>
<style>:root{--bg:#f6f6f4;--ink:#0b0b0b;--muted:#52514e;--line:#e4e3df}@media (prefers-color-scheme:dark){:root{--bg:#121211;--ink:#fff;--muted:#c3c2b7;--line:#2e2e2b}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}main{max-width:640px;margin:48px auto;padding:0 16px}
.card{border:1px solid var(--line);border-radius:10px;padding:18px 20px}code{font-size:13px}p{color:var(--muted)}</style></head>
<body><main><h1>AutoCommerce är driftsatt ✓</h1><div class="card"><b>NEEDS OWNER ACTION:</b> koppla en databas.
<p>Vercel → projektet <code>autocommerce-agent</code> → <b>Storage</b> → <b>Create Database</b> → <b>Neon (Postgres)</b> → Create → Connect till <code>autocommerce-agent</code>.
Därefter startar systemet automatiskt vid nästa deploy.</p></div></main></body></html>`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const e = env();
  (async () => {
    await migrate();
    const app = await buildServer();
    await app.listen({ port: e.PORT, host: '0.0.0.0' });
  })().catch((err) => { console.error(err); process.exit(1); });
}
