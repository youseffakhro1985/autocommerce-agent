/**
 * Growth agents: CFO (unit economics, targets, cash flow), Growth (lifecycle kill/winner, 80/20),
 * Procurement (winner engine, negotiation), Performance Marketing (profit-first ads).
 * All outputs are computed from the ledger; scenario numbers carry basis='SCENARIO'.
 */
import { many, one, db, tx } from '../db/pool.js';
import {
  skuEconomics, pareto, lifecycleDecision, targetRequirements, pathToTarget, cashForecast, adDecision, adMetrics, negotiationBrief,
  TARGETS, type SkuLedger, type SkuEconomics, type BusinessBase,
} from '../domain/economics.js';
import { calculateProfit } from '../domain/profit.js';
import type { Settings } from '../domain/settings.js';
import { logAction, audit } from '../services/audit.js';
import { raiseAlert, resolveAlert, requestApproval } from '../services/alerts.js';
import { toSek } from '../services/fx.js';
import { pauseListing } from './listing.js';
import { profitInputFor } from './evaluation.js';
import { ctx, estimateReturnRate } from './context.js';

// ---------------------------------------------------------------- ledger
export async function skuLedger(windowDays = 30): Promise<SkuEconomics[]> {
  const listings = await many(`SELECT l.id, l.sku, l.stage, l.fulfilment_model, l.created_at, l.stage_changed_at, p.title FROM listings l JOIN products p ON p.id=l.product_id`);
  const items = await many(`SELECT oi.order_id, oi.listing_id, oi.quantity, oi.unit_price_sek, o.placed_at, o.status
    FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.placed_at > now() - ($1 * 2 || ' days')::interval AND oi.listing_id IS NOT NULL`, [windowDays]);
  const tr = await many(`SELECT order_id, kind, amount_sek FROM transactions WHERE order_id IS NOT NULL AND occurred_at > now() - ($1 * 2 || ' days')::interval`, [windowDays]);
  const rets = await many(`SELECT r.order_id FROM returns r JOIN orders o ON o.id=r.order_id WHERE o.placed_at > now() - ($1 || ' days')::interval`, [windowDays]);
  const ads = await many(`SELECT c.listing_id, sum(m.spend_sek)::float spend FROM ad_metrics_daily m JOIN ad_campaigns c ON c.id=m.campaign_id WHERE m.day > now()::date - $1::int GROUP BY 1`, [windowDays]);
  const cutoff = Date.now() - windowDays * 864e5;

  const byOrder = new Map<number, Record<string, number>>();
  for (const t of tr) { const m = byOrder.get(t.order_id) ?? {}; m[t.kind] = (m[t.kind] ?? 0) + Number(t.amount_sek); byOrder.set(t.order_id, m); }
  const orderRevenue = new Map<number, number>();
  for (const it of items) orderRevenue.set(it.order_id, (orderRevenue.get(it.order_id) ?? 0) + Number(it.unit_price_sek) * it.quantity);
  const returned = new Set(rets.map((r) => r.order_id));

  const out: SkuEconomics[] = [];
  for (const l of listings) {
    const L: SkuLedger = { sku: l.sku, listingId: l.id, title: l.title, stage: l.stage, fulfilment: l.fulfilment_model, orders: 0, units: 0,
      revenueGross: 0, vat: 0, cogs: 0, shipping: 0, fees: 0, reserves: 0, ads: 0, refunds: 0, returns: 0,
      daysActive: Math.max(1, Math.min(windowDays, Math.ceil((Date.now() - new Date(l.created_at).getTime()) / 864e5))),
      daysInStage: (Date.now() - new Date(l.stage_changed_at).getTime()) / 864e5, ordersPrev: 0, profitPrev: 0 };
    const seenOrders = new Set<number>();
    for (const it of items.filter((x) => x.listing_id === l.id)) {
      const t = byOrder.get(it.order_id);
      if (!t || !t.SALE) continue; // only orders that were actually fulfilled & booked
      const share = (Number(it.unit_price_sek) * it.quantity) / (orderRevenue.get(it.order_id) || 1);
      const recent = new Date(it.placed_at).getTime() >= cutoff;
      const contrib = share * ((t.SALE ?? 0) + (t.VAT_ESTIMATE ?? 0) + (t.SUPPLIER_COST ?? 0) + (t.SHIPPING ?? 0) + (t.MARKETPLACE_FEE ?? 0) + (t.RESERVE ?? 0) + (t.REFUND ?? 0));
      if (!recent) { if (!seenOrders.has(it.order_id)) L.ordersPrev++; L.profitPrev += contrib; continue; }
      if (!seenOrders.has(it.order_id)) { L.orders++; if (returned.has(it.order_id)) L.returns++; }
      seenOrders.add(it.order_id);
      L.units += it.quantity;
      L.revenueGross += share * (t.SALE ?? 0);
      L.vat += -share * (t.VAT_ESTIMATE ?? 0);
      L.cogs += -share * (t.SUPPLIER_COST ?? 0);
      L.shipping += -share * (t.SHIPPING ?? 0);
      L.fees += -share * (t.MARKETPLACE_FEE ?? 0);
      L.reserves += -share * (t.RESERVE ?? 0);
      L.refunds += -share * (t.REFUND ?? 0);
    }
    L.ads = Number(ads.find((a) => a.listing_id === l.id)?.spend ?? 0);
    out.push(skuEconomics(L));
  }
  return out;
}

