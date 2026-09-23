/** Server-rendered owner dashboard (section 18). All dynamic text is HTML-escaped (supplier/market data is untrusted). */
import { many, one } from '../db/pool.js';
import { loadSettings, DEFAULT_SETTINGS } from '../domain/settings.js';
import { env } from '../config/env.js';
import { JOBS } from '../scheduler.js';

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const kr = (n: unknown) => `${Math.round(Number(n ?? 0)).toLocaleString('sv-SE')} kr`;
const pct = (n: unknown) => (n == null ? '—' : `${Number(n).toFixed(1)} %`);

export async function loadDashboard() {
  const today = await one(`SELECT
      COALESCE(sum(amount_sek) FILTER (WHERE kind='SALE'),0) revenue,
      COALESCE(sum(amount_sek) FILTER (WHERE kind IN ('SALE','SUPPLIER_COST','SHIPPING','VAT_ESTIMATE')),0) gross,
      COALESCE(sum(amount_sek),0) net,
      COALESCE(-sum(amount_sek) FILTER (WHERE kind='AD_SPEND'),0) ads
    FROM transactions WHERE occurred_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm'`);
  const todayOrders = await one(`SELECT count(*)::int n FROM orders WHERE placed_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm'`);
  const todayReturns = await one(`SELECT count(*)::int n FROM returns WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm'`);
  const products = await one(`SELECT
      count(*) FILTER (WHERE status='ACTIVE')::int active, count(*) FILTER (WHERE status='PAUSED')::int paused,
      count(*) FILTER (WHERE status IN ('RESEARCHING','REQUIRES_VERIFICATION','APPROVED_FOR_LISTING'))::int researching,
      count(*) FILTER (WHERE status IN ('REJECTED','BLOCKED'))::int rejected,
      count(*) FILTER (WHERE status='REQUIRES_VERIFICATION')::int verify FROM products`);
  const listingsPaused = await one(`SELECT count(*)::int n FROM listings WHERE status='PAUSED'`);
  const opps = await many(`SELECT * FROM (SELECT DISTINCT ON (ps.product_id) ps.product_id, p.title, p.status, ps.score, ps.decision, ps.decision_reasons, ps.marketplace_code,
        pc.net_profit, pc.net_margin_pct, pc.sale_price_gross, pc.min_allowed_price, cd.offer_count, s.code supplier, s.reliability_score
      FROM product_scores ps JOIN products p ON p.id=ps.product_id LEFT JOIN profit_calculations pc ON pc.id=ps.profit_calc_id
      LEFT JOIN supplier_products sp ON sp.id=ps.supplier_product_id LEFT JOIN suppliers s ON s.id=sp.supplier_id
      LEFT JOIN LATERAL (SELECT offer_count FROM competitor_data c WHERE c.product_id=p.id ORDER BY captured_at DESC LIMIT 1) cd ON true
      ORDER BY ps.product_id, ps.created_at DESC) x ORDER BY score DESC LIMIT 15`);
  const suppliers = await many(`SELECT s.*, (SELECT count(*) FROM supplier_products sp WHERE sp.supplier_id=s.id)::int skus,
      (SELECT COALESCE(sum(stock),0) FROM supplier_products sp WHERE sp.supplier_id=s.id)::int stock,
      (SELECT round(avg(delivery_days_max),1) FROM supplier_products sp WHERE sp.supplier_id=s.id) avg_days,
      (SELECT count(*) FROM alerts a WHERE a.resolved_at IS NULL AND a.category IN ('SUPPLIER','ORDER') AND a.title ILIKE '%'||s.code||'%')::int problems
    FROM suppliers s ORDER BY reliability_score DESC`);
  const marketplaces = await many(`SELECT code, channel, currency, enabled, automation_state, health_status, health_snapshot, health_checked_at FROM marketplaces WHERE enabled ORDER BY code`);
  const alerts = await many(`SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, created_at DESC LIMIT 30`);
  const approvals = await many(`SELECT * FROM approval_requests WHERE status='PENDING' ORDER BY created_at`);
  const finance = await one(`SELECT
      COALESCE(sum(amount_sek) FILTER (WHERE kind='SALE'),0) revenue, COALESCE(-sum(amount_sek) FILTER (WHERE kind IN ('SUPPLIER_COST','SHIPPING')),0) cogs, COALESCE(-sum(amount_sek) FILTER (WHERE kind='RESERVE'),0) reserves,
      COALESCE(-sum(amount_sek) FILTER (WHERE kind='MARKETPLACE_FEE'),0) fees, COALESCE(-sum(amount_sek) FILTER (WHERE kind='VAT_ESTIMATE'),0) vat,
      COALESCE(-sum(amount_sek) FILTER (WHERE kind='AD_SPEND'),0) ads, COALESCE(-sum(amount_sek) FILTER (WHERE kind='REFUND'),0) refunds,
      COALESCE(sum(amount_sek),0) net FROM transactions WHERE occurred_at > now() - interval '30 days'`);
  const daily = await many(`SELECT to_char(d, 'MM-DD') AS "day", COALESCE(sum(t.amount_sek) FILTER (WHERE t.kind='SALE'),0)::float revenue
    FROM generate_series((now() AT TIME ZONE 'Europe/Stockholm')::date - 13, (now() AT TIME ZONE 'Europe/Stockholm')::date, '1 day') d
    LEFT JOIN transactions t ON (t.occurred_at AT TIME ZONE 'Europe/Stockholm')::date = d GROUP BY d ORDER BY d`);
  const decisions = await many(`SELECT created_at, agent, action, subject_type, subject_id, decision, reasons, data->>'explanation' explanation, dry_run FROM agent_actions ORDER BY id DESC LIMIT 25`);
  const orders = await many(`SELECT o.id, o.marketplace_code, o.external_order_id, o.status, o.hold_reason, o.order_total_sek, o.placed_at, s.tracking_number
    FROM orders o LEFT JOIN shipments s ON s.order_id=o.id ORDER BY o.placed_at DESC LIMIT 15`);
  const listings = await many(`SELECT l.id, l.sku, l.marketplace_code, l.status, l.price, l.min_price, l.quantity, l.pause_reason, p.title FROM listings l JOIN products p ON p.id=l.product_id ORDER BY l.status, l.id LIMIT 40`);
  const jobs = await many(`SELECT DISTINCT ON (job) job, status, started_at, finished_at, error FROM job_runs ORDER BY job, started_at DESC`);
  const settings = await loadSettings();
  const report = await one(`SELECT period_key, text FROM reports WHERE kind='DAILY' ORDER BY period_key DESC LIMIT 1`);
  return { today, todayOrders, todayReturns, products, listingsPaused, opps, suppliers, marketplaces, alerts, approvals, finance, daily, decisions, orders, listings, jobs, settings, report };
}

