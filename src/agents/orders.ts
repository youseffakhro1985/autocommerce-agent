/**
 * Operations Agent — order pipeline (sections 12, 13, 16). Idempotent by construction:
 *  - orders UNIQUE(marketplace_code, external_order_id)
 *  - supplier_orders UNIQUE(order_id) + UNIQUE(idempotency_key) written and COMMITTED before the supplier API call
 *  - crash between "PLACING" and API response => reconcile by reference, never blind re-order
 */
import { many, one, db, tx } from '../db/pool.js';
import { calculateProfit } from '../domain/profit.js';
import { checkSpend, fraudScore } from '../domain/risk.js';
import { toSek, fromSek } from '../services/fx.js';
import { logAction, audit } from '../services/audit.js';
import { raiseAlert, requestApproval, approvalStatus } from '../services/alerts.js';
import { HttpError } from '../integrations/http.js';
import { profitInputFor } from './evaluation.js';
import { pauseListing } from './listing.js';
import { ctx, estimateReturnRate } from './context.js';
import { MockMarketplace } from '../integrations/mock/index.js';
import { env } from '../config/env.js';

const SERVED_COUNTRIES = ['SE', 'DE', 'AT', 'DK', 'FI', 'NO', 'NL', 'BE', 'FR', 'IT', 'ES', 'PL'];