export function businessBase(skus: SkuEconomics[], s: Settings): BusinessBase {
  const sum = (f: (x: SkuEconomics) => number) => skus.reduce((a, x) => a + f(x), 0);
  const orders = sum((x) => x.orders), revenue = sum((x) => x.revenueGross), contribution = sum((x) => x.contribution);
  const winners = skus.filter((x) => x.stage === 'WINNER' || x.stage === 'SCALING');
  const selling = skus.filter((x) => x.orders > 0);
  const base = winners.length ? winners : selling;
  const basis = orders >= 30 ? 'REAL' : orders > 0 ? 'SCENARIO' : 'INSUFFICIENT_DATA';
  return {
    basis, monthlyRevenueGross: revenue, monthlyContribution: contribution, monthlyOrders: orders, fixedCosts: s.FIXED_COSTS_MONTHLY_SEK,
    contributionMarginPct: revenue > 0 ? (contribution / revenue) * 100 : 0,
    aov: orders ? revenue / orders : 0, profitPerOrder: orders ? contribution / orders : 0,
    winners: winners.length,
    ordersPerWinnerPerDay: base.length ? base.reduce((a, x) => a + x.orders / x.daysActive, 0) / base.length : 0,
    profitPerWinnerMonth: base.length ? (base.reduce((a, x) => a + x.contribution / x.daysActive, 0) / base.length) * 30 : 0,
    adCostPerOrder: orders ? sum((x) => x.ads) / orders : 0, cogsPerOrder: orders ? (sum((x) => x.cogs) + sum((x) => x.shipping)) / orders : 0,
    payoutDelayDays: s.PAYOUT_DELAY_DAYS, supplierPrepayDays: 0,
  };
}

// ---------------------------------------------------------------- snapshot for dashboard / reports
export async function growthSnapshot() {
  const c = await ctx();
  const skus = await skuLedger(30);
  const base = businessBase(skus, c.s);
  const currentProfit = Math.round(base.monthlyContribution - base.fixedCosts);
  const extras = await pathExtras(skus);
  const targets = TARGETS.map((t) => ({ ...targetRequirements(base, t), gap: Math.max(0, t - currentProfit), reached: currentProfit >= t && base.basis === 'REAL' }));
  const nextTarget = TARGETS.find((t) => t > currentProfit) ?? TARGETS[TARGETS.length - 1];
  const path = pathToTarget(base, currentProfit, nextTarget, extras);
  const pathTo200k = pathToTarget(base, currentProfit, 200_000, extras);
  const sorted = (f: (x: SkuEconomics) => number | null) => [...skus].filter((x) => f(x) != null).sort((a, b) => (f(b) ?? 0) - (f(a) ?? 0));
  const topOpp = await many(`SELECT DISTINCT ON (ps.product_id) ps.product_id, p.title, ps.score FROM product_scores ps JOIN products p ON p.id=ps.product_id
     WHERE ps.decision='APPROVED_FOR_LISTING' AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.product_id=p.id) ORDER BY ps.product_id, ps.created_at DESC`);
  const kill = skus.filter((x) => x.stage !== 'KILLED' && lifecycleDecision(x, x.daysInStage ?? 0, c.s).action === 'KILL');
  const cash = await cashSnapshot(c.s, skus);
  const winnersAnalyses = await many(`SELECT DISTINCT ON (w.listing_id) w.*, l.sku FROM winner_analyses w JOIN listings l ON l.id=w.listing_id ORDER BY w.listing_id, w.created_at DESC`);
  const adRows = await adSummary(30);
  return {
    mode: c.mode, skus, base, currentProfit, targets, nextTarget, path, pathTo200k, pareto: pareto(skus),
    top: {
      profit: sorted((x) => x.contribution).slice(0, 5), growth: sorted((x) => x.growthPct).slice(0, 5),
      margin: sorted((x) => (x.orders >= 3 ? x.contributionMarginPct : null)).slice(0, 5),
      opportunity: topOpp.sort((a, b) => b.score - a.score).slice(0, 5), kill,
    },
    cash, winnersAnalyses, ads: adRows,
  };
}

