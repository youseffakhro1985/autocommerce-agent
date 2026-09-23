import { many, db, type Q } from '../db/pool.js';

/**
 * All business rules are configurable in system_settings (editable from the dashboard).
 * These are the start values requested by the owner.
 */
export const DEFAULT_SETTINGS = {
  // --- Product approval rules (section 8)
  MIN_NET_MARGIN_PCT: { v: 20, d: 'Minimum expected net margin %' },
  MIN_PROFIT_PER_ORDER_SEK: { v: 80, d: 'Minimum expected net profit per order (SEK)' },
  MIN_SUPPLIER_RELIABILITY: { v: 85, d: 'Minimum supplier reliability score (0-100)' },
  MAX_RETURN_RATE_PCT: { v: 8, d: 'Maximum estimated return rate %' },
  MIN_STOCK_BUFFER: { v: 20, d: 'Minimum supplier stock to approve / list at full quantity' },
  MAX_DELIVERY_DAYS_EU: { v: 7, d: 'Maximum normal delivery time within EU (days)' },
  MIN_OPPORTUNITY_SCORE: { v: 65, d: 'Minimum Product Opportunity Score to approve' },
  MAX_ACTIVE_LISTINGS: { v: 20, d: 'Hard cap on active listings (quality over quantity)' },

  // --- Cost model (section 7)
  RETURN_HANDLING_COST_SEK: { v: 60, d: 'Average cost of one return (shipping back, handling), SEK' },
  REFUND_RESERVE_PCT: { v: 2, d: 'Refund reserve % of revenue' },
  WARRANTY_RESERVE_PCT: { v: 1.5, d: 'Reklamation/warranty reserve % of revenue' },
  SOFTWARE_COST_PER_ORDER_SEK: { v: 5, d: 'Software/API cost allocation per order' },
  FX_BUFFER_PCT: { v: 2, d: 'FX risk buffer on non-SEK costs %' },
  AD_COST_PER_ORDER_SEK: { v: 0, d: 'Expected ad cost per order (0 = no ads at start)' },
  SUPPLIER_FEE_PER_ORDER_SEK: { v: 0, d: 'Supplier dropship/handling fee per order' },
  DEFAULT_CUSTOMS_PCT: { v: 0, d: 'Customs % for non-EU origin (EU warehouses => 0)' },

  // --- Spending limits (section 16)
  DAILY_PURCHASE_LIMIT_SEK: { v: 3000, d: 'Max total supplier purchases per day' },
  MAX_ORDER_VALUE_SEK: { v: 1500, d: 'Max single order value without approval' },
  MAX_AD_SPEND_DAY_SEK: { v: 0, d: 'Max ad spend per day' },
  MAX_TOTAL_OPEN_SUPPLIER_ORDERS_SEK: { v: 10000, d: 'Max value of undelivered supplier orders' },
  MIN_CASH_BUFFER_SEK: { v: 5000, d: 'Minimum cash buffer (owner-reported or bank feed)' },
  MAX_REFUND_WITHOUT_APPROVAL_SEK: { v: 300, d: 'Max refund the system may do without approval' },
  CURRENT_CASH_SEK: { v: 0, d: 'Available cash (update manually or via bank/accounting integration)' },

  // --- Pricing (section 11)
  MAX_PRICE_CHANGE_PCT_PER_RUN: { v: 5, d: 'Max price change per repricing run %' },
  MIN_HOURS_BETWEEN_PRICE_CHANGES: { v: 6, d: 'Cool-down between price changes per listing' },
  PRICE_CEILING_MULTIPLIER: { v: 1.8, d: 'Max price = floor × multiplier' },
  UNDERCUT_SEK: { v: 0, d: 'Undercut vs lowest competitor (0 = match, avoids price wars)' },

  // --- Inventory (section 10)
  SAFETY_STOCK: { v: 5, d: 'At/below this supplier stock the listing is paused' },
  MAX_LISTED_QTY: { v: 10, d: 'Max quantity exposed on a listing' },

  // --- Account health (section 15) — stricter than marketplace targets
  MAX_ODR_PCT: { v: 0.5, d: 'Pause if order defect rate above (Amazon target <1%)' },
  MAX_LATE_SHIPMENT_PCT: { v: 2, d: 'Pause if late shipment rate above (Amazon target <4%)' },
  MAX_CANCEL_RATE_PCT: { v: 1.5, d: 'Pause if pre-fulfilment cancel rate above (Amazon target <2.5%)' },
  MIN_VALID_TRACKING_PCT: { v: 97, d: 'Pause if valid tracking rate below (Amazon target >95%)' },
  TRACKING_MISSING_AFTER_HOURS: { v: 48, d: 'Alert if no tracking this many hours after supplier order' },

  // --- Lifecycle: test → winner → scale / kill
  TEST_PERIOD_DAYS: { v: 21, d: 'Test period before a product must hit minimum KPIs' },
  MIN_TEST_ORDERS: { v: 5, d: 'Minimum orders during test period, else KILL' },
  WINNER_MIN_ORDERS_30D: { v: 20, d: 'Orders in 30 days to be classified WINNER' },
  WINNER_MIN_CONTRIBUTION_MARGIN_PCT: { v: 18, d: 'Min real contribution margin % (after ads) for WINNER' },
  MAX_REAL_RETURN_RATE_PCT: { v: 10, d: 'Observed return rate above this => pause & investigate' },
  MAX_NEW_PRODUCT_TEST_BUDGET_SEK: { v: 1500, d: 'Max ad + sample spend per product test' },

  // --- Capital & cash flow
  MAX_SINGLE_PURCHASE_SEK: { v: 5000, d: 'Max single inventory/wholesale purchase without approval' },
  MAX_INVENTORY_COMMITMENT_SEK: { v: 20000, d: 'Max total open inventory commitments' },
  FIXED_COSTS_MONTHLY_SEK: { v: 2500, d: 'Fixed monthly costs (subscriptions, tools). Owner-maintained' },
  PAYOUT_DELAY_DAYS: { v: 14, d: 'Assumed days from sale to marketplace payout (scenario assumption until payout data exists)' },
  VAT_PAYMENT_INTERVAL_DAYS: { v: 90, d: 'VAT settlement interval (90 = quarterly, 30 = monthly)' },

  // --- Advertising (profit-first)
  MIN_PROFIT_AFTER_ADS_SEK: { v: 30, d: 'Min profit per order after advertising' },
  AD_SCALE_STEP_PCT: { v: 15, d: 'Budget increase step for profitable campaigns' },

  // --- Automation switches & staged go-live (section 24.15)
  AUTOMATION_ENABLED: { v: true, d: 'Global kill switch' },
  GO_LIVE_STAGE: { v: 0, d: '0=read-only research, 1=+listings, 2=+auto orders, 3=+repricing, 4=full' },
  AUTO_REFUNDS: { v: false, d: 'Allow automatic refunds under the limit' },
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type Settings = { [K in SettingKey]: (typeof DEFAULT_SETTINGS)[K]['v'] extends boolean ? boolean : number };

export function defaults(): Settings {
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(DEFAULT_SETTINGS)) out[k] = s.v;
  return out as Settings;
}

