import { describe, it, expect } from 'vitest';
import { skuEconomics, pareto, lifecycleDecision, targetRequirements, pathToTarget, cashForecast, adDecision, negotiationBrief, type SkuLedger, type BusinessBase } from '../src/domain/economics.js';
import { defaults } from '../src/domain/settings.js';

const S = defaults();
const L = (o: Partial<SkuLedger>): SkuLedger => ({ sku: 'A', listingId: 1, title: 't', stage: 'TEST', fulfilment: 'DROPSHIP', orders: 0, units: 0, revenueGross: 0, vat: 0, cogs: 0, shipping: 0, fees: 0, reserves: 0, ads: 0, refunds: 0, returns: 0, daysActive: 30, ordersPrev: 0, profitPrev: 0, ...o });

describe('unit economics', () => {
  it('gross vs contribution margin', () => {
    const e = skuEconomics(L({ orders: 10, units: 10, revenueGross: 4990, vat: 998, cogs: 1200, shipping: 450, fees: 749, reserves: 120, ads: 300 }));
    expect(e.revenueNet).toBe(3992);
    expect(e.grossProfit).toBe(2342);
    expect(e.contribution).toBe(1173);
    expect(e.profitPerOrder).toBe(117.3);
    expect(e.contributionMarginPct).toBeCloseTo(29.38, 1);
  });
  it('80/20 finds the core SKUs', () => {
    const skus = [5000, 3000, 500, 300, 200, -100].map((c, i) => skuEconomics(L({ sku: 'S' + i, listingId: i, orders: 5, revenueGross: c + 1000, cogs: 1000 })));
    const p = pareto(skus);
    expect(p.core.map((s) => s.sku)).toEqual(['S0', 'S1']);
  });
});

describe('kill / winner rules', () => {
  it('kills slow tests, promotes winners, pauses high returns, never scales losses', () => {
    expect(lifecycleDecision(skuEconomics(L({ orders: 2, revenueGross: 800, cogs: 300 })), 22, S).action).toBe('KILL');
    expect(lifecycleDecision(skuEconomics(L({ orders: 25, revenueGross: 10000, vat: 2000, cogs: 3000, fees: 1500 })), 10, S).action).toBe('PROMOTE_WINNER');
    expect(lifecycleDecision(skuEconomics(L({ orders: 10, returns: 3, revenueGross: 4000, cogs: 1000 })), 5, S).action).toBe('PAUSE_INVESTIGATE');
    expect(lifecycleDecision(skuEconomics(L({ orders: 4, revenueGross: 1000, vat: 200, cogs: 1200 })), 5, S).action).toBe('KILL');
    expect(lifecycleDecision(skuEconomics(L({ stage: 'WINNER', orders: 12, revenueGross: 1000, vat: 200, cogs: 1200 })), 5, S).action).toBe('PAUSE_INVESTIGATE');
  });
});

const base: BusinessBase = { basis: 'REAL', monthlyRevenueGross: 280000, monthlyContribution: 41500, monthlyOrders: 700, fixedCosts: 2500, contributionMarginPct: 14.82,
  aov: 400, profitPerOrder: 59.29, winners: 6, ordersPerWinnerPerDay: 3.5, profitPerWinnerMonth: 6500, adCostPerOrder: 20, cogsPerOrder: 160, payoutDelayDays: 14, supplierPrepayDays: 0 };

describe('profit target engine', () => {
  it('computes requirements consistently', () => {
    const t = targetRequirements(base, 200000);
    expect(t.ordersMonthly).toBe(Math.round(202500 / 59.29));
    expect(t.revenueMonthly).toBe(Math.round((202500 / 59.29) * 400));
    expect(t.winnersNeeded).toBe(Math.ceil(202500 / 59.29 / 30 / 3.5));
    expect(t.workingCapital).toBeGreaterThan(0);
  });
  it('path options each close the gap and are ranked', () => {
    const p = pathToTarget(base, 39000, 200000, { wholesaleSavingMonthly: 18000, expansionProfitMonthly: 45000 });
    expect(p.gap).toBe(161000);
    expect(p.options[0].rank).toBe(1);
    expect(p.options.find((o) => o.lever === 'MORE_WINNERS')!.requiredChange).toMatch(/\+25 winners/);
    expect(p.options.find((o) => o.lever === 'WHOLESALE')!.basis).toBe('REAL');
    expect(p.options.find((o) => o.lever === 'EXPANSION')!.basis).toBe('SCENARIO');
  });
  it('no fake progress without data', () => {
    const p = pathToTarget({ ...base, basis: 'INSUFFICIENT_DATA', profitPerWinnerMonth: 0, profitPerOrder: 0, monthlyRevenueGross: 0 }, 0, 25000, {});
    expect(p.options).toEqual([]);
  });
});

describe('cash flow', () => {
  it('warns before the buffer is breached', () => {
    const f = cashForecast({ cashNow: 20000, minBuffer: 5000, dailyRevenueGross: 3000, dailyPayoutNet: 2200, dailyCogs: 1500, dailyAds: 300, dailyVat: 600,
      payoutDelayDays: 14, vatIntervalDays: 90, vatAccrued: 0, daysToNextVat: 40, pendingPayouts: [], commitments: [{ day: 20, amount: -15000, kind: 'INVENTORY' }], refundReserve: 500 });
    expect(f.breachDay).not.toBeNull();
    expect(f.breachDay!).toBeLessThanOrEqual(20);
    expect(Object.keys(f.at)).toEqual(['7', '30', '60', '90']);
  });
});

describe('ads: profit, not ROAS', () => {
  it('pauses zero-conversion, reduces when CAC too high, scales profitable capped campaigns', () => {
    expect(adDecision({ spend: 150, adSales: 0, adOrders: 0, clicks: 40, impressions: 4000, totalSales: 5000 }, 120, 30, 50, 200, 15).action).toBe('PAUSE');
    expect(adDecision({ spend: 500, adSales: 2000, adOrders: 4, clicks: 150, impressions: 9000, totalSales: 5000 }, 120, 30, 50, 200, 15).action).toBe('REDUCE');
    const s = adDecision({ spend: 49, adSales: 2500, adOrders: 5, clicks: 20, impressions: 2000, totalSales: 8000 }, 120, 30, 50, 200, 15);
    expect(s.action).toBe('SCALE'); expect(s.newBudget).toBe(57.5); expect(s.profitAfterAds).toBe(551);
    // low ROAS but profitable is still acceptable (not reduced)
    expect(adDecision({ spend: 60, adSales: 150, adOrders: 1, clicks: 20, impressions: 2000, totalSales: 3000 }, 120, 30, 100, 200, 15).action).toBe('HOLD');
  });
});

describe('negotiation brief', () => {
  it('builds a target and saving from real volume', () => {
    const b = negotiationBrief({ sku: 'X', currentUnit: 12.4, currency: 'EUR', monthlyUnits: 2000, bestQuote: { unit: 8.8, supplier: 'Y', moq: 1000 }, unitAtTargetMargin: 10 })!;
    expect(b.target).toBe(8.8); expect(b.expectedSavingPerMonth).toBe(7200);
    expect(negotiationBrief({ sku: 'X', currentUnit: 5, currency: 'EUR', monthlyUnits: 0, unitAtTargetMargin: 4 })).toBeNull();
  });
});