async function pathExtras(skus: SkuEconomics[]) {
  // Wholesale: verified quotes cheaper than current supplier, × real monthly units.
  const rows = await many(`SELECT l.id listing_id, sp.cost_price, sp.cost_currency, q.unit_price, q.currency, q.freight_per_unit
    FROM listings l JOIN supplier_products sp ON sp.id=l.supplier_product_id JOIN supplier_quotes q ON q.product_id=l.product_id AND q.verified`);
  let wholesale = 0;
  for (const r of rows) {
    const sku = skus.find((s) => s.listingId === r.listing_id);
    if (!sku || !sku.units) continue;
    const cur = await toSek(Number(r.cost_price), r.cost_currency);
    const alt = await toSek(Number(r.unit_price) + Number(r.freight_per_unit ?? 0), r.currency);
    if (alt < cur) wholesale += (cur - alt) * sku.units;
  }
  // Expansion: winners' approved profit calcs on marketplaces where they are not yet listed (scenario: same orders/day as today).
  const exp = await many(`SELECT l.id listing_id, pc.net_profit FROM listings l
    JOIN LATERAL (SELECT DISTINCT ON (ps.marketplace_code) ps.marketplace_code, ps.decision, ps.profit_calc_id FROM product_scores ps WHERE ps.product_id=l.product_id ORDER BY ps.marketplace_code, ps.created_at DESC) x ON x.decision='APPROVED_FOR_LISTING'
    JOIN profit_calculations pc ON pc.id=x.profit_calc_id
    WHERE l.stage IN ('WINNER','SCALING') AND NOT EXISTS (SELECT 1 FROM listings l2 WHERE l2.product_id=l.product_id AND l2.marketplace_code=x.marketplace_code)`);
  let expansion = 0;
  for (const e of exp) { const s = skus.find((x) => x.listingId === e.listing_id); if (s) expansion += (s.orders / s.daysActive) * 30 * Number(e.net_profit); }
  // Price: latest competitor price above ours for winners (scenario: volume unchanged).
  const pr = await many(`SELECT l.id, l.price, l.max_price, (SELECT lowest_price FROM competitor_data c WHERE c.product_id=l.product_id AND c.marketplace_code=l.marketplace_code ORDER BY captured_at DESC LIMIT 1) comp
    FROM listings l WHERE l.stage IN ('WINNER','SCALING') AND l.status='ACTIVE'`);
  let price = 0;
  for (const p of pr) { const s = skus.find((x) => x.listingId === p.id); if (s && p.comp && Number(p.comp) > Number(p.price)) price += (Math.min(Number(p.comp), Number(p.max_price)) - Number(p.price)) * 0.8 * s.units; }
  return { wholesaleSavingMonthly: wholesale || null, expansionProfitMonthly: expansion || null, priceIncreaseGainMonthly: price || null };
}