function statusChip(s: string) {
  const map: Record<string, [string, string]> = {
    HEALTHY: ['good', '✓'], ACTIVE: ['good', '✓'], VERIFIED: ['good', '✓'], APPROVED_FOR_LISTING: ['good', '✓'], OK: ['good', '✓'], PLACED: ['good', '✓'], TRACKING_UPLOADED: ['good', '✓'], DELIVERED: ['good', '✓'], SUPPLIER_ORDERED: ['good', '✓'],
    AT_RISK: ['warning', '!'], WARNING: ['warning', '!'], PAUSED: ['warning', '‖'], REQUIRES_VERIFICATION: ['warning', '?'], UNVERIFIED: ['warning', '?'], AWAITING_APPROVAL: ['warning', '!'], PENDING_PUBLISH: ['warning', '…'], SKIPPED: ['neutral', '–'], DRAFT: ['neutral', '–'],
    CRITICAL: ['critical', '✕'], REJECTED: ['serious', '✕'], BLOCKED: ['critical', '⛔'], FAILED: ['critical', '✕'], ON_HOLD: ['critical', '!'], PAUSED_HEALTH: ['critical', '‖'], ERROR: ['critical', '✕'],
  };
  const [cls, icon] = map[s] ?? ['neutral', '•'];
  return `<span class="chip ${cls}"><span aria-hidden="true">${icon}</span> ${esc(s.replace(/_/g, ' '))}</span>`;
}

