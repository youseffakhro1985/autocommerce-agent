/**
 * Growth economics — pure, deterministic, unit-tested.
 * RULE: every number is either computed from real recorded data (basis 'REAL') or explicitly labelled
 * 'SCENARIO' with the assumption stated. Nothing is ever presented as achieved unless it is in the ledger.
 */
export type Basis = 'REAL' | 'SCENARIO' | 'INSUFFICIENT_DATA';

// ---------------------------------------------------------------- SKU economics
export interface SkuLedger {
  sku: string; listingId: number; title: string; stage: string; fulfilment: string;
  orders: number; units: number;
  revenueGross: number; vat: number; cogs: number; shipping: number; fees: number; reserves: number; ads: number; refunds: number;
  returns: number;
  daysActive: number;
  daysInStage?: number;
  ordersPrev: number; profitPrev: number;          // previous equal-length window (for growth)
}
export interface SkuEconomics extends SkuLedger {
  revenueNet: number; grossProfit: number; grossMarginPct: number | null;
  contribution: number; contributionMarginPct: number | null;
  profitPerOrder: number | null; profitPerDay: number | null; returnRatePct: number | null; growthPct: number | null;
}
const r2 = (n: number) => Math.round(n * 100) / 100;
export function skuEconomics(l: SkuLedger): SkuEconomics {
  const revenueNet = l.revenueGross - l.vat;
  const grossProfit = revenueNet - l.cogs - l.shipping;
  const contribution = grossProfit - l.fees - l.reserves - l.ads - l.refunds;
  return {
    ...l,
    revenueNet: r2(revenueNet), grossProfit: r2(grossProfit), contribution: r2(contribution),
    grossMarginPct: revenueNet > 0 ? r2((grossProfit / revenueNet) * 100) : null,
    contributionMarginPct: revenueNet > 0 ? r2((contribution / revenueNet) * 100) : null,
    profitPerOrder: l.orders > 0 ? r2(contribution / l.orders) : null,
    profitPerDay: l.daysActive > 0 ? r2(contribution / l.daysActive) : null,
    returnRatePct: l.orders > 0 ? r2((l.returns / l.orders) * 100) : null,
    growthPct: l.profitPrev > 0 ? r2(((contribution - l.profitPrev) / l.profitPrev) * 100) : null,
  };
}

/** 80/20: smallest set of SKUs that generates ≥80 % of positive contribution. */
export function pareto(skus: SkuEconomics[]) {
  const pos = skus.filter((s) => s.contribution > 0).sort((a, b) => b.contribution - a.contribution);
  const total = pos.reduce((a, s) => a + s.contribution, 0);
  const core: SkuEconomics[] = [];
  let acc = 0;
  for (const s of pos) { if (total > 0 && acc / total >= 0.8) break; core.push(s); acc += s.contribution; }
  return { core, sharePct: total > 0 ? r2((acc / total) * 100) : 0, skuSharePct: skus.length ? r2((core.length / skus.length) * 100) : 0 };
}

// ---------------------------------------------------------------- lifecycle rules (kill / winner)
export interface LifecycleRules {
  TEST_PERIOD_DAYS: number; MIN_TEST_ORDERS: number; WINNER_MIN_ORDERS_30D: number; WINNER_MIN_CONTRIBUTION_MARGIN_PCT: number;
  MAX_REAL_RETURN_RATE_PCT: number; MIN_PROFIT_PER_ORDER_SEK: number;
}
export type LifecycleAction = { action: 'KILL' | 'PROMOTE_WINNER' | 'PAUSE_INVESTIGATE' | 'DEMOTE' | 'KEEP'; reasons: string[] };
export function lifecycleDecision(e: SkuEconomics, daysInStage: number, r: LifecycleRules): LifecycleAction {
  const reasons: string[] = [];
  if (e.orders >= 5 && e.returnRatePct != null && e.returnRatePct > r.MAX_REAL_RETURN_RATE_PCT) {
    return { action: 'PAUSE_INVESTIGATE', reasons: [`return rate ${e.returnRatePct} % > ${r.MAX_REAL_RETURN_RATE_PCT} %`] };
  }
  if (e.orders >= 3 && e.contribution < 0) return { action: e.stage === 'TEST' ? 'KILL' : 'PAUSE_INVESTIGATE', reasons: [`loss-making: contribution ${e.contribution} SEK on ${e.orders} orders`] };
  if (e.stage === 'TEST') {
    if (e.orders >= r.WINNER_MIN_ORDERS_30D && (e.contributionMarginPct ?? 0) >= r.WINNER_MIN_CONTRIBUTION_MARGIN_PCT) {
      return { action: 'PROMOTE_WINNER', reasons: [`${e.orders} orders, contribution margin ${e.contributionMarginPct} %`] };
    }
    if (daysInStage >= r.TEST_PERIOD_DAYS && e.orders < r.MIN_TEST_ORDERS) {
      return { action: 'KILL', reasons: [`${e.orders} orders after ${daysInStage} days (min ${r.MIN_TEST_ORDERS})`] };
    }
    if (daysInStage >= r.TEST_PERIOD_DAYS && (e.profitPerOrder ?? 0) < r.MIN_PROFIT_PER_ORDER_SEK) {
      return { action: 'KILL', reasons: [`profit/order ${e.profitPerOrder} SEK < ${r.MIN_PROFIT_PER_ORDER_SEK} after test period`] };
    }
  }
  if ((e.stage === 'WINNER' || e.stage === 'SCALING') && (e.contributionMarginPct ?? 0) < r.WINNER_MIN_CONTRIBUTION_MARGIN_PCT && e.orders >= 10) {
    return { action: 'DEMOTE', reasons: [`contribution margin fell to ${e.contributionMarginPct} %`] };
  }
  return { action: 'KEEP', reasons };
}

