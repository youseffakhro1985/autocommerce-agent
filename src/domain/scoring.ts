/**
 * Product Opportunity Score (section 3). 0..100, weighted, fully explained.
 * Missing inputs are scored conservatively and reported in `missing`.
 */
export interface ScoreInput {
  estMonthlySales?: number | null;
  salesRankDrops30d?: number | null;
  offerCount?: number | null;
  amazonIsSeller?: boolean | null;
  topReviewCount?: number | null;
  adIntensity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN' | null;
  netMarginPct?: number | null;
  netProfitSek?: number | null;
  trendIndex?: number | null;          // -100..100
  supplierReliability?: number | null; // 0..100
  deliveryDaysMax?: number | null;
  expectedReturnRate?: number | null;  // 0..1
  complianceRisk?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  priceStddevPct?: number | null;
  stock?: number | null;
  stockBuffer: number;
}

export const WEIGHTS = {
  demand: 0.20, competition: 0.15, margin: 0.20, trend: 0.08, supplier: 0.12,
  delivery: 0.08, returnRisk: 0.07, regulatory: 0.05, priceStability: 0.03, stockStability: 0.02,
} as const;

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function scoreOpportunity(i: ScoreInput) {
  const reasons: string[] = [];
  const missing: string[] = [];
  const c: Record<keyof typeof WEIGHTS, number> = {} as any;

  // Demand: ~300+/month = 100; 30/month = 30
  if (i.estMonthlySales != null) c.demand = clamp((Math.log10(Math.max(1, i.estMonthlySales)) / Math.log10(300)) * 100);
  else if (i.salesRankDrops30d != null) c.demand = clamp((Math.log10(Math.max(1, i.salesRankDrops30d)) / Math.log10(200)) * 100);
  else { c.demand = 20; missing.push('demand'); }
  reasons.push(`demand ${c.demand.toFixed(0)}/100 (${i.estMonthlySales ?? i.salesRankDrops30d ?? '?'} est. monthly sales)`);

  // Competition: fewer offers, Amazon not selling, fewer entrenched reviews, low ad intensity
  if (i.offerCount != null) {
    let s = 100 - clamp((i.offerCount - 2) * 8, 0, 70);
    if (i.amazonIsSeller) { s -= 35; reasons.push('Amazon itself sells on listing (Buy Box very hard)'); }
    if ((i.topReviewCount ?? 0) > 2000) s -= 15;
    if (i.adIntensity === 'HIGH') s -= 15; else if (i.adIntensity === 'MEDIUM') s -= 5;
    c.competition = clamp(s);
  } else { c.competition = 30; missing.push('competition'); }
  reasons.push(`competition ${c.competition.toFixed(0)}/100 (${i.offerCount ?? '?'} offers)`);

  // Margin: 10% => 0, 40% => 100
  if (i.netMarginPct != null) c.margin = clamp(((i.netMarginPct - 10) / 30) * 100);
  else { c.margin = 0; missing.push('margin'); }
  reasons.push(`margin ${c.margin.toFixed(0)}/100 (${i.netMarginPct ?? '?'} % net)`);

  c.trend = i.trendIndex != null ? clamp(50 + i.trendIndex / 2) : (missing.push('trend'), 50);
  c.supplier = i.supplierReliability != null ? clamp(i.supplierReliability) : (missing.push('supplier'), 0);
  c.delivery = i.deliveryDaysMax != null ? clamp(100 - (i.deliveryDaysMax - 2) * 15) : (missing.push('delivery'), 0);
  c.returnRisk = i.expectedReturnRate != null ? clamp(100 - i.expectedReturnRate * 100 * 8) : (missing.push('returnRisk'), 30);
  c.regulatory = i.complianceRisk === 'LOW' ? 100 : i.complianceRisk === 'MEDIUM' ? 50 : i.complianceRisk === 'HIGH' ? 0 : (missing.push('regulatory'), 0);
  c.priceStability = i.priceStddevPct != null ? clamp(100 - i.priceStddevPct * 5) : (missing.push('priceStability'), 50);
  c.stockStability = i.stock != null ? clamp((i.stock / (i.stockBuffer * 3)) * 100) : (missing.push('stock'), 0);

  if (c.trend >= 65) reasons.push('rising trend'); else if (c.trend <= 35) reasons.push('declining trend');
  if (c.delivery < 50) reasons.push(`slow delivery (${i.deliveryDaysMax} days)`);
  if (c.returnRisk < 50) reasons.push(`high return risk (${((i.expectedReturnRate ?? 0) * 100).toFixed(1)} %)`);

  let score = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) score += c[k as keyof typeof WEIGHTS] * w;
  score = Math.round(score * 100) / 100;
  const components: Record<string, number> = {};
  for (const [k, v] of Object.entries(c)) components[k] = Math.round(v * 10) / 10;
  return { score, components, reasons, missing };
}
