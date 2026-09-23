import { db, one, type Q } from '../db/pool.js';
import { env } from '../config/env.js';
import { http } from '../integrations/http.js';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * Create (deduplicated) alert. Only CRITICAL or requires_owner alerts are pushed immediately (section 19: "only important notifications").
 */
export async function raiseAlert(
  a: { severity: Severity; category: string; title: string; detail?: unknown; dedupeKey?: string; requiresOwner?: boolean },
  q: Q = db(),
): Promise<number | null> {
  const row = await one<{ id: number }>(
    `INSERT INTO alerts(severity, category, title, detail, dedupe_key, requires_owner) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [a.severity, a.category, a.title, a.detail ? JSON.stringify(a.detail) : null, a.dedupeKey ?? null, a.requiresOwner ?? false], q,
  );
  if (row && (a.severity === 'CRITICAL' || a.requiresOwner)) {
    await notify(`[${a.severity}] ${a.title}`, a.detail).catch((e) => console.error('[notify] failed', e.message));
    await db().query('UPDATE alerts SET notified_at=now() WHERE id=$1', [row.id]).catch(() => {});
  }
  return row?.id ?? null;
}

export async function resolveAlert(dedupeKey: string) {
  await db().query('UPDATE alerts SET resolved_at=now() WHERE dedupe_key=$1 AND resolved_at IS NULL', [dedupeKey]);
}

export async function notify(title: string, detail?: unknown) {
  const e = env();
  const text = `${title}${detail ? '\n' + JSON.stringify(detail, null, 2).slice(0, 1500) : ''}`;
  if (e.APP_MODE === 'simulation') { console.log('[notify:sim]', title); return; }
  if (e.NOTIFY_WEBHOOK_URL) await http(e.NOTIFY_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
  if (e.RESEND_API_KEY && e.OWNER_EMAIL) {
    await http('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${e.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: e.NOTIFY_FROM_EMAIL ?? 'AutoCommerce <onboarding@resend.dev>', to: [e.OWNER_EMAIL], subject: title, text }),
    });
  }
}

export async function requestApproval(kind: string, subjectRef: string, payload: unknown, q: Q = db()) {
  const r = await one<{ id: number }>(
    `INSERT INTO approval_requests(kind, subject_ref, payload) VALUES ($1,$2,$3) ON CONFLICT (kind, subject_ref) DO NOTHING RETURNING id`,
    [kind, subjectRef, JSON.stringify(payload)], q,
  );
  if (r) await raiseAlert({ severity: 'WARNING', category: 'APPROVAL', title: `Approval needed: ${kind} ${subjectRef}`, detail: payload, dedupeKey: `approval:${kind}:${subjectRef}`, requiresOwner: true }, q);
  return r?.id ?? null;
}

export async function approvalStatus(kind: string, subjectRef: string, q: Q = db()): Promise<string | null> {
  const r = await one<{ status: string }>('SELECT status FROM approval_requests WHERE kind=$1 AND subject_ref=$2', [kind, subjectRef], q);
  return r?.status ?? null;
}
