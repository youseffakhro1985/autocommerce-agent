/** Evaluation (Research + Pricing agents): compliance → profit → score → decision, fully explained (sections 3, 6, 7, 8, 22). */
import { many, one, tx } from '../db/pool.js';
import { calculateProfit, type ProfitInput } from '../domain/profit.js';
import { checkCompliance } from '../domain/compliance.js';
import { scoreOpportunity } from '../domain/scoring.js';
import { decide } from '../domain/decision.js';
import type { Settings } from '../domain/settings.js';
import { toSek } from '../services/fx.js';
import { logAction } from '../services/audit.js';
import { ctx } from './context.js';

export async function feeFor(marketplaceCode: string, category?: string | null) {
  const f = await one<{ referral_pct: number; fixed_fee: number; payment_pct: number; verified: boolean }>(
    `SELECT referral_pct, fixed_fee, payment_pct, verified FROM fees WHERE marketplace_code=$1 AND (category=$2 OR category='*') ORDER BY (category='*') ASC LIMIT 1`,
    [marketplaceCode, category ?? '*']);
  return f ?? { referral_pct: 0.15, fixed_fee: 5, payment_pct: 0, verified: false };
}

/** Build a profit input for a supplier product at a gross SEK price. */
export async function profitInputFor(sp: any, marketplace: { code: string; vat_rate: number }, priceSek: number, s: Settings, returnRate: number, category?: string | null): Promise<ProfitInput> {
  const fee = await feeFor(marketplace.code, category);
  const cost = await toSek(Number(sp.cost_price), sp.cost_currency);
  const ship = sp.shipping_cost != null ? await toSek(Number(sp.shipping_cost), sp.shipping_currency ?? sp.cost_currency) : 0;
  const nonEu = sp.ships_from && !/^(AT|BE|BG|HR|CY|CZ|DK|EE|FI|FR|DE|GR|HU|IE|IT|LV|LT|LU|MT|NL|PL|PT|RO|SK|SI|ES|SE)$/i.test(sp.ships_from);
  return {
    salePriceGross: priceSek, vatRate: Number(marketplace.vat_rate), supplierCost: cost, supplierShipping: ship,
    costInForeignCurrency: sp.cost_currency !== 'SEK', customsPct: nonEu ? Math.max(s.DEFAULT_CUSTOMS_PCT, 4) : 0,
    marketplaceFeePct: Number(fee.referral_pct), marketplaceFixedFee: Number(fee.fixed_fee), paymentFeePct: Number(fee.payment_pct),
    adCostPerOrder: s.AD_COST_PER_ORDER_SEK, expectedReturnRate: returnRate, returnHandlingCost: s.RETURN_HANDLING_COST_SEK,
    refundReservePct: s.REFUND_RESERVE_PCT, warrantyReservePct: s.WARRANTY_RESERVE_PCT, supplierFeePerOrder: s.SUPPLIER_FEE_PER_ORDER_SEK,
    softwareCostPerOrder: s.SOFTWARE_COST_PER_ORDER_SEK, fxBufferPct: s.FX_BUFFER_PCT,
  };
}

