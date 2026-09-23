/**
 * Real contribution-profit calculator (section 7). Pure & deterministic — unit tested.
 * All amounts SEK. Sale price is GROSS (incl. VAT) as shown to the customer.
 * Net margin is expressed on net revenue (ex VAT).
 * Assumes the seller is VAT-registered so input VAT on supplier cost and marketplace fees is recoverable
 * (confirm with accountant — see docs/OWNER_ACTIONS.md).
 */
export interface ProfitInput {
  salePriceGross: number;
  shippingChargedGross?: number;   // shipping paid by customer (default 0 = free shipping)
  vatRate: number;                 // destination VAT e.g. 0.25
  supplierCost: number;            // net of VAT, SEK
  supplierShipping: number;        // net of VAT, SEK
  costInForeignCurrency: boolean;  // applies FX buffer
  customsPct: number;              // on supplier cost, 0 for EU stock
  marketplaceFeePct: number;       // referral / final value fee, on gross total
  marketplaceFixedFee: number;
  paymentFeePct: number;
  adCostPerOrder: number;
  expectedReturnRate: number;      // 0..1
  returnHandlingCost: number;      // SEK per return
  returnProductLossFraction?: number; // share of product cost lost on a return (default 0.5)
  refundReservePct: number;        // % (e.g. 2 => 2 %)
  warrantyReservePct: number;
  supplierFeePerOrder: number;
  softwareCostPerOrder: number;
  fxBufferPct: number;
}

export interface ProfitRules { minNetMarginPct: number; minProfitSek: number }

export interface ProfitResult {
  revenueGross: number;
  vat: number;
  revenueNet: number;
  costs: Record<string, number>;
  totalCosts: number;
  netProfit: number;
  netMarginPct: number;
  roiPct: number;
  breakEvenPrice: number;
  breakEvenAdSpend: number;
  maxSupplierCost: number;
  minAllowedPrice: number;   // floor: all costs + minimum required profit/margin
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function core(i: ProfitInput, price: number) {
  const revenueGross = price + (i.shippingChargedGross ?? 0);
  const vat = revenueGross * i.vatRate / (1 + i.vatRate);
  const revenueNet = revenueGross - vat;
  const marketplaceFee = revenueGross * i.marketplaceFeePct + i.marketplaceFixedFee;
  const lossFrac = i.returnProductLossFraction ?? 0.5;
  const landed = i.supplierCost + i.supplierShipping;
  const costs = {
    product: i.supplierCost,
    supplierShipping: i.supplierShipping,
    customs: i.supplierCost * i.customsPct / 100,
    fxBuffer: i.costInForeignCurrency ? landed * i.fxBufferPct / 100 : 0,
    marketplaceFee,
    paymentFee: revenueGross * i.paymentFeePct,
    ads: i.adCostPerOrder,
    expectedReturns: i.expectedReturnRate * (i.returnHandlingCost + lossFrac * i.supplierCost + 0.2 * marketplaceFee),
    refundReserve: revenueNet * i.refundReservePct / 100,
    warrantyReserve: revenueNet * i.warrantyReservePct / 100,
    supplierFees: i.supplierFeePerOrder,
    software: i.softwareCostPerOrder,
  };
  const totalCosts = Object.values(costs).reduce((a, b) => a + b, 0);
  return { revenueGross, vat, revenueNet, costs, totalCosts, profit: revenueNet - totalCosts };
}

export function calculateProfit(i: ProfitInput, rules: ProfitRules): ProfitResult {
  const c = core(i, i.salePriceGross);
  // profit(P) and netRevenue(P) are linear in P -> solve exactly
  const f0 = core(i, 0), f1 = core(i, 1000);
  const a = (f1.profit - f0.profit) / 1000;         // profit per SEK of price
  const nA = (f1.revenueNet - f0.revenueNet) / 1000; // net revenue per SEK of price
  const m = rules.minNetMarginPct / 100;
  const breakEvenPrice = a > 0 ? -f0.profit / a : Infinity;
  // floor for margin: profit(P) >= m * netRev(P)
  const pMargin = a - m * nA > 0 ? (m * f0.revenueNet - f0.profit) / (a - m * nA) : Infinity;
  const pProfit = a > 0 ? (rules.minProfitSek - f0.profit) / a : Infinity;
  const minAllowedPrice = Math.ceil(Math.max(pMargin, pProfit, breakEvenPrice));

  const lossFrac = i.returnProductLossFraction ?? 0.5;
  const dCost = 1 + i.customsPct / 100 + (i.costInForeignCurrency ? i.fxBufferPct / 100 : 0) + i.expectedReturnRate * lossFrac;
  const required = Math.max(rules.minProfitSek, m * c.revenueNet);
  const maxSupplierCost = i.supplierCost + (c.profit - required) / dCost;
  const invested = i.supplierCost + i.supplierShipping + c.costs.customs;

  const costs: Record<string, number> = {};
  for (const [k, v] of Object.entries(c.costs)) costs[k] = r2(v);
  return {
    revenueGross: r2(c.revenueGross),
    vat: r2(c.vat),
    revenueNet: r2(c.revenueNet),
    costs,
    totalCosts: r2(c.totalCosts),
    netProfit: r2(c.profit),
    netMarginPct: c.revenueNet > 0 ? r2((c.profit / c.revenueNet) * 100) : -100,
    roiPct: invested > 0 ? r2((c.profit / invested) * 100) : 0,
    breakEvenPrice: r2(breakEvenPrice),
    breakEvenAdSpend: r2(Math.max(0, c.profit + i.adCostPerOrder)),
    maxSupplierCost: r2(Math.max(0, maxSupplierCost)),
    minAllowedPrice,
  };
}
