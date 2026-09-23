/** Account Health Agent (section 15). Account health > short-term revenue. */
import { db, one, many } from '../db/pool.js';
import { evaluateHealth, type HealthMetrics } from '../domain/risk.js';
import { logAction } from '../services/audit.js';
import { raiseAlert, resolveAlert } from '../services/alerts.js';
import { ctx } from './context.js';

/** Our own early-warning metrics from the DB (react before the marketplace does). */
export async function internalMetrics(code: string): Promise<HealthMetrics> {
  const r = await one(`
    SELECT count(*) FILTER (WHERE o.status NOT IN ('CANCELLED','AWAITING_PAYMENT'))::int AS n,
           count(*) FILTER (WHERE o.status='CANCELLED' AND o.payment_status='PAID')::int AS cancelled,
           count(*) FILTER (WHERE s.shipped_at IS NOT NULL AND o.ship_by IS NOT NULL AND s.shipped_at > o.ship_by)::int AS late,
           count(*) FILTER (WHERE s.uploaded_to_marketplace_at IS NOT NULL)::int AS tracked,
           count(*) FILTER (WHERE o.status IN ('TRACKING_UPLOADED','DELIVERED','SHIPPED'))::int AS shipped
    FROM orders o LEFT JOIN shipments s ON s.order_id=o.id
    WHERE o.marketplace_code=$1 AND o.placed_at > now() - interval '30 days'`, [code]);
  if (!r || r.n < 10) return {}; // too few orders for meaningful rates
  return {
    cancelRatePct: Math.round((r.cancelled / r.n) * 1000) / 10,
    lateShipmentPct: Math.round((r.late / r.n) * 1000) / 10,
    validTrackingPct: r.shipped ? Math.round((r.tracked / r.shipped) * 1000) / 10 : null,
  };
}

export async function runHealth() {
  const c = await ctx();
  const out: Record<string, string> = {};
  for (const mp of c.marketplaces) {
    const adapter = c.reg.marketplaces.get(mp.code);
    let ext: HealthMetrics = {};
    try { ext = adapter ? await adapter.getAccountHealth() : {}; } catch (e: any) {
      await raiseAlert({ severity: 'WARNING', category: 'HEALTH', title: `Account health fetch failed for ${mp.code}: ${String(e.message).slice(0, 150)}`, dedupeKey: `healthfetch:${mp.code}` });
    }
    const own = await internalMetrics(mp.code);
    // Worst of marketplace-reported and internal metrics.
    const merged: HealthMetrics = {
      accountStatus: ext.accountStatus ?? null, policyWarnings: ext.policyWarnings ?? 0, odrPct: ext.odrPct ?? null,
      lateShipmentPct: max(ext.lateShipmentPct, own.lateShipmentPct), cancelRatePct: max(ext.cancelRatePct, own.cancelRatePct),
      validTrackingPct: min(ext.validTrackingPct, own.validTrackingPct),
    };
    const h = evaluateHealth(merged, c.s);
    out[mp.code] = h.status;
    const prev = await one(`SELECT automation_state FROM marketplaces WHERE code=$1`, [mp.code]);
    await db().query(`UPDATE marketplaces SET health_status=$2, health_snapshot=$3, health_checked_at=now(),
      automation_state = CASE WHEN $4 AND automation_state='ACTIVE' THEN 'PAUSED_HEALTH' ELSE automation_state END WHERE code=$1`,
      [mp.code, h.status, JSON.stringify({ merged, external: ext, internal: own, reasons: h.reasons }), h.pause]);
    await logAction({ agent: 'health', action: 'HEALTH_CHECK', subjectType: 'marketplace', subjectId: mp.code, decision: h.status, reasons: h.reasons, data: merged });
    if (h.pause && prev?.automation_state === 'ACTIVE') {
      await raiseAlert({ severity: 'CRITICAL', category: 'HEALTH', title: `${mp.code} automation PAUSED (new listings + repricing): ${h.reasons.join('; ')}`, dedupeKey: `health:${mp.code}`, requiresOwner: true });
      if (h.status === 'CRITICAL' && adapter) {
        // Stop taking new orders on a critically unhealthy account; existing orders are still fulfilled.
        for (const l of await many(`SELECT id, sku FROM listings WHERE marketplace_code=$1 AND status='ACTIVE'`, [mp.code])) {
          await adapter.updatePriceQuantity(l.sku, { quantity: 0 });
          await db().query(`UPDATE listings SET status='PAUSED', pause_reason='account health critical', quantity=0 WHERE id=$1`, [l.id]);
        }
      }
    } else if (!h.pause) await resolveAlert(`health:${mp.code}`);
  }
  return out;
}

const max = (a?: number | null, b?: number | null) => (a == null ? b ?? null : b == null ? a : Math.max(a, b));
const min = (a?: number | null, b?: number | null) => (a == null ? b ?? null : b == null ? a : Math.min(a, b));
