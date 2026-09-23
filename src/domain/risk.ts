import type { Settings } from './settings.js';

/** Section 16 — spending limits. Pure; the caller supplies aggregates read inside the same DB transaction. */
export interface SpendContext {
  orderCostSek: number;           // supplier cost for this order
  orderValueSek: number;          // customer order value
  purchasedTodaySek: number;      // supplier purchases already placed today
  openSupplierOrdersSek: number;  // placed but not delivered
  cashSek: number;
}

/** allowed => proceed automatically; needsApproval => owner can approve; blocked => cash buffer breach, owner must add funds. */
export function checkSpend(c: SpendContext, s: Settings): { allowed: boolean; needsApproval: boolean; blocked: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let hardStop = false;
  if (c.orderValueSek > s.MAX_ORDER_VALUE_SEK) reasons.push(`order value ${c.orderValueSek} > MAX_ORDER_VALUE ${s.MAX_ORDER_VALUE_SEK}`);
  if (c.purchasedTodaySek + c.orderCostSek > s.DAILY_PURCHASE_LIMIT_SEK) reasons.push(`daily purchases would reach ${c.purchasedTodaySek + c.orderCostSek} > DAILY_PURCHASE_LIMIT ${s.DAILY_PURCHASE_LIMIT_SEK}`);
  if (c.openSupplierOrdersSek + c.orderCostSek > s.MAX_TOTAL_OPEN_SUPPLIER_ORDERS_SEK) reasons.push(`open supplier orders would reach ${c.openSupplierOrdersSek + c.orderCostSek} > limit ${s.MAX_TOTAL_OPEN_SUPPLIER_ORDERS_SEK}`);
  if (c.cashSek - c.orderCostSek < s.MIN_CASH_BUFFER_SEK) { reasons.push(`cash ${c.cashSek} − ${c.orderCostSek} would breach MIN_CASH_BUFFER ${s.MIN_CASH_BUFFER_SEK}`); hardStop = true; }
  const allowed = reasons.length === 0;
  return { allowed, needsApproval: !allowed && !hardStop, blocked: hardStop, reasons };
}

/** Section 12 — simple, explainable fraud heuristics. Score 0..100; ≥60 => hold for owner. */
export interface FraudInput {
  orderValueSek: number;
  typicalOrderValueSek: number;
  quantity: number;
  shipCountry: string | null;
  allowedCountries: string[];
  buyerOrderCount24h: number;
  buyerFlagged: boolean;
  addressLooksLikeForwarder: boolean;
  paymentConfirmed: boolean;
}
export function fraudScore(f: FraudInput): { score: number; reasons: string[] } {
  let s = 0; const r: string[] = [];
  if (!f.paymentConfirmed) { s += 100; r.push('payment not confirmed by marketplace'); }
  if (f.buyerFlagged) { s += 60; r.push('buyer previously flagged'); }
  if (f.shipCountry && !f.allowedCountries.includes(f.shipCountry)) { s += 60; r.push(`ship country ${f.shipCountry} not served`); }
  if (f.quantity >= 5) { s += 25; r.push(`unusual quantity ${f.quantity}`); }
  if (f.orderValueSek > f.typicalOrderValueSek * 4) { s += 25; r.push('order value far above typical'); }
  if (f.buyerOrderCount24h >= 3) { s += 20; r.push(`${f.buyerOrderCount24h} orders from buyer in 24h`); }
  if (f.addressLooksLikeForwarder) { s += 30; r.push('address resembles parcel forwarder'); }
  return { score: Math.min(100, s), reasons: r };
}

/** Section 15 — account health. Returns which automation must pause. */
export interface HealthMetrics { odrPct?: number | null; lateShipmentPct?: number | null; cancelRatePct?: number | null; validTrackingPct?: number | null; policyWarnings?: number; accountStatus?: string | null }
export function evaluateHealth(m: HealthMetrics, s: Settings): { status: 'HEALTHY' | 'AT_RISK' | 'CRITICAL' | 'UNKNOWN'; pause: boolean; reasons: string[] } {
  const r: string[] = [];
  if (m.accountStatus && !/normal|active|good|healthy/i.test(m.accountStatus)) r.push(`account status ${m.accountStatus}`);
  if (m.odrPct != null && m.odrPct > s.MAX_ODR_PCT) r.push(`ODR ${m.odrPct}% > ${s.MAX_ODR_PCT}%`);
  if (m.lateShipmentPct != null && m.lateShipmentPct > s.MAX_LATE_SHIPMENT_PCT) r.push(`late shipment ${m.lateShipmentPct}% > ${s.MAX_LATE_SHIPMENT_PCT}%`);
  if (m.cancelRatePct != null && m.cancelRatePct > s.MAX_CANCEL_RATE_PCT) r.push(`cancel rate ${m.cancelRatePct}% > ${s.MAX_CANCEL_RATE_PCT}%`);
  if (m.validTrackingPct != null && m.validTrackingPct < s.MIN_VALID_TRACKING_PCT) r.push(`valid tracking ${m.validTrackingPct}% < ${s.MIN_VALID_TRACKING_PCT}%`);
  if ((m.policyWarnings ?? 0) > 0) r.push(`${m.policyWarnings} policy warning(s)`);
  const allUnknown = [m.odrPct, m.lateShipmentPct, m.cancelRatePct, m.validTrackingPct].every((x) => x == null) && !m.accountStatus;
  if (allUnknown) return { status: 'UNKNOWN', pause: false, reasons: ['no metrics available'] };
  const critical = r.some((x) => x.startsWith('account status')) || (m.policyWarnings ?? 0) > 0;
  return { status: critical ? 'CRITICAL' : r.length ? 'AT_RISK' : 'HEALTHY', pause: r.length > 0, reasons: r };
}

/** Staged go-live gates (section 24.15). In simulation/sandbox all side effects hit mocks/sandboxes. */
export function capabilities(mode: 'simulation' | 'sandbox' | 'live', s: Settings) {
  const on = s.AUTOMATION_ENABLED;
  const stage = mode === 'live' ? s.GO_LIVE_STAGE : 4;
  return {
    research: on,
    listing: on && stage >= 1,
    ordering: on && stage >= 2,
    repricing: on && stage >= 3,
    refunds: on && stage >= 4 && s.AUTO_REFUNDS,
  };
}