// ---------------------------------------------------------------- profit targets & path
export const TARGETS = [25_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];

export interface BusinessBase {
  basis: Basis;
  monthlyRevenueGross: number; monthlyContribution: number; monthlyOrders: number; fixedCosts: number;
  contributionMarginPct: number;  // on gross revenue (what a target needs in sales)
  aov: number; profitPerOrder: number;
  winners: number; ordersPerWinnerPerDay: number; profitPerWinnerMonth: number;
  adCostPerOrder: number; cogsPerOrder: number;
  payoutDelayDays: number; supplierPrepayDays: number;
}
export interface TargetRequirement {
  target: number; basis: Basis;
  revenueMonthly: number; ordersMonthly: number; ordersPerDay: number; winnersNeeded: number;
  adSpendMonthly: number; workingCapital: number; inventoryRequirement: number; supplierUnitsMonthly: number; cashFlowRequirement: number;
}
export function targetRequirements(b: BusinessBase, target: number): TargetRequirement {
  const need = target + b.fixedCosts; // contribution needed to reach operating profit target
  const ordersMonthly = b.profitPerOrder > 0 ? need / b.profitPerOrder : Infinity;
  const revenue = ordersMonthly * b.aov;
  const perDay = ordersMonthly / 30;
  const winners = b.ordersPerWinnerPerDay > 0 ? Math.ceil(perDay / b.ordersPerWinnerPerDay) : Infinity;
  const dailyCogs = perDay * b.cogsPerOrder;
  const workingCapital = dailyCogs * (b.payoutDelayDays + b.supplierPrepayDays);
  const adMonthly = ordersMonthly * b.adCostPerOrder;
  return {
    target, basis: b.basis,
    revenueMonthly: Math.round(revenue), ordersMonthly: Math.round(ordersMonthly), ordersPerDay: r2(perDay), winnersNeeded: winners,
    adSpendMonthly: Math.round(adMonthly), workingCapital: Math.round(workingCapital),
    inventoryRequirement: 0, // dropship model: no stock; set when wholesale/FBA share > 0
    supplierUnitsMonthly: Math.round(ordersMonthly),
    cashFlowRequirement: Math.round(workingCapital + adMonthly * (b.payoutDelayDays / 30)),
  };
}

export interface PathOption { lever: string; description: string; requiredChange: string; estMonthlyProfitGain: number | null; basis: Basis; effort: number; risk: number; rank?: number }
/**
 * Candidate paths from current profit to target. Each option solves the full gap with ONE lever
 * (so they are comparable), then options are ranked by (effort × risk) per relative change required.
 */