// ------------------------------------------------------------------ ingest
export async function ingestOrders() {
  const c = await ctx();
  let inserted = 0;
  for (const mp of c.marketplaces) {
    const adapter = c.reg.marketplaces.get(mp.code);
    if (!adapter) continue;
    // Simulation only: fake customer demand for active listings (read from DB so it works on serverless).
    if (c.mode === 'simulation' && env().SIM_DEMAND === '1' && adapter instanceof MockMarketplace) {
      for (const l of await many(`SELECT sku, price, quantity FROM listings WHERE marketplace_code=$1 AND status='ACTIVE' AND quantity > 0`, [mp.code])) {
        if (Math.random() < 0.15) adapter.injectOrder(l.sku, 1, await fromSek(Number(l.price), mp.currency));
      }
    }
    const last = await one<{ t: Date }>(`SELECT max(started_at) AS t FROM job_runs WHERE job='orders.cycle' AND status='OK'`);
    const since = new Date((last?.t ? new Date(last.t).getTime() : Date.now() - 7 * 864e5) - 2 * 36e5); // 2h overlap, dedup by unique key
    const orders = await adapter.fetchOrders(since);
    for (const o of orders) {
      const totalSek = await toSek(o.total, o.currency);
      await tx(async (q) => {
        const cust = (await q.query(
          `INSERT INTO customers(marketplace_code, external_buyer_ref, country) VALUES ($1,$2,$3)
           ON CONFLICT (marketplace_code, external_buyer_ref) DO UPDATE SET country=EXCLUDED.country RETURNING id`, [mp.code, o.buyerRef, o.shipCountry])).rows[0];
        const r = await q.query(
          `INSERT INTO orders(marketplace_code, external_order_id, customer_id, status, payment_status, order_total, currency, order_total_sek, ship_by, deliver_by, ship_country, raw, placed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (marketplace_code, external_order_id) DO NOTHING RETURNING id`,
          [mp.code, o.externalId, cust.id, o.cancelled ? 'CANCELLED' : 'RECEIVED', o.paymentConfirmed ? 'PAID' : 'PENDING', o.total, o.currency, totalSek,
            o.shipBy ?? null, o.deliverBy ?? null, o.shipCountry, JSON.stringify({ status: o.status, raw: o.raw ?? null }), o.placedAt]);
        if (r.rowCount) {
          inserted++;
          await q.query('UPDATE customers SET order_count=order_count+1 WHERE id=$1', [cust.id]);
          for (const it of o.items) {
            const l = (await q.query(`SELECT id FROM listings WHERE marketplace_code=$1 AND sku=$2`, [mp.code, it.sku])).rows[0];
            await q.query(`INSERT INTO order_items(order_id, listing_id, sku, external_item_id, quantity, unit_price, unit_price_sek) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [r.rows[0].id, l?.id ?? null, it.sku, it.externalItemId, it.quantity, it.unitPrice, await toSek(it.unitPrice, o.currency)]);
          }
        } else {
          // Existing order: propagate payment confirmation / cancellation only.
          if (o.cancelled) await q.query(`UPDATE orders SET status='CANCELLED', updated_at=now() WHERE marketplace_code=$1 AND external_order_id=$2 AND status IN ('RECEIVED','AWAITING_PAYMENT','ON_HOLD','AWAITING_APPROVAL')`, [mp.code, o.externalId]);
          else if (o.paymentConfirmed) await q.query(`UPDATE orders SET payment_status='PAID', status=CASE WHEN status='AWAITING_PAYMENT' THEN 'RECEIVED' ELSE status END, updated_at=now() WHERE marketplace_code=$1 AND external_order_id=$2`, [mp.code, o.externalId]);
          // Cancelled after we already bought from supplier => owner must handle (cancel at supplier / accept return)
          if (o.cancelled) {
            const placed = (await q.query(`SELECT o.id FROM orders o JOIN supplier_orders so ON so.order_id=o.id WHERE o.marketplace_code=$1 AND o.external_order_id=$2 AND so.status='PLACED'`, [mp.code, o.externalId])).rows[0];
            if (placed) await raiseAlert({ severity: 'CRITICAL', category: 'ORDER', title: `Order ${o.externalId} cancelled by buyer after supplier order was placed`, dedupeKey: `cancel-after-po:${o.externalId}`, requiresOwner: true }, q);
          }
        }
      });
    }
  }
  return { inserted };
}

// ------------------------------------------------------------------ validate + place
export async function processOrders(limit = 20) {
  const c = await ctx();
  const ids = await many<{ id: number }>(`SELECT id FROM orders WHERE status IN ('RECEIVED','AWAITING_PAYMENT','AWAITING_APPROVAL') ORDER BY placed_at LIMIT $1`, [limit]);
  const result = { placed: 0, held: 0, awaitingApproval: 0, failed: 0 };
  for (const { id } of ids) {
    const r = await processOne(id, c).catch(async (e) => {
      await raiseAlert({ severity: 'CRITICAL', category: 'ORDER', title: `Order ${id} processing error: ${String(e.message).slice(0, 200)}`, dedupeKey: `order-error:${id}`, requiresOwner: true });
      return 'failed' as const;
    });
    if (r) (result as any)[r]++;
  }
  return result;
}

type Outcome = 'placed' | 'held' | 'awaitingApproval' | 'failed' | null;

async function processOne(orderId: number, c: Awaited<ReturnType<typeof ctx>>): Promise<Outcome> {
  // Phase A (transaction, row lock): validate and reserve the supplier order row.
  const toPause: { id: number; reason: string }[] = [];
  const plan = await tx(async (q) => {
    const o = (await q.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE SKIP LOCKED`, [orderId])).rows[0];
    if (!o || !['RECEIVED', 'AWAITING_PAYMENT', 'AWAITING_APPROVAL'].includes(o.status)) return null;
    const hold = async (status: string, reason: string, alert?: { severity: 'WARNING' | 'CRITICAL'; owner?: boolean }) => {
      await q.query(`UPDATE orders SET status=$2, hold_reason=$3, updated_at=now() WHERE id=$1`, [o.id, status, reason]);
      await logAction({ agent: 'orders', action: 'HOLD', subjectType: 'order', subjectId: o.id, decision: status, reasons: [reason] }, q);
      if (alert) await raiseAlert({ severity: alert.severity, category: 'ORDER', title: `Order ${o.external_order_id}: ${reason}`.slice(0, 300), dedupeKey: `order-hold:${o.id}`, requiresOwner: alert.owner }, q);
      return null;
    };
    if (o.payment_status !== 'PAID') return hold('AWAITING_PAYMENT', 'payment not confirmed by marketplace');

    const items = (await q.query(`SELECT oi.*, l.id AS lid, l.supplier_product_id, l.status AS listing_status FROM order_items oi LEFT JOIN listings l ON l.id=oi.listing_id WHERE oi.order_id=$1`, [o.id])).rows;
    if (!items.length || items.some((i: any) => !i.supplier_product_id)) return hold('ON_HOLD', 'order contains SKU not managed by this system', { severity: 'WARNING', owner: true });
    const spIds = [...new Set(items.map((i: any) => i.supplier_product_id))];
    const sps = (await q.query(`SELECT sp.*, s.id AS sid, s.code AS supplier_code, s.status AS supplier_status, s.is_wholesaler, p.category FROM supplier_products sp JOIN suppliers s ON s.id=sp.supplier_id JOIN products p ON p.id=sp.product_id WHERE sp.id = ANY($1)`, [spIds])).rows;
    const supplierIds = new Set(sps.map((s: any) => s.sid));
    if (supplierIds.size !== 1) return hold('ON_HOLD', 'multi-supplier order — manual split required', { severity: 'WARNING', owner: true });
    const sup = sps[0];
    if (sup.supplier_status !== 'VERIFIED' || !sup.is_wholesaler) return hold('ON_HOLD', `supplier ${sup.supplier_code} not verified wholesaler`, { severity: 'CRITICAL', owner: true });
    const adapter = c.reg.suppliers.get(sup.supplier_code);
    if (!adapter) return hold('ON_HOLD', `supplier adapter ${sup.supplier_code} unavailable`, { severity: 'CRITICAL', owner: true });

    // Live stock & cost check
    const live = await adapter.getStock(sps.map((s: any) => s.supplier_sku));
    let costSek = 0;
    for (const it of items) {
      const sp = sps.find((s: any) => s.id === it.supplier_product_id);
      const st = live.find((x) => x.supplierSku === sp.supplier_sku);
      if (!st || st.stock < it.quantity) return hold('ON_HOLD', `supplier out of stock for ${it.sku}`, { severity: 'CRITICAL', owner: true });
      const unitCost = Number.isFinite(st.costPrice) ? st.costPrice : Number(sp.cost_price);
      if (Math.abs(unitCost - Number(sp.cost_price)) / Number(sp.cost_price) > 0.02) {
        await q.query(`UPDATE supplier_products SET cost_price=$2 WHERE id=$1`, [sp.id, unitCost]);
      }
      costSek += (await toSek(unitCost, sp.cost_currency)) * it.quantity;
    }

    // Profitability of THIS order with current cost (section 13)
    const mp = c.marketplaces.find((m) => m.code === o.marketplace_code)!;
    let orderProfit = 0, shipSek = 0, reserveSek = 0;
    for (const it of items) {
      const sp = sps.find((s: any) => s.id === it.supplier_product_id);
      const liveSt = live.find((x) => x.supplierSku === sp.supplier_sku)!;
      const pin = await profitInputFor({ ...sp, cost_price: Number.isFinite(liveSt.costPrice) ? liveSt.costPrice : sp.cost_price }, mp, Number(it.unit_price_sek), c.s, estimateReturnRate(sp.category), sp.category);
      const pr = calculateProfit(pin, { minNetMarginPct: c.s.MIN_NET_MARGIN_PCT, minProfitSek: c.s.MIN_PROFIT_PER_ORDER_SEK });
      orderProfit += pr.netProfit * it.quantity;
      shipSek += pr.costs.supplierShipping * it.quantity;
      reserveSek += (pr.costs.expectedReturns + pr.costs.refundReserve + pr.costs.warrantyReserve + pr.costs.software + pr.costs.fxBuffer + pr.costs.customs) * it.quantity;
      if (pr.netProfit < c.s.MIN_PROFIT_PER_ORDER_SEK || pr.netMarginPct < c.s.MIN_NET_MARGIN_PCT) {
        // Stop further sales immediately; this order continues only if not loss-making.
        toPause.push({ id: it.lid, reason: 'supplier cost increase — below min profit' });
        await raiseAlert({ severity: 'WARNING', category: 'PROFIT', title: `Listing ${it.sku} paused: order profit ${pr.netProfit} SEK below rules`, dedupeKey: `unprofitable:${it.sku}` }, q);
      }
    }
    if (orderProfit < 0) return hold('ON_HOLD', `order would be loss-making (${orderProfit.toFixed(0)} SEK) — fulfil at loss or cancel? (owner decision)`, { severity: 'CRITICAL', owner: true });

    // Fraud
    const cust = (await q.query(`SELECT * FROM customers WHERE id=$1`, [o.customer_id])).rows[0];
    const recent = (await q.query(`SELECT count(*)::int n FROM orders WHERE customer_id=$1 AND placed_at > now() - interval '24 hours'`, [o.customer_id])).rows[0].n;
    const fr = fraudScore({
      orderValueSek: Number(o.order_total_sek), typicalOrderValueSek: 400, quantity: items.reduce((a: number, i: any) => a + i.quantity, 0),
      shipCountry: o.ship_country, allowedCountries: SERVED_COUNTRIES, buyerOrderCount24h: recent, buyerFlagged: !!cust?.flagged,
      addressLooksLikeForwarder: false, paymentConfirmed: o.payment_status === 'PAID',
    });
    await q.query(`UPDATE orders SET fraud_score=$2 WHERE id=$1`, [o.id, fr.score]);
    if (fr.score >= 60) return hold('ON_HOLD', `possible fraud (score ${fr.score}): ${fr.reasons.join('; ')}`, { severity: 'CRITICAL', owner: true });

    // Spending limits + staged go-live
    const agg = (await q.query(`
      SELECT COALESCE(sum(cost_total_sek) FILTER (WHERE so.created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm' AND so.status IN ('PLACING','PLACED','UNKNOWN_NEEDS_RECONCILE')),0) AS today,
             COALESCE(sum(cost_total_sek) FILTER (WHERE so.status IN ('PLACING','PLACED','UNKNOWN_NEEDS_RECONCILE') AND o.status NOT IN ('DELIVERED','CANCELLED','REFUNDED')),0) AS open
      FROM supplier_orders so JOIN orders o ON o.id=so.order_id`)).rows[0];
    costSek += shipSek; // supplier shipping is part of the cash outlay
    const spend = checkSpend({ orderCostSek: costSek, orderValueSek: Number(o.order_total_sek), purchasedTodaySek: Number(agg.today), openSupplierOrdersSek: Number(agg.open), cashSek: c.s.CURRENT_CASH_SEK }, c.s);
    const approval = await approvalStatus('PLACE_SUPPLIER_ORDER', String(o.id), q);
    if (approval === 'REJECTED') return hold('ON_HOLD', 'owner rejected supplier order — cancel on marketplace', { severity: 'WARNING', owner: true });
    const needsApproval = spend.blocked || !spend.allowed || !c.caps.ordering;
    if (needsApproval && approval !== 'APPROVED') {
      const reasons = [...spend.reasons, ...(!c.caps.ordering ? [`auto-ordering not enabled (stage ${c.s.GO_LIVE_STAGE})`] : [])];
      await requestApproval('PLACE_SUPPLIER_ORDER', String(o.id), { order: o.external_order_id, marketplace: o.marketplace_code, valueSek: o.order_total_sek, costSek, reasons }, q);
      await q.query(`UPDATE orders SET status='AWAITING_APPROVAL', hold_reason=$2, updated_at=now() WHERE id=$1`, [o.id, reasons.join('; ')]);
      return 'awaitingApproval' as const;
    }

    const key = `AC-SO-${o.id}`;
    await q.query(`INSERT INTO supplier_orders(order_id, supplier_id, idempotency_key, status, cost_total_sek, attempts) VALUES ($1,$2,$3,'PLACING',$4,1)`, [o.id, sup.sid, key, Math.round(costSek * 100) / 100]);
    await q.query(`UPDATE orders SET status='PLACING_SUPPLIER_ORDER', hold_reason=NULL, updated_at=now() WHERE id=$1`, [o.id]);
    return { order: o, items, sps, supplierCode: sup.supplier_code, key, costSek, orderProfit, shipSek, reserveSek };
  });
  for (const p of toPause) await pauseListing(p.id, p.reason, 'orders'); // stop further sales on marketplace too
  if (!plan) return 'held';
  if (plan === 'awaitingApproval') return plan;

  // Phase B (outside transaction): the ONLY place money is spent.
  const c2 = c.reg.suppliers.get(plan.supplierCode)!;
  const mpAdapter = c.reg.marketplaces.get(plan.order.marketplace_code)!;
  try {
    const shipTo = await mpAdapter.getShippingAddress(plan.order.external_order_id); // PII just-in-time, not stored
    const res = await c2.placeOrder({
      idempotencyKey: plan.key, blindShipping: true, shipTo,
      items: plan.items.map((i: any) => ({ supplierSku: plan.sps.find((s: any) => s.id === i.supplier_product_id).supplier_sku, quantity: i.quantity })),
    });
    await tx(async (q) => {
      await q.query(`UPDATE supplier_orders SET status='PLACED', external_ref=$2, updated_at=now() WHERE idempotency_key=$1`, [plan.key, res.externalRef]);
      await q.query(`UPDATE orders SET status='SUPPLIER_ORDERED', updated_at=now() WHERE id=$1`, [plan.order.id]);
      await recordOrderFinancials(plan.order, plan.costSek - plan.shipSek, plan.shipSek, plan.reserveSek, q);
      await logAction({ agent: 'orders', action: 'SUPPLIER_ORDER_PLACED', subjectType: 'order', subjectId: plan.order.id, decision: 'PLACED',
        data: { supplier: plan.supplierCode, ref: res.externalRef, costSek: plan.costSek, expectedProfitSek: Math.round(plan.orderProfit) }, dryRun: !c2.live }, q);
    });
    return 'placed';
  } catch (e: any) {
    const definitive = e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429;
    await db().query(`UPDATE supplier_orders SET status=$2, last_error=$3, updated_at=now() WHERE idempotency_key=$1`, [plan.key, definitive ? 'FAILED' : 'UNKNOWN_NEEDS_RECONCILE', String(e.message).slice(0, 500)]);
    if (definitive) await db().query(`UPDATE orders SET status='ON_HOLD', hold_reason=$2 WHERE id=$1`, [plan.order.id, 'supplier rejected order: ' + String(e.message).slice(0, 200)]);
    await raiseAlert({ severity: 'CRITICAL', category: 'ORDER', title: `Supplier order ${definitive ? 'rejected' : 'outcome unknown'} for ${plan.order.external_order_id}`, detail: { error: String(e.message).slice(0, 300) }, dedupeKey: `po-fail:${plan.key}`, requiresOwner: definitive });
    return 'failed';
  }
}

async function recordOrderFinancials(o: any, costSek: number, shipSek: number, reserveSek: number, q: any) {
  const mp = await q.query(`SELECT vat_rate FROM marketplaces WHERE code=$1`, [o.marketplace_code]);
  const vat = Number(o.order_total_sek) * Number(mp.rows[0].vat_rate) / (1 + Number(mp.rows[0].vat_rate));
  const fee = (await q.query(`SELECT referral_pct, fixed_fee FROM fees WHERE marketplace_code=$1 AND category='*'`, [o.marketplace_code])).rows[0];
  const feeSek = fee ? Number(o.order_total_sek) * Number(fee.referral_pct) + Number(fee.fixed_fee) : 0;
  const ref = `${o.marketplace_code}:${o.external_order_id}`;
  for (const [kind, amount] of [['SALE', Number(o.order_total_sek)], ['SUPPLIER_COST', -costSek], ['MARKETPLACE_FEE', -feeSek], ['VAT_ESTIMATE', -vat], ['SHIPPING', -shipSek], ['RESERVE', -reserveSek]] as const) {
    await q.query(`INSERT INTO transactions(order_id, kind, amount_sek, source_ref) VALUES ($1,$2,$3,$4) ON CONFLICT (kind, source_ref) DO NOTHING`, [o.id, kind, Math.round(amount * 100) / 100, ref]);
  }
}

// ------------------------------------------------------------------ reconcile unknown outcomes
export async function reconcileSupplierOrders() {
  const c = await ctx();
  const rows = await many(`SELECT so.*, s.code FROM supplier_orders so JOIN suppliers s ON s.id=so.supplier_id
    WHERE so.status='UNKNOWN_NEEDS_RECONCILE' OR (so.status='PLACING' AND so.updated_at < now() - interval '10 minutes')`);
  let fixed = 0;
  for (const so of rows) {
    const a = c.reg.suppliers.get(so.code);
    if (!a) continue;
    const found = await a.findOrderByReference(so.idempotency_key).catch(() => undefined);
    if (found) {
      await tx(async (q) => {
        await q.query(`UPDATE supplier_orders SET status='PLACED', external_ref=$2, updated_at=now() WHERE id=$1`, [so.id, found.externalRef]);
        await q.query(`UPDATE orders SET status='SUPPLIER_ORDERED', updated_at=now() WHERE id=$1 AND status='PLACING_SUPPLIER_ORDER'`, [so.order_id]);
        await audit('orders', 'supplier_orders', so.id, { reconciled: 'found at supplier', ref: found.externalRef }, q);
      });
      fixed++;
    } else if (found === null) {
      // Never re-order automatically: a missing record may still be propagating at the supplier.
      await raiseAlert({ severity: 'CRITICAL', category: 'ORDER', title: `Supplier order ${so.idempotency_key} not found at ${so.code} — verify manually before re-ordering`, dedupeKey: `reconcile:${so.idempotency_key}`, requiresOwner: true });
    }
  }
  return { checked: rows.length, fixed };
}

// ------------------------------------------------------------------ tracking & delivery
export async function syncTracking() {
  const c = await ctx();
  const rows = await many(`SELECT so.*, s.code, o.external_order_id, o.marketplace_code, o.ship_by, o.deliver_by, o.status AS order_status, o.id AS oid
    FROM supplier_orders so JOIN suppliers s ON s.id=so.supplier_id JOIN orders o ON o.id=so.order_id
    WHERE so.status='PLACED' AND o.status IN ('SUPPLIER_ORDERED','SHIPPED')`);
  let uploaded = 0;
  const bySup = new Map<string, any[]>();
  for (const r of rows) bySup.set(r.code, [...(bySup.get(r.code) ?? []), r]);
  for (const [code, list] of bySup) {
    const a = c.reg.suppliers.get(code);
    if (!a) continue;
    const tracks = await a.getTracking(list.map((r) => ({ reference: r.idempotency_key, externalRef: r.external_ref })));
    for (const r of list) {
      const t = tracks.find((x) => x.reference === r.idempotency_key);
      if (!t) {
        const hrs = (Date.now() - new Date(r.created_at).getTime()) / 36e5;
        if (hrs > c.s.TRACKING_MISSING_AFTER_HOURS) await raiseAlert({ severity: 'WARNING', category: 'SHIPPING', title: `No tracking ${Math.round(hrs)}h after supplier order for ${r.external_order_id}`, dedupeKey: `notrack:${r.oid}` });
        if (r.ship_by && new Date(r.ship_by).getTime() < Date.now()) await raiseAlert({ severity: 'CRITICAL', category: 'SHIPPING', title: `Order ${r.external_order_id} past ship-by date without tracking (late shipment risk)`, dedupeKey: `late:${r.oid}`, requiresOwner: true });
        continue;
      }
      await db().query(`INSERT INTO shipments(order_id, carrier, tracking_number, tracking_url, shipped_at, last_event, last_checked_at, delivered_at)
        VALUES ($1,$2,$3,$4,$5,$6,now(),$7) ON CONFLICT (order_id) DO UPDATE SET last_event=EXCLUDED.last_event, last_checked_at=now(), delivered_at=COALESCE(shipments.delivered_at, EXCLUDED.delivered_at)`,
        [r.oid, t.carrier, t.trackingNumber, t.trackingUrl ?? null, t.shippedAt, t.lastEvent ?? null, t.delivered ? (t.deliveredAt ?? new Date()) : null]);
      const sh = await one(`SELECT * FROM shipments WHERE order_id=$1`, [r.oid]);
      if (!sh.uploaded_to_marketplace_at) {
        const items = await many(`SELECT sku, external_item_id AS "externalItemId", quantity, unit_price AS "unitPrice" FROM order_items WHERE order_id=$1`, [r.oid]);
        await c.reg.marketplaces.get(r.marketplace_code)!.confirmShipment(r.external_order_id, items, { carrier: t.carrier, trackingNumber: t.trackingNumber, shippedAt: t.shippedAt });
        await tx(async (q) => {
          await q.query(`UPDATE shipments SET uploaded_to_marketplace_at=now() WHERE order_id=$1`, [r.oid]);
          await q.query(`UPDATE orders SET status='TRACKING_UPLOADED', updated_at=now() WHERE id=$1`, [r.oid]);
          await logAction({ agent: 'orders', action: 'TRACKING_UPLOADED', subjectType: 'order', subjectId: r.oid, data: { carrier: t.carrier, tracking: t.trackingNumber } }, q);
        });
        uploaded++;
      }
    }
  }
  // Delivery monitoring
  const late = await many(`SELECT o.id, o.external_order_id FROM orders o JOIN shipments s ON s.order_id=o.id WHERE o.status='TRACKING_UPLOADED' AND s.delivered_at IS NULL AND o.deliver_by < now()`);
  for (const l of late) await raiseAlert({ severity: 'WARNING', category: 'SHIPPING', title: `Order ${l.external_order_id} past latest delivery date`, dedupeKey: `latedelivery:${l.id}` });
  await db().query(`UPDATE orders o SET status='DELIVERED', updated_at=now() FROM shipments s WHERE s.order_id=o.id AND s.delivered_at IS NOT NULL AND o.status='TRACKING_UPLOADED'`);
  return { uploaded, lateDeliveries: late.length };
}

export async function runOrderCycle() {
  const a = await ingestOrders();
  const b = await processOrders();
  return { ...a, ...b };
}