export async function seedSettings(q: Q = db()) {
  for (const [k, s] of Object.entries(DEFAULT_SETTINGS)) {
    await q.query(
      `INSERT INTO system_settings(key, value, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      [k, JSON.stringify(s.v), s.d],
    );
  }
}

export async function loadSettings(q: Q = db()): Promise<Settings> {
  const rows = await many<{ key: string; value: unknown }>('SELECT key, value FROM system_settings', [], q);
  const s = defaults() as Record<string, unknown>;
  for (const r of rows) if (r.key in s) s[r.key] = r.value;
  return s as Settings;
}

export async function updateSetting(key: string, value: unknown, actor: string) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error('Unknown setting ' + key);
  const expected = typeof (DEFAULT_SETTINGS as any)[key].v;
  if (typeof value !== expected) throw new Error(`Setting ${key} must be ${expected}`);
  const old = await many('SELECT value FROM system_settings WHERE key=$1', [key]);
  await db().query(`UPDATE system_settings SET value=$2, updated_at=now(), updated_by=$3 WHERE key=$1`, [key, JSON.stringify(value), actor]);
  await db().query(`INSERT INTO audit_logs(actor, entity, entity_id, change) VALUES ($1,'system_settings',$2,$3)`, [
    actor, key, JSON.stringify({ from: old[0]?.value, to: value }),
  ]);
}
