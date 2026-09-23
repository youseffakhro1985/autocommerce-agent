/** Reporting Agent (sections 19 & weekly strategy). */
import { many, one, db } from '../db/pool.js';
import { notify } from '../services/alerts.js';

function stockholmDate(d = new Date()) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(d); }

export async function buildDailyReport(day?: string) {
  const d = day ?? stockholmDate(new Date(Date.now() - 864e5)); // yesterday (Stockholm)
  const range = [`${d} 00:00 Europe/Stockholm`, `${d} 23:59:59.999 Europe/Stockholm`];
  const fin = await one(`SELECT
      COALESCE(sum(amount_sek) FILTER (WHERE kind='SALE'),0) AS revenue,
      COALESCE(-sum(amount_sek) FILTER (WHERE kind IN ('SUPPLIER_COST','SHIPPING')),0) AS cogs,
      COALESCE(-sum(amount_sek) FILTER (WHERE kind='RESERVE'),0) AS reserves,
      COALESCE(-sum(amount_sek) FILTER (WHERE kind='MARKETPLACE_FEE'),0) AS fees,
      COALESCE(-sum(amount_sek) FILTER (WHERE kind='VAT_ESTIMATE'),0) AS vat,
      COALESCE(-sum(amount_sek) FILTER (WHERE kind='AD_SPEND'),0) AS ads,
      COALESCE(-sum(amount_sek) FILTER (WHERE kind='REFUND'),0) AS refunds,
      COALESCE(sum(amount_sek),0) AS net
    FROM transactions WHERE occurred_at BETWEEN $1::timestamptz AND $2::timestamptz`, range);
  const orders = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE status IN ('ON_HOLD','AWAITING_APPROVAL','ERROR'))::int problems FROM orders WHERE placed_at BETWEEN $1::timestamptz AND $2::timestamptz`, range);
  const best = await many(`SELECT l.sku, p.title, count(*)::int units, sum(oi.unit_price_sek*oi.quantity)::numeric(12,2) revenue
    FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN listings l ON l.id=oi.listing_id JOIN products p ON p.id=l.product_id
    WHERE o.placed_at > now() - interval '7 days' GROUP BY l.sku, p.title ORDER BY revenue DESC LIMIT 5`);
  const worst = await many(`SELECT l.sku, p.title, l.status, l.pause_reason FROM listings l JOIN products p ON p.id=l.product_id
    WHERE NOT EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.listing_id=l.id AND o.placed_at > now() - interval '14 days')
      AND l.created_at < now() - interval '14 days' LIMIT 5`);
  const opps = await many(`SELECT DISTINCT ON (ps.product_id) ps.product_id, p.title, ps.score, ps.decision FROM product_scores ps JOIN products p ON p.id=ps.product_id
    WHERE ps.created_at BETWEEN $1::timestamptz AND $2::timestamptz ORDER BY ps.product_id, ps.created_at DESC`, range);
  const newSuppliers = await many(`SELECT code, name, status FROM suppliers WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz`, range);
  const priceChanges = await one(`SELECT count(*)::int n FROM pricing_history WHERE applied AND reason <> 'initial listing' AND created_at BETWEEN $1::timestamptz AND $2::timestamptz`, range);
  const paused = await many(`SELECT sku, pause_reason FROM listings WHERE status='PAUSED' AND updated_at BETWEEN $1::timestamptz AND $2::timestamptz`, range);
  const returns = await one(`SELECT count(*)::int n FROM returns WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz`, range);
  const warnings = await many(`SELECT code, health_status, health_snapshot->'reasons' reasons FROM marketplaces WHERE enabled AND health_status NOT IN ('HEALTHY','UNKNOWN')`);
  const actions = await many(`SELECT severity, title, created_at FROM alerts WHERE requires_owner AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 20`);
  const approvals = await many(`SELECT kind, subject_ref FROM approval_requests WHERE status='PENDING'`);

  const top = opps.filter((o) => o.decision === 'APPROVED_FOR_LISTING').sort((a, b) => b.score - a.score).slice(0, 5);
  const body = { day: d, finance: fin, orders, best, worst, newOpportunities: top, evaluated: opps.length, newSuppliers, priceChanges: priceChanges?.n ?? 0, paused, returns: returns?.n ?? 0, warnings, actions, approvals };
  const kr = (n: any) => `${Math.round(Number(n)).toLocaleString('sv-SE')} SEK`;
  const text = [
    `AUTONOMOUS E-COMMERCE REPORT — ${d}`,
    `1. Sales: ${kr(fin.revenue)}`,
    `2. Net profit estimate: ${kr(fin.net)} (COGS incl. shipping ${kr(fin.cogs)}, fees ${kr(fin.fees)}, VAT ${kr(fin.vat)}, return/refund/warranty reserves ${kr(fin.reserves)}, ads ${kr(fin.ads)}, refunds ${kr(fin.refunds)})`,
    `3. Orders: ${orders?.n ?? 0} (${orders?.problems ?? 0} need attention)`,
    `4. Best products (7d): ${best.map((b) => `${b.sku} ${kr(b.revenue)}`).join(', ') || '—'}`,
    `5. Worst products (no sales 14d): ${worst.map((w) => w.sku).join(', ') || '—'}`,
    `6. New opportunities: ${top.map((t) => `#${t.product_id} ${t.title} (${Number(t.score).toFixed(0)})`).join('; ') || '—'} [${opps.length} evaluated]`,
    `7. New suppliers: ${newSuppliers.map((s) => `${s.code} (${s.status})`).join(', ') || '—'}`,
    `8. Price changes: ${priceChanges?.n ?? 0}`,
    `9. Listings paused: ${paused.map((p) => `${p.sku} (${p.pause_reason})`).join('; ') || '—'}`,
    `10. Returns: ${returns?.n ?? 0}`,
    `11. Marketplace warnings: ${warnings.map((w) => `${w.code} ${w.health_status}`).join('; ') || 'none'}`,
    `12. Problems requiring your action: ${actions.length + approvals.length ? '' : 'none'}`,
    ...actions.map((a) => `   - [${a.severity}] ${a.title}`),
    ...approvals.map((a) => `   - approve/reject ${a.kind} ${a.subject_ref} in dashboard`),
  ].join('\n');
  return { period: d, body, text };
}

export async function runDailyReport(force = false) {
  const nowLocalHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', hour12: false }).format(new Date()));
  if (!force && nowLocalHour < 7) return { skipped: 'before 07:00 Stockholm' };
  const r = await buildDailyReport();
  const ins = await db().query(`INSERT INTO reports(kind, period_key, body, text) VALUES ('DAILY',$1,$2,$3) ON CONFLICT (kind, period_key) DO NOTHING RETURNING id`, [r.period, JSON.stringify(r.body), r.text]);
  if (ins.rowCount) await notify(`Daily report ${r.period}`, r.text);
  return { period: r.period, created: !!ins.rowCount };
}

export async function runWeeklyStrategy() {
  const now = new Date();
  const jan1 = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const week = `${now.getUTCFullYear()}-W${String(Math.ceil(((+now - +jan1) / 864e5 + jan1.getUTCDay() + 1) / 7)).padStart(2, '0')}`;
  const r = await buildCeoReview();
  const ins = await db().query(`INSERT INTO reports(kind, period_key, body, text) VALUES ('WEEKLY',$1,$2,$3) ON CONFLICT (kind, period_key) DO NOTHING RETURNING id`, [week, JSON.stringify(r.body), r.text]);
  if (ins.rowCount) await notify(`CEO review ${week}`, r.text);
  return { week, created: !!ins.rowCount };
}

/** Weekly CEO review — every figure from the ledger; scenario items labelled. */
export async function buildCeoReview() {
  const { growthSnapshot } = await import('./growth.js');
  const { adMetrics } = await import('../domain/economics.js');
  const g = await growthSnapshot();
  const sum = (f: (x: any) => number) => g.skus.reduce((a: number, x: any) => a + f(x), 0);
  const orders = sum((x) => x.orders), revenue = sum((x) => x.revenueGross), contribution = sum((x) => x.contribution);
  const adAgg = g.ads.reduce((a: any, x: any) => ({ spend: a.spend + x.spend, adSales: a.adSales + x.ad_sales, adOrders: a.adOrders + x.ad_orders, clicks: a.clicks + x.clicks, impressions: a.impressions + x.impressions }), { spend: 0, adSales: 0, adOrders: 0, clicks: 0, impressions: 0 });
  const am = adMetrics({ ...adAgg, totalSales: revenue });
  const refunds = await one(`SELECT COALESCE(-sum(amount_sek),0)::float r FROM transactions WHERE kind='REFUND' AND occurred_at > now() - interval '30 days'`);
  const returns = sum((x) => x.returns);
  const killed = await many(`SELECT l.sku, l.pause_reason FROM listings l WHERE l.stage='KILLED' AND l.stage_changed_at > now() - interval '7 days'`);
  const newOpps = await many(`SELECT * FROM (SELECT DISTINCT ON (p.id) p.id, p.title, ps.score FROM product_scores ps JOIN products p ON p.id=ps.product_id WHERE ps.decision='APPROVED_FOR_LISTING' AND ps.created_at > now() - interval '7 days' ORDER BY p.id, ps.score DESC) x ORDER BY score DESC LIMIT 5`);
  const supplierOpps = g.winnersAnalyses.filter((w: any) => w.negotiation).map((w: any) => `${w.sku}: ${w.negotiation.current}→${w.negotiation.target} ${w.negotiation.currency}, saving ${w.negotiation.expectedSavingPerMonth} ${w.negotiation.currency}/mo`);
  const health = await many(`SELECT code, health_status, automation_state FROM marketplaces WHERE enabled`);
  const owner = await many(`SELECT title FROM alerts WHERE requires_owner AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 10`);
  const declining = g.skus.filter((x: any) => x.growthPct != null && x.growthPct < -20);
  const kr = (n: any) => `${Math.round(Number(n ?? 0)).toLocaleString('sv-SE')} SEK`;

  const actions: string[] = [];
  for (const o of g.path.options.slice(0, 3)) actions.push(`[${o.basis}] ${o.lever}: ${o.description}${o.estMonthlyProfitGain ? ` (≈ ${kr(o.estMonthlyProfitGain)}/mo)` : ''}`);
  for (const w of g.winnersAnalyses) for (const q of w.analysis.filter((q: any) => q.status === 'OPPORTUNITY' && q.estMonthlyImpactSek)) actions.push(`[${q.basis}] ${w.sku} — ${q.q} ${q.evidence} (≈ ${kr(q.estMonthlyImpactSek)}/mo)`);
  for (const k of g.top.kill) actions.push(`[REAL] Kill ${k.sku}: ${k.orders} orders, profit ${kr(k.contribution)}`);
  if (g.cash.forecast.breachDay != null) actions.unshift(`[SCENARIO] CASH: buffer breached in ${g.cash.forecast.breachDay} days — secure capital or slow purchases first`);
  if (!orders) actions.push('No real sales yet: complete the owner actions below so live research and listings can start.');

  const text = [
    `CEO REVIEW — ${new Date().toISOString().slice(0, 10)} (${g.mode.toUpperCase()}; last 30 days)`,
    `Revenue ${kr(revenue)} · Real contribution ${kr(contribution)} · Operating profit ${kr(g.currentProfit)} [${g.base.basis}]`,
    `Margin ${revenue ? ((contribution / revenue) * 100).toFixed(1) : '—'} % · Orders ${orders} · CAC ${am.cac ?? '—'} · ROAS ${am.roas ?? '—'} · Return rate ${orders ? ((returns / orders) * 100).toFixed(1) : '—'} % · Refunds ${kr(refunds?.r)}`,
    `Top winners: ${g.top.profit.slice(0, 3).map((x: any) => `${x.sku} ${kr(x.contribution)}`).join(', ') || '—'}`,
    `Declining: ${declining.map((x: any) => `${x.sku} ${x.growthPct} %`).join(', ') || '—'}`,
    `Killed this week: ${killed.map((k) => k.sku).join(', ') || '—'}`,
    `New opportunities: ${newOpps.map((o) => `#${o.id} ${o.title} (${Number(o.score).toFixed(0)})`).join('; ') || '—'}`,
    `Supplier opportunities: ${supplierOpps.join('; ') || '—'}`,
    `Cash flow: 7d ${kr(g.cash.forecast.at[7])} · 30d ${kr(g.cash.forecast.at[30])} · 90d ${kr(g.cash.forecast.at[90])}${g.cash.forecast.breachDay != null ? ` · BREACH day ${g.cash.forecast.breachDay}` : ''}`,
    `Marketplace health: ${health.map((h) => `${h.code} ${h.health_status}/${h.automation_state}`).join(', ')}`,
    `Target ${g.nextTarget.toLocaleString('sv-SE')} SEK: gap ${kr(Math.max(0, g.nextTarget - g.currentProfit))}`,
    '', 'WHAT SHOULD WE DO NEXT TO MAXIMIZE PROFIT?', ...actions.slice(0, 8).map((a, i) => `${i + 1}. ${a}`),
    ...(owner.length ? ['', 'Needs you:', ...owner.map((o) => `- ${o.title}`)] : []),
  ].join('\n');
  return { body: { revenue, contribution, orders, actions, path: g.path, cash: g.cash.forecast.at }, text };
}