export function pathToTarget(b: BusinessBase, currentProfit: number, target: number, extras: {
  wholesaleSavingMonthly?: number | null; expansionProfitMonthly?: number | null; priceIncreaseGainMonthly?: number | null;
}): { gap: number; options: PathOption[] } {
  const gap = Math.max(0, target - currentProfit);
  const opts: PathOption[] = [];
  if (gap === 0) return { gap, options: [] };
  if (b.profitPerWinnerMonth > 0) {
    const n = Math.ceil(gap / b.profitPerWinnerMonth);
    opts.push({ lever: 'MORE_WINNERS', description: `${n} additional winning products at current unit economics`, requiredChange: `+${n} winners (now ${b.winners})`, estMonthlyProfitGain: gap, basis: b.basis, effort: 3, risk: 3 });
  }
  if (b.profitPerOrder > 0) {
    const perDay = gap / b.profitPerOrder / 30;
    opts.push({ lever: 'MORE_ORDERS', description: `+${Math.ceil(perDay)} orders/day at current profit/order ${Math.round(b.profitPerOrder)} SEK`, requiredChange: `+${Math.ceil(perDay)} orders/day`, estMonthlyProfitGain: gap, basis: b.basis, effort: 3, risk: 2 });
  }
  if (b.monthlyRevenueGross > 0) {
    const needMargin = ((b.monthlyContribution + gap) / b.monthlyRevenueGross) * 100;
    if (needMargin <= 60) opts.push({ lever: 'MARGIN', description: `Raise contribution margin from ${r2(b.contributionMarginPct)} % to ${r2(needMargin)} % at current revenue`, requiredChange: `+${r2(needMargin - b.contributionMarginPct)} pp margin`, estMonthlyProfitGain: gap, basis: b.basis, effort: needMargin > 45 ? 9 : 4, risk: 2 });
  }
  if (extras.wholesaleSavingMonthly && extras.wholesaleSavingMonthly > 0) {
    opts.push({ lever: 'WHOLESALE', description: `Move winners from dropship to wholesale/verified cheaper supplier`, requiredChange: `saves ~${Math.round(extras.wholesaleSavingMonthly)} SEK/month (verified quotes)`, estMonthlyProfitGain: Math.round(extras.wholesaleSavingMonthly), basis: 'REAL', effort: 2, risk: 2 });
  }
  if (extras.expansionProfitMonthly && extras.expansionProfitMonthly > 0) {
    opts.push({ lever: 'EXPANSION', description: 'List current winners on additional approved marketplaces', requiredChange: 'expand winners to markets where evaluation approved', estMonthlyProfitGain: Math.round(extras.expansionProfitMonthly), basis: 'SCENARIO', effort: 2, risk: 3 });
  }
  if (extras.priceIncreaseGainMonthly && extras.priceIncreaseGainMonthly > 0) {
    opts.push({ lever: 'PRICE', description: 'Raise prices where we sit below Buy Box / lowest competitor', requiredChange: 'price to competitor level (within ceiling)', estMonthlyProfitGain: Math.round(extras.priceIncreaseGainMonthly), basis: 'SCENARIO', effort: 1, risk: 3 });
  }
  // Rationality score: share of gap covered per unit of (effort × risk). Higher = better.
  const scored = opts.map((o) => ({ o, s: Math.min(1, (o.estMonthlyProfitGain ?? 0) / gap) / (o.effort * o.risk) }));
  scored.sort((a, b) => b.s - a.s);
  return { gap, options: scored.map((x, i) => ({ ...x.o, rank: i + 1 })) };
}

// ---------------------------------------------------------------- cash-flow forecast
export interface CashEvent { day: number; amount: number; kind: string } // day offset from today
export interface CashForecastInput {
  cashNow: number; minBuffer: number;
  dailyRevenueGross: number; dailyPayoutNet: number; dailyCogs: number; dailyAds: number; dailyVat: number;
  payoutDelayDays: number; vatIntervalDays: number; vatAccrued: number; daysToNextVat: number;
  pendingPayouts: CashEvent[]; commitments: CashEvent[]; refundReserve: number;
}
export function cashForecast(i: CashForecastInput, horizons = [7, 30, 60, 90]) {
  let cash = i.cashNow;
  let min = cash, minDay = 0;
  const points: { day: number; cash: number }[] = [{ day: 0, cash }];
  const byDay = new Map<number, number>();
  for (const e of [...i.pendingPayouts, ...i.commitments]) byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.amount);
  let vat = i.vatAccrued;
  for (let d = 1; d <= Math.max(...horizons); d++) {
    cash -= i.dailyCogs + i.dailyAds;                    // dropship: supplier paid at order time
    if (d > i.payoutDelayDays) cash += i.dailyPayoutNet; // new sales pay out after the delay
    cash += byDay.get(d) ?? 0;                          // known payouts & commitments
    vat += i.dailyVat;
    if (d === i.daysToNextVat || (d > i.daysToNextVat && (d - i.daysToNextVat) % i.vatIntervalDays === 0)) { cash -= vat; vat = 0; }
    if (cash < min) { min = cash; minDay = d; }
    points.push({ day: d, cash: r2(cash) });
  }
  const at = Object.fromEntries(horizons.map((h) => [h, r2(points[h].cash - i.refundReserve)]));
  const breach = points.find((p) => p.cash - i.refundReserve < i.minBuffer);
  return { at, minCash: r2(min - i.refundReserve), minDay, breachDay: breach?.day ?? null, points };
}