async function cashSnapshot(s: Settings, skus: SkuEconomics[]) {
  const sum = (f: (x: SkuEconomics) => number) => skus.reduce((a, x) => a + f(x), 0);
  const days = 30;
  const rev = sum((x) => x.revenueGross) / days;
  const vatAcc = await one(`SELECT COALESCE(-sum(amount_sek),0)::float v FROM transactions WHERE kind='VAT_ESTIMATE' AND occurred_at > date_trunc('quarter', now())`);
  const pending = await many(`SELECT o.placed_at, COALESCE(sum(t.amount_sek) FILTER (WHERE t.kind IN ('SALE','MARKETPLACE_FEE')),0)::float net
    FROM orders o JOIN transactions t ON t.order_id=o.id WHERE o.placed_at > now() - ($1 || ' days')::interval GROUP BY o.id, o.placed_at`, [s.PAYOUT_DELAY_DAYS]);
  const events = await many(`SELECT kind, amount_sek::float amount, (due_date - now()::date) AS day FROM cash_events WHERE status='EXPECTED' AND due_date >= now()::date`);
  const q = new Date(); const nextQ = new Date(Date.UTC(q.getUTCFullYear(), Math.floor(q.getUTCMonth() / 3) * 3 + 3, 12));
  const input = {
    cashNow: s.CURRENT_CASH_SEK, minBuffer: s.MIN_CASH_BUFFER_SEK,
    dailyRevenueGross: rev, dailyPayoutNet: (sum((x) => x.revenueGross) - sum((x) => x.fees)) / days,
    dailyCogs: (sum((x) => x.cogs) + sum((x) => x.shipping)) / days, dailyAds: sum((x) => x.ads) / days, dailyVat: sum((x) => x.vat) / days,
    payoutDelayDays: s.PAYOUT_DELAY_DAYS, vatIntervalDays: s.VAT_PAYMENT_INTERVAL_DAYS, vatAccrued: Number(vatAcc?.v ?? 0),
    daysToNextVat: Math.max(1, Math.ceil((+nextQ - Date.now()) / 864e5)),
    pendingPayouts: pending.map((p) => ({ day: Math.max(1, s.PAYOUT_DELAY_DAYS - Math.floor((Date.now() - new Date(p.placed_at).getTime()) / 864e5)), amount: Number(p.net), kind: 'PAYOUT' })),
    commitments: events.map((e) => ({ day: Math.max(0, Number(e.day)), amount: Number(e.amount), kind: e.kind })),
    refundReserve: sum((x) => x.reserves),
  };
  return { input, forecast: cashForecast(input), basis: skus.some((x) => x.orders > 0) ? 'SCENARIO' : 'INSUFFICIENT_DATA',
    assumptions: [`payout ${s.PAYOUT_DELAY_DAYS} days after sale`, `run-rate = last 30 days`, `VAT settled every ${s.VAT_PAYMENT_INTERVAL_DAYS} days`, 'cash = CURRENT_CASH_SEK setting (connect bank feed to make REAL)'] };
}

async function adSummary(days: number) {
  return many(`SELECT c.id, c.status, c.daily_budget_sek, l.sku, COALESCE(sum(m.spend_sek),0)::float spend, COALESCE(sum(m.ad_sales_sek),0)::float ad_sales,
      COALESCE(sum(m.ad_orders),0)::int ad_orders, COALESCE(sum(m.clicks),0)::int clicks, COALESCE(sum(m.impressions),0)::int impressions, max(m.source) source
    FROM ad_campaigns c JOIN listings l ON l.id=c.listing_id LEFT JOIN ad_metrics_daily m ON m.campaign_id=c.id AND m.day > now()::date - $1::int
    GROUP BY c.id, l.sku ORDER BY spend DESC`, [days]);
}

// ---------------------------------------------------------------- lifecycle job
export async function runLifecycle() {
  const c = await ctx();
  if (!c.caps.research) return { skipped: 'automation disabled' };
  const skus = await skuLedger(30);
  const out: Record<string, number> = {};
  for (const e of skus) {
    const l = await one(`SELECT id, stage, status, stage_changed_at FROM listings WHERE id=$1`, [e.listingId]);
    if (!l || l.stage === 'KILLED' || l.status === 'DRAFT') continue;
    const days = (Date.now() - new Date(l.stage_changed_at).getTime()) / 864e5;
    const d = lifecycleDecision(e, days, c.s);
    if (d.action === 'KEEP') continue;
    out[d.action] = (out[d.action] ?? 0) + 1;
    const setStage = (stage: string) => tx(async (q) => {
      await q.query(`UPDATE listings SET stage=$2, stage_changed_at=now() WHERE id=$1`, [e.listingId, stage]);
      await audit('growth', 'listings', e.listingId, { stage: { from: l.stage, to: stage }, reasons: d.reasons }, q);
    });
    if (d.action === 'KILL') {
      await pauseListing(e.listingId, 'KILLED: ' + d.reasons.join('; '), 'growth');
      await setStage('KILLED');
      await db().query(`UPDATE ad_campaigns SET status='PAUSED' WHERE listing_id=$1`, [e.listingId]);
    } else if (d.action === 'PROMOTE_WINNER') {
      await setStage('WINNER');
      await runWinnerAnalysis(e.listingId);
      await raiseAlert({ severity: 'INFO', category: 'GROWTH', title: `New WINNER: ${e.sku} — winner analysis ready`, dedupeKey: `winner:${e.sku}` });
    } else if (d.action === 'PAUSE_INVESTIGATE') {
      await pauseListing(e.listingId, 'INVESTIGATE: ' + d.reasons.join('; '), 'growth');
      await raiseAlert({ severity: 'WARNING', category: 'GROWTH', title: `${e.sku} paused for investigation: ${d.reasons.join('; ')}`, dedupeKey: `investigate:${e.sku}`, requiresOwner: true });
    } else if (d.action === 'DEMOTE') await setStage('TEST');
    await logAction({ agent: 'growth', action: `LIFECYCLE_${d.action}`, subjectType: 'listing', subjectId: e.listingId, decision: d.action, reasons: d.reasons,
      data: { orders: e.orders, contribution: e.contribution, marginPct: e.contributionMarginPct, returnRatePct: e.returnRatePct } });
  }
  // Refresh winner analyses weekly
  for (const w of await many(`SELECT l.id FROM listings l WHERE l.stage IN ('WINNER','SCALING') AND NOT EXISTS (SELECT 1 FROM winner_analyses a WHERE a.listing_id=l.id AND a.created_at > now() - interval '7 days')`)) await runWinnerAnalysis(w.id);
  return out;
}