export async function runEvaluation(limit = 200) {
  const c = await ctx();
  if (!c.caps.research) return { skipped: 'automation disabled' };
  const products = await many(`SELECT * FROM products WHERE status IN ('RESEARCHING','REQUIRES_VERIFICATION','APPROVED_FOR_LISTING','ACTIVE') ORDER BY updated_at ASC LIMIT $1`, [limit]);
  const tally: Record<string, number> = { APPROVED_FOR_LISTING: 0, REJECTED: 0, REQUIRES_VERIFICATION: 0, BLOCKED: 0 };

  for (const p of products) {
    const offers = await many(
      `SELECT sp.*, s.code AS supplier_code, s.status AS supplier_status, s.is_wholesaler, s.agreement_signed, s.blind_dropship, s.company_verified, s.reliability_score
       FROM supplier_products sp JOIN suppliers s ON s.id=sp.supplier_id WHERE sp.product_id=$1 AND sp.active`, [p.id]);
    // Prefer verified wholesalers with in-policy delivery, then cheapest landed cost.
    offers.sort((a, b) =>
      Number(b.supplier_status === 'VERIFIED') - Number(a.supplier_status === 'VERIFIED') ||
      Number(b.is_wholesaler) - Number(a.is_wholesaler) ||
      Number((a.delivery_days_max ?? 99) > c.s.MAX_DELIVERY_DAYS_EU) - Number((b.delivery_days_max ?? 99) > c.s.MAX_DELIVERY_DAYS_EU) ||
      (Number(a.cost_price) + Number(a.shipping_cost ?? 0)) - (Number(b.cost_price) + Number(b.shipping_cost ?? 0)));
    const sp = offers[0];

    let bestDecision: string | null = null;
    for (const mp of c.marketplaces) {
      const research = await one(`SELECT * FROM product_research WHERE product_id=$1 AND marketplace_code=$2 ORDER BY captured_at DESC LIMIT 1`, [p.id, mp.code]);
      if (!research) continue;
      const comp = await one(`SELECT * FROM competitor_data WHERE product_id=$1 AND marketplace_code=$2 ORDER BY captured_at DESC LIMIT 1`, [p.id, mp.code]);
      const returnRate = Number(research.raw?.expectedReturnRate ?? 0.06);
      const marketPrice = comp?.lowest_price != null ? Number(comp.lowest_price) : research.avg_price_sek_90d != null ? Number(research.avg_price_sek_90d) : null;

      const compliance = checkCompliance({
        title: p.title, category: p.category, brand: p.brand, description: sp?.description, ean: p.ean,
        ceMarking: sp?.ce_marking ?? null, gpsrManufacturer: sp?.gpsr_manufacturer, gpsrEuResponsible: sp?.gpsr_eu_responsible,
        safetyDocs: sp?.safety_docs, imageRights: !!sp?.image_rights,
        supplier: sp ? { status: sp.supplier_status, isWholesaler: sp.is_wholesaler, agreementSigned: sp.agreement_signed, blindDropship: sp.blind_dropship, companyVerified: sp.company_verified }
          : { status: 'NONE', isWholesaler: true, agreementSigned: false, blindDropship: true, companyVerified: false },
      });
      if (!sp) compliance.findings.push({ code: 'NO_SUPPLIER', severity: 'VERIFY', message: 'No wholesale supplier found yet' });
      if (!sp && compliance.result === 'PASS') compliance.result = 'REQUIRES_VERIFICATION';

      const rules = { minNetMarginPct: c.s.MIN_NET_MARGIN_PCT, minProfitSek: c.s.MIN_PROFIT_PER_ORDER_SEK };
      const pin = sp && marketPrice ? await profitInputFor(sp, mp, marketPrice, c.s, returnRate, p.category) : null;
      const profit = pin ? calculateProfit(pin, rules) : null;

      const sc = scoreOpportunity({
        estMonthlySales: research.est_monthly_sales, salesRankDrops30d: research.sales_rank_drops_30d, offerCount: research.offer_count,
        amazonIsSeller: research.amazon_is_seller, topReviewCount: research.review_count, adIntensity: research.ad_intensity,
        netMarginPct: profit?.netMarginPct ?? null, netProfitSek: profit?.netProfit ?? null, trendIndex: research.trend_index != null ? Number(research.trend_index) : null,
        supplierReliability: sp ? Number(sp.reliability_score) : null, deliveryDaysMax: sp?.delivery_days_max ?? null, expectedReturnRate: returnRate,
        complianceRisk: compliance.riskLevel, priceStddevPct: research.price_stddev_pct != null ? Number(research.price_stddev_pct) : null,
        stock: sp?.stock ?? null, stockBuffer: c.s.MIN_STOCK_BUFFER,
      });
      const d = decide({
        productId: p.id, salePrice: marketPrice ?? 0, profit, supplierReliability: sp ? Number(sp.reliability_score) : null,
        expectedReturnRate: returnRate, stock: sp?.stock ?? null, deliveryDaysMin: sp?.delivery_days_min ?? null, deliveryDaysMax: sp?.delivery_days_max ?? null,
        compliance, score: sc.score, scoreMissing: sc.missing,
      }, c.s);

      await tx(async (q) => {
        await q.query(`INSERT INTO compliance_checks(product_id, supplier_product_id, result, risk_level, findings) VALUES ($1,$2,$3,$4,$5)`,
          [p.id, sp?.id ?? null, compliance.result, compliance.riskLevel, JSON.stringify(compliance.findings)]);
        let pcId: number | null = null;
        if (profit) {
          const r = await q.query(
            `INSERT INTO profit_calculations(product_id, supplier_product_id, marketplace_code, sale_price_gross, breakdown, net_profit, net_margin_pct, roi_pct, break_even_price, break_even_ad_spend, max_supplier_cost, min_allowed_price)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [p.id, sp.id, mp.code, marketPrice, JSON.stringify({ ...profit.costs, vat: profit.vat, revenueNet: profit.revenueNet }), profit.netProfit, profit.netMarginPct, profit.roiPct,
              Number.isFinite(profit.breakEvenPrice) ? profit.breakEvenPrice : 999999, profit.breakEvenAdSpend, profit.maxSupplierCost, Number.isFinite(profit.minAllowedPrice) ? profit.minAllowedPrice : 999999]);
          pcId = r.rows[0].id;
        }
        await q.query(`INSERT INTO product_scores(product_id, marketplace_code, supplier_product_id, score, components, reasons, decision, decision_reasons, profit_calc_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [p.id, mp.code, sp?.id ?? null, sc.score, JSON.stringify(sc.components), JSON.stringify({ reasons: sc.reasons, missing: sc.missing }), d.decision, JSON.stringify(d.reasons), pcId]);
        await logAction({ agent: 'evaluation', action: 'PRODUCT_DECISION', subjectType: 'product', subjectId: p.id, decision: d.decision, reasons: d.reasons,
          data: { marketplace: mp.code, explanation: d.explanation, score: sc.score, supplier: sp?.supplier_code ?? null } }, q);
      });
      const rank = { APPROVED_FOR_LISTING: 3, REQUIRES_VERIFICATION: 2, REJECTED: 1 } as const;
      const blocked = compliance.result === 'BLOCK';
      const this_ = blocked ? 'BLOCKED' : d.decision;
      if (!bestDecision || (rank as any)[this_] > ((rank as any)[bestDecision] ?? 0)) bestDecision = this_;
    }
    if (!bestDecision) continue;
    // ACTIVE products stay ACTIVE unless they now fail (then inventory/pricing agents pause listings).
    const newStatus = p.status === 'ACTIVE' && bestDecision === 'APPROVED_FOR_LISTING' ? 'ACTIVE' : bestDecision;
    if (newStatus !== p.status) {
      await tx(async (q) => {
        await q.query(`UPDATE products SET status=$2, status_reason=$3, updated_at=now() WHERE id=$1`, [p.id, newStatus, `evaluation ${new Date().toISOString()}`]);
        await q.query(`INSERT INTO audit_logs(actor, entity, entity_id, change) VALUES ('evaluation','products',$1,$2)`, [String(p.id), JSON.stringify({ status: { from: p.status, to: newStatus } })]);
        if (p.status === 'ACTIVE' && newStatus !== 'ACTIVE') {
          await q.query(`UPDATE listings SET status='PAUSED', pause_reason='product no longer passes rules', quantity=0, updated_at=now() WHERE product_id=$1 AND status='ACTIVE'`, [p.id]);
        }
      });
    } else {
      await one('UPDATE products SET updated_at=now() WHERE id=$1 RETURNING id', [p.id]);
    }
    tally[bestDecision] = (tally[bestDecision] ?? 0) + 1;
  }
  return tally;
}