// ---------------------------------------------------------------- advertising (profit-first)
export interface AdStats { spend: number; adSales: number; adOrders: number; clicks: number; impressions: number; totalSales: number }
export function adMetrics(a: AdStats) {
  return {
    acosPct: a.adSales > 0 ? r2((a.spend / a.adSales) * 100) : null,
    tacosPct: a.totalSales > 0 ? r2((a.spend / a.totalSales) * 100) : null,
    roas: a.spend > 0 ? r2(a.adSales / a.spend) : null,
    cac: a.adOrders > 0 ? r2(a.spend / a.adOrders) : null,
    ctrPct: a.impressions > 0 ? r2((a.clicks / a.impressions) * 100) : null,
    cpc: a.clicks > 0 ? r2(a.spend / a.clicks) : null,
    cvrPct: a.clicks > 0 ? r2((a.adOrders / a.clicks) * 100) : null,
  };
}
/**
 * Decide on a campaign by TOTAL PROFIT, not ROAS: profit after ads = ad orders × profit-before-ads − spend.
 * Max acceptable CAC = profit-before-ads per order − minimum profit after ads.
 */
export function adDecision(a: AdStats, profitBeforeAdsPerOrder: number, minProfitAfterAds: number, budget: number, maxDaily: number, stepPct: number) {
  const m = adMetrics(a);
  const profitAfterAds = r2(a.adOrders * profitBeforeAdsPerOrder - a.spend);
  const maxCac = r2(profitBeforeAdsPerOrder - minProfitAfterAds);
  const breakEvenAcosPct = a.adOrders > 0 && a.adSales > 0 ? r2((profitBeforeAdsPerOrder / (a.adSales / a.adOrders)) * 100) : null;
  if (a.clicks >= 30 && a.adOrders === 0) return { action: 'PAUSE', newBudget: 0, reason: `${a.clicks} clicks, 0 orders`, profitAfterAds, maxCac, breakEvenAcosPct, ...m };
  if (m.cac != null && m.cac > maxCac) return { action: 'REDUCE', newBudget: r2(budget * 0.7), reason: `CAC ${m.cac} > max ${maxCac}`, profitAfterAds, maxCac, breakEvenAcosPct, ...m };
  if (profitAfterAds > 0 && m.cac != null && m.cac < maxCac * 0.8 && a.spend >= budget * 0.9) {
    const nb = Math.min(maxDaily, r2(budget * (1 + stepPct / 100)));
    return { action: nb > budget ? 'SCALE' : 'HOLD_AT_CAP', newBudget: nb, reason: `profit after ads ${profitAfterAds} SEK, CAC ${m.cac} < 80 % of max`, profitAfterAds, maxCac, breakEvenAcosPct, ...m };
  }
  return { action: 'HOLD', newBudget: budget, reason: 'within limits', profitAfterAds, maxCac, breakEvenAcosPct, ...m };
}

// ---------------------------------------------------------------- negotiation brief
export function negotiationBrief(i: { sku: string; currentUnit: number; currency: string; monthlyUnits: number; bestQuote?: { unit: number; supplier: string; moq: number } | null; unitAtTargetMargin: number }) {
  const candidates = [i.unitAtTargetMargin, i.bestQuote?.unit].filter((x): x is number => x != null && x > 0 && x < i.currentUnit);
  if (!candidates.length || i.monthlyUnits <= 0) return null;
  const target = r2(Math.min(...candidates));
  const saving = r2((i.currentUnit - target) * i.monthlyUnits);
  const volume = Math.max(i.monthlyUnits, i.bestQuote?.moq ?? 0);
  return {
    sku: i.sku, current: i.currentUnit, target, currency: i.currency, volumePerMonth: volume, expectedSavingPerMonth: saving,
    leverage: i.bestQuote ? `Alternative quote ${i.bestQuote.unit} ${i.currency} from ${i.bestQuote.supplier} (MOQ ${i.bestQuote.moq})` : 'Target derived from margin goal (no alternative quote yet)',
    draftEmail: `Subject: Volume pricing for ${i.sku}\n\nHello,\n\nWe currently purchase ${i.monthlyUnits} units/month of ${i.sku} at ${i.currentUnit} ${i.currency}. We plan to grow volume to ${volume} units/month and would like to consolidate with one supplier. Could you offer ${target} ${i.currency}/unit for that volume, together with your payment terms, lead time and options for custom packaging?\n\nBest regards`,
  };
}