// ---------------------------------------------------------------- winner engine (15 questions)
type Q = { q: string; status: 'OPPORTUNITY' | 'NO' | 'INSUFFICIENT_DATA' | 'NEEDS_OWNER_ACTION' | 'BLOCKED'; evidence: string; estMonthlyImpactSek: number | null; basis: 'REAL' | 'SCENARIO' | 'NONE' };
export async function runWinnerAnalysis(listingId: number) {
  const c = await ctx();
  const l = await one(`SELECT l.*, p.id pid, p.title, p.category, sp.cost_price, sp.cost_currency, sp.shipping_cost, sp.shipping_currency, sp.moq, sp.supplier_id, sp.ships_from
    FROM listings l JOIN products p ON p.id=l.product_id JOIN supplier_products sp ON sp.id=l.supplier_product_id WHERE l.id=$1`, [listingId]);
  if (!l) return null;
  const e = (await skuLedger(30)).find((x) => x.listingId === listingId);
  const units = e?.units ?? 0;
  const mp = c.marketplaces.find((m) => m.code === l.marketplace_code) ?? { code: l.marketplace_code, vat_rate: 0.25 };
  const quotes = await many(`SELECT * FROM supplier_quotes WHERE product_id=$1 ORDER BY unit_price`, [l.pid]);
  const verified = quotes.filter((q) => q.verified);
  const curUnitSek = await toSek(Number(l.cost_price), l.cost_currency);
  const best = verified.length ? verified[0] : null;
  const bestSek = best ? await toSek(Number(best.unit_price) + Number(best.freight_per_unit ?? 0), best.currency) : null;
  const comp = await one(`SELECT lowest_price, buybox_price FROM competitor_data WHERE product_id=$1 AND marketplace_code=$2 ORDER BY captured_at DESC LIMIT 1`, [l.pid, l.marketplace_code]);
  const reviews = await many(`SELECT theme, mentions FROM review_insights WHERE product_id=$1 ORDER BY mentions DESC LIMIT 5`, [l.pid]);
  const multiItem = await one(`SELECT count(*) FILTER (WHERE q > 1)::int multi, count(*)::int n FROM (SELECT oi.order_id, sum(oi.quantity) q FROM order_items oi WHERE oi.listing_id=$1 GROUP BY 1) x`, [listingId]);
  const otherMarkets = await many(`SELECT DISTINCT ON (ps.marketplace_code) ps.marketplace_code, ps.decision, pc.net_profit FROM product_scores ps LEFT JOIN profit_calculations pc ON pc.id=ps.profit_calc_id
    WHERE ps.product_id=$1 AND ps.marketplace_code<>$2 ORDER BY ps.marketplace_code, ps.created_at DESC`, [l.pid, l.marketplace_code]);
  const ads = (await adSummary(30)).find((a) => a.sku === l.sku);
  const monthlyUnits = e ? Math.round((units / e.daysActive) * 30) : 0;

  // Unit cost that would deliver the target contribution margin at the current price.
  const pin = await profitInputFor(l, mp, Number(l.price), c.s, estimateReturnRate(l.category), l.category);
  const pr = calculateProfit(pin, { minNetMarginPct: c.s.WINNER_MIN_CONTRIBUTION_MARGIN_PCT + 10, minProfitSek: c.s.MIN_PROFIT_PER_ORDER_SEK });

  const Qs: Q[] = [];
  Qs.push(best && bestSek! < curUnitSek
    ? { q: '1. Lower purchase price?', status: 'OPPORTUNITY', evidence: `Verified quote ${best.unit_price} ${best.currency} from ${best.supplier_name} vs current ${l.cost_price} ${l.cost_currency}`, estMonthlyImpactSek: Math.round((curUnitSek - bestSek!) * monthlyUnits), basis: 'REAL' }
    : { q: '1. Lower purchase price?', status: quotes.length ? 'NO' : 'INSUFFICIENT_DATA', evidence: quotes.length ? 'No verified cheaper quote' : 'No alternative quotes yet — procurement agent requests quotes', estMonthlyImpactSek: null, basis: 'NONE' });
  const mfr = quotes.find((q) => q.supplier_type === 'MANUFACTURER');
  Qs.push({ q: '2. Direct from manufacturer?', status: mfr ? (mfr.verified ? 'OPPORTUNITY' : 'NEEDS_OWNER_ACTION') : 'INSUFFICIENT_DATA', evidence: mfr ? `${mfr.supplier_name}: ${mfr.unit_price} ${mfr.currency}, MOQ ${mfr.moq}` : 'No manufacturer quote on file', estMonthlyImpactSek: null, basis: mfr ? 'REAL' : 'NONE' });
  Qs.push({ q: '3. Larger volume purchase?', status: monthlyUnits >= (best?.moq ?? 50) ? 'OPPORTUNITY' : 'NO', evidence: `Real run-rate ${monthlyUnits} units/month${best ? `, best quote MOQ ${best.moq}` : ''}`, estMonthlyImpactSek: null, basis: 'REAL' });
  Qs.push({ q: '4. Amazon FBA?', status: l.marketplace_code.startsWith('AMAZON') ? 'INSUFFICIENT_DATA' : 'NO', evidence: l.marketplace_code.startsWith('AMAZON') ? 'Needs FBA fee estimate (Product Fees API, IsAmazonFulfilled=true) + inbound freight quote' : 'Not an Amazon listing', estMonthlyImpactSek: null, basis: 'NONE' });
  Qs.push({ q: '5. EU 3PL?', status: monthlyUnits >= 100 ? 'NEEDS_OWNER_ACTION' : 'NO', evidence: monthlyUnits >= 100 ? `${monthlyUnits} units/month justifies 3PL quotes (owner to request)` : `${monthlyUnits} units/month — below 100/month threshold`, estMonthlyImpactSek: null, basis: 'REAL' });
  Qs.push({ q: '6. Own improved version?', status: reviews.length ? 'OPPORTUNITY' : 'BLOCKED', evidence: reviews.length ? 'Top complaints: ' + reviews.map((r) => `${r.theme} (${r.mentions})`).join(', ') : 'No licensed review-text source connected (marketplace review scraping is not used)', estMonthlyImpactSek: null, basis: reviews.length ? 'REAL' : 'NONE' });
  Qs.push({ q: '7. Bundle?', status: (multiItem?.multi ?? 0) > 0 ? 'OPPORTUNITY' : 'INSUFFICIENT_DATA', evidence: `${multiItem?.multi ?? 0} of ${multiItem?.n ?? 0} orders had >1 unit`, estMonthlyImpactSek: null, basis: 'REAL' });
  const compPrice = comp?.buybox_price ?? comp?.lowest_price;
  Qs.push(compPrice && Number(compPrice) > Number(l.price)
    ? { q: '8. Raise price?', status: 'OPPORTUNITY', evidence: `Competitor ${compPrice} SEK vs ours ${l.price} SEK (ceiling ${l.max_price})`, estMonthlyImpactSek: Math.round((Math.min(Number(compPrice), Number(l.max_price)) - Number(l.price)) * 0.8 * monthlyUnits), basis: 'SCENARIO' }
    : { q: '8. Raise price?', status: 'NO', evidence: compPrice ? `Already at/above competitor (${compPrice} SEK)` : 'No competitor price', estMonthlyImpactSek: null, basis: 'NONE' });
  Qs.push({ q: '9. Multipack?', status: (multiItem?.multi ?? 0) / Math.max(1, multiItem?.n ?? 1) >= 0.15 ? 'OPPORTUNITY' : 'NO', evidence: `Multi-unit order share ${Math.round(((multiItem?.multi ?? 0) / Math.max(1, multiItem?.n ?? 1)) * 100)} % (threshold 15 %)`, estMonthlyImpactSek: null, basis: 'REAL' });
  const exp = otherMarkets.filter((m) => m.decision === 'APPROVED_FOR_LISTING');
  Qs.push({ q: '10. More countries?', status: exp.length ? 'OPPORTUNITY' : 'NO', evidence: otherMarkets.length ? otherMarkets.map((m) => `${m.marketplace_code}: ${m.decision}${m.net_profit != null ? ` (${m.net_profit} SEK/order)` : ''}`).join('; ') : 'Not evaluated elsewhere yet', estMonthlyImpactSek: exp.length && e ? Math.round(exp.reduce((a, m) => a + Number(m.net_profit ?? 0), 0) * (e.orders / e.daysActive) * 30) : null, basis: 'SCENARIO' });
  Qs.push({ q: '11. Negotiate exclusivity?', status: monthlyUnits >= 200 ? 'NEEDS_OWNER_ACTION' : 'NO', evidence: `${monthlyUnits} units/month (exclusivity usually needs ≥200/month)`, estMonthlyImpactSek: null, basis: 'REAL' });
  Qs.push({ q: '12. Own brand?', status: 'NEEDS_OWNER_ACTION', evidence: 'Requires trademark registration (EUIPO/PRV) + Amazon Brand Registry — owner decision', estMonthlyImpactSek: null, basis: 'NONE' });
  Qs.push({ q: '13. Improve product from reviews?', status: reviews.length ? 'OPPORTUNITY' : 'BLOCKED', evidence: reviews.length ? reviews.map((r) => r.theme).join(', ') : 'Needs permitted review data source', estMonthlyImpactSek: null, basis: reviews.length ? 'REAL' : 'NONE' });
  const am = ads ? adMetrics({ spend: ads.spend, adSales: ads.ad_sales, adOrders: ads.ad_orders, clicks: ads.clicks, impressions: ads.impressions, totalSales: e?.revenueGross ?? 0 }) : null;
  Qs.push({ q: '14. Lower CAC?', status: am?.cac != null ? 'OPPORTUNITY' : 'INSUFFICIENT_DATA', evidence: am?.cac != null ? `CAC ${am.cac} SEK, CVR ${am.cvrPct} %, CPC ${am.cpc} SEK` : 'No ad data', estMonthlyImpactSek: null, basis: am ? 'REAL' : 'NONE' });
  Qs.push({ q: '15. Higher AOV?', status: 'INSUFFICIENT_DATA', evidence: `AOV ${e && e.orders ? Math.round(e.revenueGross / e.orders) : '—'} SEK; test bundle/multipack variants to raise it`, estMonthlyImpactSek: null, basis: e?.orders ? 'REAL' : 'NONE' });

  const brief = negotiationBrief({
    sku: l.sku, currentUnit: Number(l.cost_price), currency: l.cost_currency, monthlyUnits,
    bestQuote: best && best.currency === l.cost_currency ? { unit: Number(best.unit_price), supplier: best.supplier_name, moq: best.moq } : null,
    unitAtTargetMargin: Math.round((pr.maxSupplierCost / (await toSek(1, l.cost_currency))) * 100) / 100,
  });
  const r = await one(`INSERT INTO winner_analyses(listing_id, analysis, negotiation) VALUES ($1,$2,$3) RETURNING id`, [listingId, JSON.stringify(Qs), brief ? JSON.stringify(brief) : null]);
  await logAction({ agent: 'winner-engine', action: 'WINNER_ANALYSIS', subjectType: 'listing', subjectId: listingId,
    data: { opportunities: Qs.filter((q) => q.status === 'OPPORTUNITY').map((q) => q.q), negotiationSavingSek: brief?.expectedSavingPerMonth ?? null } });
  return r?.id ?? null;
}

