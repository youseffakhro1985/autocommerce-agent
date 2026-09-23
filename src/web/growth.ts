/** Dashboard growth sections: Profit Target Engine, path, 80/20, cash flow, winner engine, ads, roadmap phases. */
import { growthSnapshot } from '../agents/growth.js';
import { adMetrics } from '../domain/economics.js';
import { PHASES } from './phases.js';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const kr = (n: unknown) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${Math.round(Number(n)).toLocaleString('sv-SE')} kr`);
const num = (n: unknown) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString('sv-SE'));
const basisChip = (b: string) => `<span class="chip ${b === 'REAL' ? 'good' : b === 'SCENARIO' ? 'warning' : 'neutral'}"><span aria-hidden="true">${b === 'REAL' ? '●' : b === 'SCENARIO' ? '◐' : '○'}</span> ${esc(b === 'REAL' ? 'REAL DATA' : b === 'SCENARIO' ? 'SCENARIO' : 'INSUFFICIENT DATA')}</span>`;
const pstatus = (s: string) => `<span class="chip ${s === 'VERIFIED' ? 'good' : s === 'BLOCKED' ? 'critical' : 'warning'}"><span aria-hidden="true">${s === 'VERIFIED' ? '✓' : s === 'BLOCKED' ? '✕' : s === 'UNVERIFIED' ? '?' : '!'}</span> ${esc(s)}</span>`;

const qChip = (s: string) => {
  const [cls, icon] = s === 'OPPORTUNITY' ? ['good', '↑'] : s === 'BLOCKED' ? ['critical', '✕'] : s === 'NEEDS_OWNER_ACTION' ? ['warning', '!'] : s === 'NO' ? ['neutral', '–'] : ['neutral', '?'];
  return `<span class="chip ${cls}"><span aria-hidden="true">${icon}</span> ${esc(s.replace(/_/g, ' '))}</span>`;
};

export async function renderGrowth(): Promise<string> {
  const g = await growthSnapshot();
  const next = g.targets.find((t) => t.target === g.nextTarget)!;
  const t200 = g.targets.find((t) => t.target === 200_000)!;
  const pct = Math.max(0, Math.min(100, (g.currentProfit / g.nextTarget) * 100));
  const simNote = g.mode === 'simulation' ? '<p class="muted">⚠ SIMULATION MODE — figures come from simulated orders, not real sales.</p>' : '';

  const targetRows = g.targets.map((t) => `<tr><td><b>${kr(t.target)}</b></td><td>${t.reached ? '✓ reached' : kr(t.gap)}</td><td class="num">${kr(t.revenueMonthly)}</td><td class="num">${num(t.ordersMonthly)}</td><td class="num">${Number.isFinite(t.ordersPerDay) ? t.ordersPerDay : '—'}</td>
    <td class="num">${Number.isFinite(t.winnersNeeded) ? t.winnersNeeded : '—'}</td><td class="num">${kr(t.adSpendMonthly)}</td><td class="num">${kr(t.workingCapital)}</td><td class="num">${num(t.supplierUnitsMonthly)}</td><td class="num">${kr(t.cashFlowRequirement)}</td></tr>`).join('');
  const pathRows = (p: typeof g.path) => p.options.length ? p.options.map((o) => `<tr><td>${o.rank}</td><td><b>${esc(o.lever)}</b><div class="muted">${esc(o.description)}</div></td><td>${esc(o.requiredChange)}</td><td class="num">${kr(o.estMonthlyProfitGain)}</td><td>${basisChip(o.basis)}</td></tr>`).join('')
    : `<tr><td colspan="5" class="muted">Not enough real sales to compute a path yet. The engine only uses recorded orders and verified quotes.</td></tr>`;
  const skuTable = (rows: any[], cols: [string, (x: any) => string][]) => rows.length ? `<table><tr>${cols.map(([h]) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map(([, f]) => `<td>${f(r)}</td>`).join('')}</tr>`).join('')}</table>` : '<p class="muted">—</p>';
  const f = g.cash.forecast;
  const winners = g.winnersAnalyses.map((w: any) => `<details><summary><b>${esc(w.sku)}</b> — ${w.analysis.filter((q: any) => q.status === 'OPPORTUNITY').length} opportunities</summary>
    <table>${w.analysis.map((q: any) => `<tr><td>${esc(q.q)}</td><td>${qChip(q.status)}</td><td class="muted">${esc(q.evidence)}</td><td class="num">${kr(q.estMonthlyImpactSek)}</td></tr>`).join('')}</table>
    ${w.negotiation ? `<h3>Negotiation brief (draft — never sent automatically)</h3><p>Current <b>${esc(w.negotiation.current)} ${esc(w.negotiation.currency)}</b> → target <b>${esc(w.negotiation.target)} ${esc(w.negotiation.currency)}</b> · volume ${esc(w.negotiation.volumePerMonth)}/month · expected saving <b>${esc(w.negotiation.expectedSavingPerMonth)} ${esc(w.negotiation.currency)}/month</b><br/><span class="muted">${esc(w.negotiation.leverage)}</span></p><pre>${esc(w.negotiation.draftEmail)}</pre>` : ''}</details>`).join('') || '<p class="muted">No winners yet. A listing becomes WINNER after ≥ WINNER_MIN_ORDERS_30D orders at target contribution margin.</p>';
  const ads = g.ads.length ? `<table><tr><th>SKU</th><th>Status</th><th class="num">Spend 30d</th><th class="num">ACOS</th><th class="num">ROAS</th><th class="num">CAC</th><th class="num">CVR</th><th>Source</th></tr>${g.ads.map((a: any) => { const m = adMetrics({ spend: a.spend, adSales: a.ad_sales, adOrders: a.ad_orders, clicks: a.clicks, impressions: a.impressions, totalSales: 0 });
      return `<tr><td>${esc(a.sku)}</td><td>${esc(a.status)}</td><td class="num">${kr(a.spend)}</td><td class="num">${m.acosPct ?? '—'} %</td><td class="num">${m.roas ?? '—'}</td><td class="num">${kr(m.cac)}</td><td class="num">${m.cvrPct ?? '—'} %</td><td class="muted">${esc(a.source ?? '—')}</td></tr>`; }).join('')}</table>`
    : '<p class="muted">No campaigns. Ads are off until MAX_AD_SPEND_DAY_SEK &gt; 0 and the Amazon Ads API is connected (BLOCKED).</p>';

  return `
<section class="wide"><h2>Profit target engine</h2>${simNote}
<div class="tiles"><div class="tile"><div class="tl">Current monthly operating profit (30d)</div><div class="tv">${kr(g.currentProfit)}</div><div class="ts">${basisChip(g.base.basis)} contribution ${kr(g.base.monthlyContribution)} − fixed ${kr(g.base.fixedCosts)}</div></div>
<div class="tile"><div class="tl">Next target</div><div class="tv">${kr(g.nextTarget)}</div><div class="ts">gap ${kr(next.gap)}</div></div>
<div class="tile"><div class="tl">Target 200 000 kr</div><div class="tv">gap ${kr(t200.gap)}</div><div class="ts">needs ~${num(t200.ordersPerDay)} orders/day</div></div>
<div class="tile"><div class="tl">Unit economics (30d)</div><div class="tv">${kr(g.base.profitPerOrder)}</div><div class="ts">profit/order · AOV ${kr(g.base.aov)} · margin ${g.base.contributionMarginPct.toFixed(1)} %</div></div></div>
<div class="bar-track" role="img" aria-label="Progress to next target ${pct.toFixed(0)} %"><div class="bar-fill" style="width:${pct}%"></div></div>
<div class="scroll"><table><tr><th>Target / month</th><th>Gap</th><th class="num">Revenue needed</th><th class="num">Orders/mo</th><th class="num">Orders/day</th><th class="num">Winning SKUs</th><th class="num">Ad spend/mo</th><th class="num">Working capital</th><th class="num">Supplier units/mo</th><th class="num">Cash-flow need</th></tr>${targetRows}</table></div>
<p class="muted">Requirements scale today's unit economics (${esc(g.base.basis)}). Working capital = daily COGS × payout delay (${g.base.payoutDelayDays} d). Inventory requirement is 0 while all SKUs are dropshipped.</p></section>

<section><h2>Estimated path → ${kr(g.nextTarget)}</h2><div class="scroll"><table><tr><th>#</th><th>Lever</th><th>Required change</th><th class="num">Est. gain/mo</th><th>Basis</th></tr>${pathRows(g.path)}</table></div></section>
<section><h2>Estimated path → 200 000 kr</h2><div class="scroll"><table><tr><th>#</th><th>Lever</th><th>Required change</th><th class="num">Est. gain/mo</th><th>Basis</th></tr>${pathRows(g.pathTo200k)}</table></div>
<p class="muted">Ranked by share of gap closed per unit of effort × risk. Scenario rows state their assumption; nothing here is a forecast of achieved profit.</p></section>

<section class="wide"><h2>80/20 — where the profit is</h2><p>${g.pareto.core.length} SKU(s) (${g.pareto.skuSharePct} % of SKUs) generate ${g.pareto.sharePct} % of positive contribution.</p>
<div class="grid2">
<div><h3>Top profit SKU</h3>${skuTable(g.top.profit, [['SKU', (x) => esc(x.sku)], ['Profit 30d', (x) => kr(x.contribution)], ['Orders', (x) => esc(x.orders)], ['Margin', (x) => `${x.contributionMarginPct ?? '—'} %`]])}</div>
<div><h3>Top growth SKU</h3>${skuTable(g.top.growth, [['SKU', (x) => esc(x.sku)], ['Growth', (x) => `${x.growthPct} %`], ['Profit', (x) => kr(x.contribution)]])}</div>
<div><h3>Top margin SKU</h3>${skuTable(g.top.margin, [['SKU', (x) => esc(x.sku)], ['Contribution margin', (x) => `${x.contributionMarginPct} %`], ['Gross margin', (x) => `${x.grossMarginPct} %`]])}</div>
<div><h3>Top opportunity (not yet listed)</h3>${skuTable(g.top.opportunity, [['#', (x) => esc(x.product_id)], ['Product', (x) => esc(x.title)], ['Score', (x) => Number(x.score).toFixed(0)]])}</div>
<div><h3>SKU to kill</h3>${skuTable(g.top.kill, [['SKU', (x) => esc(x.sku)], ['Orders', (x) => esc(x.orders)], ['Profit', (x) => kr(x.contribution)]])}</div>
</div>
<details><summary>Per-SKU unit economics (30 days)</summary><div class="scroll">${skuTable(g.skus, [['SKU', (x) => esc(x.sku)], ['Stage', (x) => esc(x.stage)], ['Model', (x) => esc(x.fulfilment)], ['Orders', (x) => esc(x.orders)], ['Revenue', (x) => kr(x.revenueGross)], ['Gross margin', (x) => `${x.grossMarginPct ?? '—'} %`], ['Contribution', (x) => kr(x.contribution)], ['Contr. margin', (x) => `${x.contributionMarginPct ?? '—'} %`], ['Profit/order', (x) => kr(x.profitPerOrder)], ['Profit/day', (x) => kr(x.profitPerDay)], ['Returns', (x) => `${x.returnRatePct ?? '—'} %`]])}</div></details></section>

<section><h2>Cash-flow forecast</h2><div class="tiles">${[7, 30, 60, 90].map((h) => `<div class="tile"><div class="tl">${h} days</div><div class="tv">${kr(f.at[h])}</div></div>`).join('')}</div>
<p>${f.breachDay != null ? `<span class="chip critical"><span aria-hidden="true">!</span> buffer breached in ${f.breachDay} days</span>` : '<span class="chip good"><span aria-hidden="true">✓</span> buffer holds for 90 days</span>'} · lowest ${kr(f.minCash)} (day ${f.minDay}) · ${basisChip(g.cash.basis)}</p>
<table><tr><td>Cash available</td><td class="num">${kr(g.cash.input.cashNow)}</td></tr><tr><td>Pending marketplace payouts</td><td class="num">${kr(g.cash.input.pendingPayouts.reduce((a: number, p: any) => a + p.amount, 0))}</td></tr>
<tr><td>Supplier payments / day (run-rate)</td><td class="num">${kr(g.cash.input.dailyCogs)}</td></tr><tr><td>VAT liability accrued (quarter)</td><td class="num">${kr(g.cash.input.vatAccrued)}</td></tr>
<tr><td>Advertising / day</td><td class="num">${kr(g.cash.input.dailyAds)}</td></tr><tr><td>Inventory & other commitments</td><td class="num">${kr(g.cash.input.commitments.reduce((a: number, p: any) => a + p.amount, 0))}</td></tr>
<tr><td>Refund reserve</td><td class="num">${kr(g.cash.input.refundReserve)}</td></tr></table>
<p class="muted">Assumptions: ${esc(g.cash.assumptions.join(' · '))}</p></section>

<section><h2>Advertising (profit-first)</h2>${ads}</section>

<section class="wide"><h2>Winner engine</h2>${winners}</section>

<section class="wide"><h2>Build roadmap — phases 0–12</h2><div class="scroll"><table><tr><th>Phase</th><th>Status</th><th>What was built</th><th>What was verified</th><th>What remains</th><th>Risks</th><th>Next step</th></tr>
${PHASES.map((p) => `<tr><td><b>${p.n}</b> ${esc(p.name)}</td><td>${pstatus(p.status)}</td><td class="muted">${esc(p.built)}</td><td class="muted">${esc(p.verified)}</td><td class="muted">${esc(p.remains)}</td><td class="muted">${esc(p.risks)}</td><td>${esc(p.next)}</td></tr>`).join('')}</table></div></section>`;
}

export const GROWTH_CSS = `.bar-track{height:10px;border-radius:5px;background:var(--line);margin:12px 0}.bar-fill{height:10px;border-radius:5px;background:var(--series-1)}
.grid2{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}h3{font-size:13px;margin:6px 0}details{margin-top:8px}summary{cursor:pointer}`;
