import type { Settings } from './settings.js';
import type { ProfitResult } from './profit.js';
import type { ComplianceResult, Finding } from './compliance.js';

export type Decision = 'APPROVED_FOR_LISTING' | 'REJECTED' | 'REQUIRES_VERIFICATION';

export interface DecisionInput {
  productId: number | string;
  salePrice: number;
  profit: ProfitResult | null;
  supplierReliability: number | null;
  expectedReturnRate: number | null;   // 0..1
  stock: number | null;
  deliveryDaysMin: number | null;
  deliveryDaysMax: number | null;
  compliance: { result: ComplianceResult; riskLevel: string; findings: Finding[] };
  score: number;
  scoreMissing: string[];
}

/** Section 8: fail => REJECTED, missing info => REQUIRES VERIFICATION, all pass => APPROVED FOR LISTING. */
export function decide(i: DecisionInput, s: Settings): { decision: Decision; reasons: string[]; explanation: string } {
  const fails: string[] = [];
  const unknown: string[] = [];

  if (i.compliance.result === 'BLOCK') fails.push(...i.compliance.findings.filter((f) => f.severity === 'BLOCK').map((f) => f.message));
  if (i.compliance.result === 'REQUIRES_VERIFICATION') unknown.push(...i.compliance.findings.filter((f) => f.severity === 'VERIFY').map((f) => f.message));

  if (!i.profit) unknown.push('profit could not be calculated (missing cost/fee data)');
  else {
    if (i.profit.netMarginPct < s.MIN_NET_MARGIN_PCT) fails.push(`margin only ${i.profit.netMarginPct.toFixed(1)} % (min ${s.MIN_NET_MARGIN_PCT} %)`);
    if (i.profit.netProfit < s.MIN_PROFIT_PER_ORDER_SEK) fails.push(`profit/order only ${i.profit.netProfit.toFixed(0)} SEK (min ${s.MIN_PROFIT_PER_ORDER_SEK})`);
  }
  if (i.supplierReliability == null) unknown.push('supplier reliability unknown');
  else if (i.supplierReliability < s.MIN_SUPPLIER_RELIABILITY) fails.push(`supplier reliability ${i.supplierReliability}/100 (min ${s.MIN_SUPPLIER_RELIABILITY})`);
  if (i.expectedReturnRate == null) unknown.push('return rate unknown');
  else if (i.expectedReturnRate * 100 > s.MAX_RETURN_RATE_PCT) fails.push(`high return risk ${(i.expectedReturnRate * 100).toFixed(1)} % (max ${s.MAX_RETURN_RATE_PCT} %)`);
  if (i.stock == null) unknown.push('supplier stock unknown');
  else if (i.stock < s.MIN_STOCK_BUFFER) fails.push(`supplier stock ${i.stock} < buffer ${s.MIN_STOCK_BUFFER}`);
  if (i.deliveryDaysMax == null) unknown.push('delivery time unknown');
  else if (i.deliveryDaysMax > s.MAX_DELIVERY_DAYS_EU) fails.push(`supplier delivery ${i.deliveryDaysMax} days (max ${s.MAX_DELIVERY_DAYS_EU})`);
  // Score is only a rejection ground when it isn't depressed by missing supplier/profit data.
  const scoreReliable = !i.scoreMissing.some((m) => ['margin', 'supplier', 'delivery', 'stock'].includes(m));
  if (scoreReliable && i.score < s.MIN_OPPORTUNITY_SCORE) fails.push(`opportunity score ${i.score.toFixed(1)} < ${s.MIN_OPPORTUNITY_SCORE}`);
  const critMissing = i.scoreMissing.filter((m) => ['demand', 'competition'].includes(m));
  if (critMissing.length) unknown.push(`market data missing: ${critMissing.join(', ')}`);

  const decision: Decision = fails.length ? 'REJECTED' : unknown.length ? 'REQUIRES_VERIFICATION' : 'APPROVED_FOR_LISTING';
  const reasons = decision === 'REJECTED' ? fails : decision === 'REQUIRES_VERIFICATION' ? unknown : ['all rules passed'];

  const lines = [`PRODUCT ${i.productId}`, `Decision: ${decision.replace(/_/g, ' ')}`];
  if (decision === 'APPROVED_FOR_LISTING' && i.profit) {
    lines.push(
      `Expected sale price: ${i.salePrice.toFixed(0)} SEK`,
      `Total estimated cost: ${(i.profit.revenueGross - i.profit.netProfit).toFixed(0)} SEK (incl. VAT ${i.profit.vat.toFixed(0)})`,
      `Expected profit: ${i.profit.netProfit.toFixed(0)} SEK`,
      `Expected margin: ${i.profit.netMarginPct.toFixed(1)} %`,
      `Price floor: ${i.profit.minAllowedPrice} SEK`,
      `Supplier reliability: ${i.supplierReliability}/100`,
      `Delivery: ${i.deliveryDaysMin}–${i.deliveryDaysMax} days`,
      `Opportunity score: ${i.score.toFixed(1)}`,
      `Risk: ${i.compliance.riskLevel}`,
    );
  } else {
    lines.push('Reason:', ...reasons.map((r) => `- ${r}`));
  }
  return { decision, reasons, explanation: lines.join('\n') };
}