// ---------------------------------------------------------------- cash-flow guard
export async function runCashGuard() {
  const c = await ctx();
  const skus = await skuLedger(30);
  const cash = await cashSnapshot(c.s, skus);
  const f = cash.forecast;
  if (c.s.CURRENT_CASH_SEK <= 0) {
    await raiseAlert({ severity: 'WARNING', category: 'OWNER_ACTION', title: 'NEEDS OWNER ACTION: set CURRENT_CASH_SEK (available business cash) in Settings — cash-flow forecast and order spending stay blocked until then', dedupeKey: 'cash-unset', requiresOwner: true });
    return { skipped: 'cash not set' };
  }
  await resolveAlert('cash-unset');
  if (f.breachDay != null && f.breachDay <= 60) {
    await raiseAlert({ severity: f.breachDay <= 14 ? 'CRITICAL' : 'WARNING', category: 'CASH', title: `Cash forecast: buffer ${c.s.MIN_CASH_BUFFER_SEK} SEK breached in ${f.breachDay} days (min ${Math.round(f.minCash)} SEK day ${f.minDay})`, dedupeKey: 'cash-breach', requiresOwner: true });
  } else await resolveAlert('cash-breach');
  return { at: f.at, breachDay: f.breachDay };
}

// ---------------------------------------------------------------- ads (profit-first)
export async function runAds() {
  const c = await ctx();
  const rows = await adSummary(7);
  const skus = await skuLedger(30);
  let changed = 0;
  // Simulation only: produce labelled synthetic ad metrics so the engine can be exercised.
  if (c.mode === 'simulation' && process.env.SIM_DEMAND === '1') await simulateAdMetrics();
  for (const a of rows) {
    const sku = skus.find((s) => s.sku === a.sku);
    if (!sku || a.status !== 'ACTIVE') continue;
    const beforeAds = sku.orders ? (sku.contribution + sku.ads) / sku.orders : 0;
    const d = adDecision({ spend: a.spend, adSales: a.ad_sales, adOrders: a.ad_orders, clicks: a.clicks, impressions: a.impressions, totalSales: sku.revenueGross },
      beforeAds, c.s.MIN_PROFIT_AFTER_ADS_SEK, Number(a.daily_budget_sek), c.s.MAX_AD_SPEND_DAY_SEK, c.s.AD_SCALE_STEP_PCT);
    if (d.action === 'HOLD') continue;
    // Real ad changes need the Amazon Ads API adapter (not connected) → recorded as recommendation outside simulation.
    const apply = c.mode === 'simulation';
    if (apply) await db().query(`UPDATE ad_campaigns SET daily_budget_sek=$2, status=CASE WHEN $3 THEN 'PAUSED' ELSE status END WHERE id=$1`, [a.id, d.newBudget, d.action === 'PAUSE']);
    await logAction({ agent: 'ads', action: `AD_${d.action}`, subjectType: 'ad_campaign', subjectId: a.id, decision: d.action, reasons: [d.reason], data: d, dryRun: !apply });
    changed++;
  }
  // Auto-create test campaigns for TEST listings only within test budget and daily cap.
  if (c.s.MAX_AD_SPEND_DAY_SEK > 0) {
    const perCampaign = Math.min(c.s.MAX_NEW_PRODUCT_TEST_BUDGET_SEK / c.s.TEST_PERIOD_DAYS, c.s.MAX_AD_SPEND_DAY_SEK);
    const used = await one(`SELECT COALESCE(sum(daily_budget_sek),0)::float b FROM ad_campaigns WHERE status='ACTIVE'`);
    for (const l of await many(`SELECT l.id, l.marketplace_code FROM listings l WHERE l.status='ACTIVE' AND l.stage IN ('TEST','WINNER') AND NOT EXISTS (SELECT 1 FROM ad_campaigns c WHERE c.listing_id=l.id)`)) {
      if (Number(used?.b ?? 0) + perCampaign > c.s.MAX_AD_SPEND_DAY_SEK) break;
      await db().query(`INSERT INTO ad_campaigns(listing_id, marketplace_code, daily_budget_sek) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [l.id, l.marketplace_code, Math.round(perCampaign * 100) / 100]);
      used!.b = Number(used!.b) + perCampaign;
    }
  }
  return { reviewed: rows.length, changed };
}

async function simulateAdMetrics() {
  for (const cmp of await many(`SELECT c.id, c.daily_budget_sek, l.price FROM ad_campaigns c JOIN listings l ON l.id=c.listing_id WHERE c.status='ACTIVE'`)) {
    const spend = Number(cmp.daily_budget_sek) * (0.7 + Math.random() * 0.3);
    const clicks = Math.round(spend / 3.5), orders = Math.round(clicks * (0.04 + Math.random() * 0.08));
    await db().query(`INSERT INTO ad_metrics_daily(campaign_id, day, impressions, clicks, spend_sek, ad_sales_sek, ad_orders, source) VALUES ($1, now()::date, $2,$3,$4,$5,$6,'SIMULATION')
      ON CONFLICT (campaign_id, day) DO NOTHING`, [cmp.id, clicks * 40, clicks, Math.round(spend * 100) / 100, orders * Number(cmp.price), orders]);
  }
}

export async function requestInventoryPurchase(listingId: number, units: number, unitSek: number) {
  const c = await ctx();
  const total = units * unitSek;
  const open = await one(`SELECT COALESCE(-sum(amount_sek),0)::float v FROM cash_events WHERE kind='INVENTORY' AND status='EXPECTED'`);
  // Inventory purchases ALWAYS go to the owner for approval in this version; limits are shown with the request.
  return requestApproval('INVENTORY_PURCHASE', `${listingId}:${units}`, {
    listingId, units, unitSek, totalSek: total, openCommitmentsSek: Number(open?.v ?? 0),
    exceedsSingleLimit: total > c.s.MAX_SINGLE_PURCHASE_SEK, exceedsCommitmentLimit: Number(open?.v ?? 0) + total > c.s.MAX_INVENTORY_COMMITMENT_SEK,
  });
}
