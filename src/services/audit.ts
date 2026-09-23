import { db, type Q } from '../db/pool.js';

/** Every automated decision gets a row here (section 22). */
export async function logAction(
  a: { agent: string; action: string; subjectType?: string; subjectId?: string | number; decision?: string; reasons?: unknown; data?: unknown; dryRun?: boolean },
  q: Q = db(),
) {
  await q.query(
    `INSERT INTO agent_actions(agent, action, subject_type, subject_id, decision, reasons, data, dry_run) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.agent, a.action, a.subjectType ?? null, a.subjectId != null ? String(a.subjectId) : null, a.decision ?? null,
      a.reasons != null ? JSON.stringify(a.reasons) : null, a.data != null ? JSON.stringify(a.data) : null, a.dryRun ?? false],
  );
}

export async function audit(actor: string, entity: string, entityId: string | number | null, change: unknown, q: Q = db()) {
  await q.query(`INSERT INTO audit_logs(actor, entity, entity_id, change) VALUES ($1,$2,$3,$4)`, [actor, entity, entityId != null ? String(entityId) : null, JSON.stringify(change)]);
}