function revenueChart(rows: { day: string; revenue: number }[]) {
  const W = 640, H = 180, pl = 44, pb = 22, pt = 10;
  const max = Math.max(1, ...rows.map((r) => r.revenue));
  const nice = Math.pow(10, Math.floor(Math.log10(max))) * Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max))));
  const bw = (W - pl) / rows.length;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / nice);
  const grid = [0, 0.5, 1].map((f) => `<line x1="${pl}" x2="${W}" y1="${y(nice * f)}" y2="${y(nice * f)}" class="grid"/><text x="${pl - 6}" y="${y(nice * f) + 4}" class="axis" text-anchor="end">${Math.round(nice * f).toLocaleString('sv-SE')}</text>`).join('');
  const bars = rows.map((r, i) => {
    const x = pl + i * bw + 2, h = (H - pt - pb) - (y(r.revenue) - pt);
    const bar = r.revenue > 0 ? `<path d="M${x},${y(0)} v${-(h - 4)} q0,-4 4,-4 h${bw - 12} q4,0 4,4 v${h - 4} z" class="bar"/>` : '';
    return `<g class="hit"><rect x="${pl + i * bw}" y="${pt}" width="${bw}" height="${H - pt - pb}" fill="transparent"/>${bar}<title>${esc(r.day)}: ${kr(r.revenue)}</title>
      ${i % 2 === 0 ? `<text x="${x + (bw - 4) / 2}" y="${H - 6}" class="axis" text-anchor="middle">${esc(r.day)}</text>` : ''}</g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue per day, last 14 days, SEK" class="chart">${grid}${bars}</svg>
    <details><summary>Table view</summary><table><tr><th>Day</th><th>Revenue</th></tr>${rows.map((r) => `<tr><td>${esc(r.day)}</td><td class="num">${kr(r.revenue)}</td></tr>`).join('')}</table></details>`;
}

export function renderDashboard(d: Awaited<ReturnType<typeof loadDashboard>>) {
  const e = env();
  const stage = ['0 · read-only research', '1 · + listings', '2 · + auto orders', '3 · + repricing', '4 · full autonomy'][Number(d.settings.GO_LIVE_STAGE)] ?? d.settings.GO_LIVE_STAGE;
  const crit = d.alerts.filter((a) => a.severity === 'CRITICAL').length;
  const tile = (label: string, value: string, sub = '') => `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${value}</div>${sub ? `<div class="ts">${sub}</div>` : ''}</div>`;
  const settingsRows = Object.entries(DEFAULT_SETTINGS).map(([k, s]) => `<tr><td><code>${esc(k)}</code><div class="muted">${esc(s.d)}</div></td><td>
      <form method="post" action="/settings" class="inline"><input type="hidden" name="key" value="${esc(k)}"/>
      ${typeof s.v === 'boolean' ? `<select name="value"><option ${(d.settings as any)[k] ? 'selected' : ''}>true</option><option ${!(d.settings as any)[k] ? 'selected' : ''}>false</option></select>` : `<input name="value" type="number" step="any" value="${esc((d.settings as any)[k])}"/>`}
      <button>Save</button></form></td></tr>`).join('');

  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AutoCommerce Control</title><meta http-equiv="refresh" content="120"/>
<style>
:root{--bg:#f6f6f4;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#7a7974;--line:#e4e3df;--series-1:#2a78d6;--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--accent:#2a78d6}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){--bg:#121211;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#8f8e86;--line:#2e2e2b;--series-1:#3987e5;--accent:#3987e5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line);background:var(--surface);position:sticky;top:0;z-index:2}
h1{font-size:17px;margin:0}h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);margin:0 0 10px}
main{padding:16px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,520px),1fr));max-width:1500px;margin:0 auto}
section{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0}
.wide{grid-column:1/-1}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.tile{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.tl{color:var(--ink2);font-size:12px}.tv{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}.ts{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--ink2);font-weight:500}
.scroll,section>table,details>table{display:block;overflow-x:auto}section>table>tbody,details>table>tbody{display:table;width:100%}
.num{text-align:right;font-variant-numeric:tabular-nums}.muted{color:var(--muted);font-size:12px}.scroll{overflow-x:auto}
.chip{display:inline-flex;gap:4px;align-items:center;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);white-space:nowrap}
.chip.good{border-color:var(--good)}.chip.good span{color:var(--good)}.chip.warning{border-color:var(--warning)}.chip.warning span{color:#b07a00}
.chip.serious{border-color:var(--serious)}.chip.serious span{color:var(--serious)}.chip.critical{border-color:var(--critical)}.chip.critical span{color:var(--critical)}
.chart{width:100%;height:auto}.chart .bar{fill:var(--series-1)}.chart .grid{stroke:var(--line)}.chart .axis{fill:var(--muted);font-size:10px}.chart .hit:hover .bar{opacity:.8}
button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
input,select{background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit;width:110px}form.inline{display:inline-flex;gap:6px}
pre{white-space:pre-wrap;font-size:12px;background:var(--bg);padding:10px;border-radius:8px;margin:0}code{font-size:12px}
.banner{padding:8px 12px;border-radius:8px;border:1px solid var(--critical);margin-top:6px}
</style></head><body>
<header><div><h1>AutoCommerce Control</h1><div class="muted">Mode <b>${esc(e.APP_MODE.toUpperCase())}</b> · Go-live stage ${esc(stage)}${e.APP_MODE === 'live' ? '' : ' (applies in live mode)'} · Automation ${d.settings.AUTOMATION_ENABLED ? statusChip('ACTIVE') : statusChip('PAUSED')}</div></div>
<div style="display:flex;gap:8px;flex-wrap:wrap"><form method="post" action="/settings"><input type="hidden" name="key" value="AUTOMATION_ENABLED"/><input type="hidden" name="value" value="${d.settings.AUTOMATION_ENABLED ? 'false' : 'true'}"/>
<button class="${d.settings.AUTOMATION_ENABLED ? 'secondary' : ''}">${d.settings.AUTOMATION_ENABLED ? 'Emergency stop' : 'Resume automation'}</button></form></div></header>
<main>
<section class="wide"><h2>Today</h2><div class="tiles">
${tile('Revenue', kr(d.today?.revenue))}${tile('Orders', String(d.todayOrders?.n ?? 0))}${tile('Gross profit', kr(d.today?.gross), 'net of VAT − COGS − shipping')}
${tile('Est. net profit', kr(d.today?.net), 'after fees, VAT, reserves')}${tile('Ad spend', kr(d.today?.ads))}${tile('Returns', String(d.todayReturns?.n ?? 0))}</div>
${crit ? `<div class="banner">${statusChip('CRITICAL')} ${crit} critical issue(s) — see Alerts</div>` : ''}</section>

<section><h2>Alerts</h2>${d.alerts.length ? `<div class="scroll"><table>${d.alerts.map((a) => `<tr><td>${statusChip(a.severity)}</td><td>${esc(a.title)}${a.requires_owner ? ' <span class="muted">· needs you</span>' : ''}<div class="muted">${esc(new Date(a.created_at).toLocaleString('sv-SE'))}</div></td>
  <td><form method="post" action="/alerts/${a.id}/resolve"><button class="secondary">Resolve</button></form></td></tr>`).join('')}</table></div>` : '<p class="muted">No open alerts.</p>'}</section>

<section><h2>Approvals needed</h2>${d.approvals.length ? `<table>${d.approvals.map((a) => `<tr><td><b>${esc(a.kind)}</b> ${esc(a.subject_ref)}<pre>${esc(JSON.stringify(a.payload, null, 1))}</pre></td>
  <td><form method="post" action="/approvals/${a.id}/APPROVED"><button>Approve</button></form><br/><form method="post" action="/approvals/${a.id}/REJECTED"><button class="secondary">Reject</button></form></td></tr>`).join('')}</table>` : '<p class="muted">Nothing waiting for you.</p>'}</section>

<section><h2>Products</h2><div class="tiles">${tile('Active', String(d.products?.active ?? 0))}${tile('Paused listings', String(d.listingsPaused?.n ?? 0))}${tile('Researching', String(d.products?.researching ?? 0), `${d.products?.verify ?? 0} need verification`)}${tile('Rejected / blocked', String(d.products?.rejected ?? 0))}</div>
<div class="scroll" style="margin-top:10px"><table><tr><th>Listing</th><th>Status</th><th class="num">Price</th><th class="num">Floor</th><th class="num">Qty</th></tr>
${d.listings.map((l) => `<tr><td>${esc(l.sku)}<div class="muted">${esc(l.title)}</div>${l.pause_reason ? `<div class="muted">${esc(l.pause_reason)}</div>` : ''}</td><td>${statusChip(l.status)}</td><td class="num">${kr(l.price)}</td><td class="num">${kr(l.min_price)}</td><td class="num">${esc(l.quantity)}</td></tr>`).join('')}</table></div></section>

<section><h2>Marketplaces</h2><table><tr><th>Marketplace</th><th>Health</th><th>Automation</th><th>Checked</th></tr>
${d.marketplaces.map((m) => `<tr><td>${esc(m.code)}</td><td>${statusChip(m.health_status)}<div class="muted">${esc((m.health_snapshot?.reasons ?? []).join('; '))}</div></td><td>${statusChip(m.automation_state)}
  ${m.automation_state !== 'ACTIVE' ? `<form method="post" action="/marketplaces/${esc(m.code)}/resume"><button class="secondary">Resume</button></form>` : ''}</td><td class="muted">${m.health_checked_at ? esc(new Date(m.health_checked_at).toLocaleString('sv-SE')) : '—'}</td></tr>`).join('')}</table></section>

<section class="wide"><h2>Opportunities</h2><div class="scroll"><table><tr><th>#</th><th>Product</th><th class="num">Score</th><th>Decision</th><th class="num">Price</th><th class="num">Profit</th><th class="num">Margin</th><th class="num">Offers</th><th>Supplier</th><th>Why</th></tr>
${d.opps.map((o) => `<tr><td>${esc(o.product_id)}</td><td>${esc(o.title)}<div class="muted">${esc(o.marketplace_code)}</div></td><td class="num">${Number(o.score).toFixed(1)}</td><td>${statusChip(o.decision)}</td>
<td class="num">${o.sale_price_gross ? kr(o.sale_price_gross) : '—'}</td><td class="num">${o.net_profit != null ? kr(o.net_profit) : '—'}</td><td class="num">${pct(o.net_margin_pct)}</td><td class="num">${esc(o.offer_count ?? '—')}</td>
<td>${esc(o.supplier ?? '—')}${o.reliability_score ? `<div class="muted">${esc(o.reliability_score)}/100</div>` : ''}</td><td class="muted">${esc((o.decision_reasons ?? []).slice(0, 3).join('; '))}</td></tr>`).join('')}</table></div></section>

<section><h2>Finance · last 30 days</h2><div class="tiles">${tile('Revenue', kr(d.finance?.revenue))}${tile('COGS', kr(d.finance?.cogs))}${tile('Fees', kr(d.finance?.fees))}${tile('VAT estimate', kr(d.finance?.vat))}${tile('Ads', kr(d.finance?.ads))}${tile('Refunds', kr(d.finance?.refunds))}${tile('Reserves', kr(d.finance?.reserves), 'returns / refund / warranty')}${tile('Net profit', kr(d.finance?.net))}</div>
<h2 style="margin-top:14px">Revenue per day (SEK)</h2>${revenueChart(d.daily)}</section>

<section><h2>Suppliers</h2><div class="scroll"><table><tr><th>Supplier</th><th>Status</th><th class="num">Reliability</th><th class="num">Stock</th><th class="num">Delivery</th><th class="num">Problems</th><th></th></tr>
${d.suppliers.map((s) => `<tr><td>${esc(s.name)}<div class="muted">${esc(s.code)} · ${s.is_wholesaler ? 'wholesaler' : 'RETAILER (blocked)'} · ${s.blind_dropship ? 'blind dropship' : 'no blind dropship'}</div></td><td>${statusChip(s.status)}</td>
<td class="num">${esc(s.reliability_score)}</td><td class="num">${esc(s.stock)}</td><td class="num">${s.avg_days ? esc(s.avg_days) + ' d' : '—'}</td><td class="num">${esc(s.problems)}</td>
<td>${s.status !== 'VERIFIED' && s.is_wholesaler ? `<form method="post" action="/suppliers/${s.id}/verify"><button title="Confirms: dropshipping agreement signed, blind shipping (you as seller of record), company details checked">Verify</button></form>` : ''}</td></tr>`).join('')}</table></div></section>

<section><h2>Recent orders</h2><div class="scroll"><table><tr><th>Order</th><th>Status</th><th class="num">Value</th><th>Tracking</th></tr>
${d.orders.map((o) => `<tr><td>${esc(o.external_order_id)}<div class="muted">${esc(o.marketplace_code)} · ${esc(new Date(o.placed_at).toLocaleString('sv-SE'))}</div></td><td>${statusChip(o.status)}${o.hold_reason ? `<div class="muted">${esc(o.hold_reason)}</div>` : ''}</td><td class="num">${kr(o.order_total_sek)}</td><td>${esc(o.tracking_number ?? '—')}</td></tr>`).join('')}</table></div></section>

<section class="wide"><h2>Decision log (every automated decision is explained)</h2><div class="scroll"><table><tr><th>Time</th><th>Agent</th><th>Action</th><th>Subject</th><th>Decision</th><th>Explanation</th></tr>
${d.decisions.map((a) => `<tr><td class="muted">${esc(new Date(a.created_at).toLocaleString('sv-SE'))}</td><td>${esc(a.agent)}</td><td>${esc(a.action)}${a.dry_run ? ' <span class="muted">(sim)</span>' : ''}</td><td>${esc(a.subject_type ?? '')} ${esc(a.subject_id ?? '')}</td><td>${a.decision ? statusChip(a.decision) : ''}</td>
<td>${a.explanation ? `<pre>${esc(a.explanation)}</pre>` : `<span class="muted">${esc(Array.isArray(a.reasons) ? a.reasons.join('; ') : '')}</span>`}</td></tr>`).join('')}</table></div></section>

<section><h2>Latest daily report</h2>${d.report ? `<pre>${esc(d.report.text)}</pre>` : '<p class="muted">First report is generated after 07:00.</p>'}
<form method="post" action="/jobs/reports.daily/run" style="margin-top:8px"><button class="secondary">Generate now</button></form></section>

<section><h2>Jobs</h2><div class="scroll"><table><tr><th>Job</th><th>Every</th><th>Last run</th><th></th></tr>
${JOBS.map((j) => { const r = d.jobs.find((x) => x.job === j.name); return `<tr><td>${esc(j.name)}${r?.error ? `<div class="muted">${esc(String(r.error).split('\n')[0])}</div>` : ''}</td><td class="muted">${j.everyMin} min</td><td>${r ? statusChip(r.status) + ` <span class="muted">${esc(new Date(r.started_at).toLocaleString('sv-SE'))}</span>` : '<span class="muted">never</span>'}</td>
<td><form method="post" action="/jobs/${esc(j.name)}/run"><button class="secondary">Run</button></form></td></tr>`; }).join('')}</table></div></section>

<section class="wide"><h2>Settings (rules, limits, go-live stage)</h2><div class="scroll"><table>${settingsRows}</table></div></section>
</main></body></html>`;
}
