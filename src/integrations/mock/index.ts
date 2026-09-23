/**
 * Deterministic mock adapters for SIMULATION mode (no real money, no real customers).
 * Catalogue intentionally contains good, bad, regulated and incomplete products so every decision path is exercised.
 */
import type {
  MarketplaceAdapter, SupplierAdapter, MarketDataAdapter, MarketCandidate, SupplierOffer, MkOrder, ListingPayload,
  CompetitivePrice, Address, SupplierTracking, MkReturn,
} from '../types.js';
import type { HealthMetrics } from '../../domain/risk.js';

export function ean13(base12: string): string {
  const d = base12.split('').map(Number);
  const sum = d.reduce((s, x, i) => s + x * (i % 2 === 0 ? 1 : 3), 0);
  return base12 + ((10 - (sum % 10)) % 10);
}

/** Fixed FX used only in simulation (SEK per unit). Live/sandbox use ECB reference rates. */
export const MOCK_FX: Record<string, number> = { SEK: 1, EUR: 11.0, GBP: 12.8 };

let seed = 42;
export function resetMockRng(s = 42) { seed = s; }
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

const MFR_EU = { name: 'Nordic Home Goods AB', address: 'Industrigatan 1, 211 00 Malmö, SE', email: 'safety@example-nhg.se', country: 'SE' };
const MFR_CN = { name: 'Shenzhen Example Mfg Co.', address: 'Bao\'an, Shenzhen, CN', email: 'qa@example-mfg.cn', country: 'CN' };

interface MockItem { c: Omit<MarketCandidate, 'marketplaceCode' | 'source'>; o?: Omit<SupplierOffer, 'ean' | 'title'>; supplier?: 'MOCK_EU_WHOLESALE' | 'MOCK_RETAILER' }
const E = (n: number) => ean13('73500000' + String(n).padStart(4, '0'));

export const MOCK_CATALOGUE: MockItem[] = [
  { c: { title: 'Bamboo Kitchen Utensil Set 6 pcs with Holder', ean: E(1), asin: 'B0MOCK0001', brand: 'Generic', category: 'Home & Kitchen', estMonthlySales: 420, offerCount: 4, amazonIsSeller: false, avgPriceSek90d: 429, priceStddevPct: 3, rating: 4.5, reviewCount: 310, trendIndex: 20, adIntensity: 'MEDIUM', expectedReturnRate: 0.03 },
    o: { supplierSku: 'NHG-BAM-6', costPrice: 7.9, currency: 'EUR', shippingCost: 4.5, moq: 1, stock: 240, deliveryDaysMin: 2, deliveryDaysMax: 4, shipsFrom: 'SE', trackingAvailable: true, ceMarking: 'NOT_REQUIRED', gpsrManufacturer: MFR_EU, safetyDocs: ['warnings.pdf'], images: ['https://img.example/nhg-bam-6.jpg'], imageRights: true, description: 'Set of 6 bamboo utensils with holder. Hand wash.', specs: { material: 'Bamboo', pieces: 6 } } },
  { c: { title: 'Collapsible Silicone Storage Box Set 3 pcs', ean: E(2), asin: 'B0MOCK0002', brand: 'Generic', category: 'Home & Kitchen', estMonthlySales: 260, offerCount: 3, amazonIsSeller: false, avgPriceSek90d: 399, priceStddevPct: 4, rating: 4.4, reviewCount: 120, trendIndex: 35, adIntensity: 'LOW', expectedReturnRate: 0.04 },
    o: { supplierSku: 'NHG-SIL-3', costPrice: 6.2, currency: 'EUR', shippingCost: 4.5, moq: 1, stock: 180, deliveryDaysMin: 2, deliveryDaysMax: 5, shipsFrom: 'SE', trackingAvailable: true, ceMarking: 'NOT_REQUIRED', gpsrManufacturer: MFR_EU, safetyDocs: ['warnings.pdf'], images: ['https://img.example/nhg-sil-3.jpg'], imageRights: true, description: 'Three collapsible storage boxes.', specs: { material: 'Silicone/PP', pieces: 3 } } },
  { c: { title: 'Garden Kneeling Pad Extra Thick', ean: E(3), asin: 'B0MOCK0003', brand: 'Generic', category: 'Garden', estMonthlySales: 190, offerCount: 5, amazonIsSeller: false, avgPriceSek90d: 329, priceStddevPct: 6, rating: 4.6, reviewCount: 90, trendIndex: -10, adIntensity: 'LOW', expectedReturnRate: 0.02 },
    o: { supplierSku: 'NHG-GKP', costPrice: 3.1, currency: 'EUR', shippingCost: 4.0, moq: 1, stock: 400, deliveryDaysMin: 2, deliveryDaysMax: 4, shipsFrom: 'DE', trackingAvailable: true, ceMarking: 'NOT_REQUIRED', gpsrManufacturer: MFR_EU, safetyDocs: ['info.pdf'], images: ['https://img.example/gkp.jpg'], imageRights: true, description: 'Thick foam kneeling pad.', specs: { material: 'EVA foam' } } },
  // low margin => REJECTED
  { c: { title: 'Stainless Steel Drinking Straws 8 pcs', ean: E(4), asin: 'B0MOCK0004', brand: 'Generic', category: 'Home & Kitchen', estMonthlySales: 900, offerCount: 25, amazonIsSeller: true, avgPriceSek90d: 99, priceStddevPct: 12, rating: 4.3, reviewCount: 5200, trendIndex: 0, adIntensity: 'HIGH', expectedReturnRate: 0.02 },
    o: { supplierSku: 'NHG-STR-8', costPrice: 3.9, currency: 'EUR', shippingCost: 4.0, moq: 1, stock: 900, deliveryDaysMin: 2, deliveryDaysMax: 4, shipsFrom: 'DE', trackingAvailable: true, ceMarking: 'NOT_REQUIRED', gpsrManufacturer: MFR_EU, safetyDocs: ['info.pdf'], images: [], imageRights: true } },
  // slow delivery => REJECTED
  { c: { title: 'Desk Cable Management Tray', ean: E(5), asin: 'B0MOCK0005', brand: 'Generic', category: 'Office', estMonthlySales: 150, offerCount: 3, amazonIsSeller: false, avgPriceSek90d: 279, priceStddevPct: 5, rating: 4.2, reviewCount: 60, trendIndex: 15, adIntensity: 'LOW', expectedReturnRate: 0.04 },
    o: { supplierSku: 'CN-CBL-TRAY', costPrice: 5.0, currency: 'EUR', shippingCost: 6.0, moq: 1, stock: 500, deliveryDaysMin: 10, deliveryDaysMax: 16, shipsFrom: 'CN', trackingAvailable: true, ceMarking: 'NOT_REQUIRED', gpsrManufacturer: MFR_CN, gpsrEuResponsible: null, safetyDocs: ['info.pdf'], images: [], imageRights: true } },
  // lithium => BLOCK
  { c: { title: 'Mini Power Bank 10000mAh Lithium', ean: E(6), asin: 'B0MOCK0006', brand: 'Generic', category: 'Electronics', estMonthlySales: 1200, offerCount: 40, amazonIsSeller: true, avgPriceSek90d: 249, priceStddevPct: 9, rating: 4.1, reviewCount: 8000, trendIndex: 5, adIntensity: 'HIGH', expectedReturnRate: 0.07 },
    o: { supplierSku: 'CN-PB-10K', costPrice: 6.0, currency: 'EUR', shippingCost: 4.0, moq: 1, stock: 1000, deliveryDaysMin: 3, deliveryDaysMax: 5, shipsFrom: 'DE', trackingAvailable: true, ceMarking: 'YES', gpsrManufacturer: MFR_CN, safetyDocs: ['msds.pdf'], images: [], imageRights: true } },
  // toy => BLOCK
  { c: { title: 'Wooden Stacking Toy for Toddlers', ean: E(7), asin: 'B0MOCK0007', brand: 'Generic', category: 'Toys', estMonthlySales: 300, offerCount: 6, amazonIsSeller: false, avgPriceSek90d: 199, priceStddevPct: 4, rating: 4.7, reviewCount: 200, trendIndex: 10, adIntensity: 'MEDIUM', expectedReturnRate: 0.03 },
    o: { supplierSku: 'NHG-TOY-STK', costPrice: 4.0, currency: 'EUR', shippingCost: 4.0, moq: 1, stock: 300, deliveryDaysMin: 2, deliveryDaysMax: 4, shipsFrom: 'SE', trackingAvailable: true, ceMarking: 'YES', gpsrManufacturer: MFR_EU, safetyDocs: ['en71.pdf'], images: [], imageRights: true } },
  // famous brand => BLOCK
  { c: { title: 'Nike Style Gym Bag', ean: E(8), asin: 'B0MOCK0008', brand: 'Nike', category: 'Sports', estMonthlySales: 500, offerCount: 12, amazonIsSeller: true, avgPriceSek90d: 399, priceStddevPct: 5, rating: 4.4, reviewCount: 3000, trendIndex: 0, adIntensity: 'HIGH', expectedReturnRate: 0.06 },
    o: { supplierSku: 'X-GYM', costPrice: 9, currency: 'EUR', shippingCost: 4.5, moq: 1, stock: 100, deliveryDaysMin: 3, deliveryDaysMax: 5, shipsFrom: 'PL', trackingAvailable: true, ceMarking: 'NOT_REQUIRED', gpsrManufacturer: MFR_EU, safetyDocs: ['info.pdf'], images: [], imageRights: false } },
  // GPSR missing => REQUIRES_VERIFICATION
  { c: { title: 'Cotton Waffle Kitchen Towels 4 pcs', ean: E(9), asin: 'B0MOCK0009', brand: 'Generic', category: 'Home & Kitchen', estMonthlySales: 240, offerCount: 4, amazonIsSeller: false, avgPriceSek90d: 369, priceStddevPct: 3, rating: 4.5, reviewCount: 150, trendIndex: 12, adIntensity: 'LOW', expectedReturnRate: 0.03 },
    o: { supplierSku: 'PL-TWL-4', costPrice: 4.8, currency: 'EUR', shippingCost: 4.0, moq: 1, stock: 260, deliveryDaysMin: 2, deliveryDaysMax: 5, shipsFrom: 'PL', trackingAvailable: true, ceMarking: 'NOT_REQUIRED', gpsrManufacturer: null, safetyDocs: [], images: ['https://img.example/twl.jpg'], imageRights: true } },
  // only retail source => BLOCK (retail arbitrage)
  { c: { title: 'Glass Meal Prep Containers 5 pcs', ean: E(10), asin: 'B0MOCK0010', brand: 'Generic', category: 'Home & Kitchen', estMonthlySales: 350, offerCount: 5, amazonIsSeller: false, avgPriceSek90d: 379, priceStddevPct: 4, rating: 4.5, reviewCount: 400, trendIndex: 18, adIntensity: 'MEDIUM', expectedReturnRate: 0.05 },
    supplier: 'MOCK_RETAILER',
    o: { supplierSku: 'RETAIL-GMP-5', costPrice: 14, currency: 'EUR', shippingCost: 0, moq: 1, stock: 50, deliveryDaysMin: 1, deliveryDaysMax: 3, shipsFrom: 'DE', trackingAvailable: true, ceMarking: 'NOT_REQUIRED', gpsrManufacturer: MFR_EU, safetyDocs: ['info.pdf'], images: [], imageRights: false } },
  // no supplier found => REQUIRES_VERIFICATION
  { c: { title: 'Linen Table Runner 180 cm', ean: E(11), asin: 'B0MOCK0011', brand: 'Generic', category: 'Home', estMonthlySales: 120, offerCount: 2, amazonIsSeller: false, avgPriceSek90d: 259, priceStddevPct: 3, rating: 4.6, reviewCount: 40, trendIndex: 25, adIntensity: 'LOW', expectedReturnRate: 0.04 } },
];

export class MockMarketData implements MarketDataAdapter {
  readonly code = 'mock_market';
  async discover(marketplaceCode: string, { maxResults }: { maxResults: number }): Promise<MarketCandidate[]> {
    return MOCK_CATALOGUE.slice(0, maxResults).map((m) => ({ ...m.c, marketplaceCode, source: 'mock' }));
  }
}

export class MockSupplier implements SupplierAdapter {
  readonly live = false;
  private orders = new Map<string, { ref: string; at: Date; items: { supplierSku: string; quantity: number }[] }>();
  public stockOverride = new Map<string, number>();
  public costOverride = new Map<string, number>();
  constructor(readonly code: 'MOCK_EU_WHOLESALE' | 'MOCK_RETAILER') {}
  private items() { return MOCK_CATALOGUE.filter((m) => m.o && (m.supplier ?? 'MOCK_EU_WHOLESALE') === this.code); }
  async searchOffers(q: { eans?: string[] }): Promise<SupplierOffer[]> {
    return this.items().filter((m) => !q.eans || q.eans.includes(m.c.ean!)).map((m) => ({
      ...m.o!, ean: m.c.ean, title: m.c.title, brand: m.c.brand, category: m.c.category,
      stock: this.stockOverride.get(m.o!.supplierSku) ?? m.o!.stock,
      costPrice: this.costOverride.get(m.o!.supplierSku) ?? m.o!.costPrice,
    }));
  }
  async getStock(skus: string[]) {
    return this.items().filter((m) => skus.includes(m.o!.supplierSku)).map((m) => ({
      supplierSku: m.o!.supplierSku, currency: m.o!.currency,
      stock: this.stockOverride.get(m.o!.supplierSku) ?? m.o!.stock,
      costPrice: this.costOverride.get(m.o!.supplierSku) ?? m.o!.costPrice,
    }));
  }
  async placeOrder(r: { idempotencyKey: string; items: { supplierSku: string; quantity: number }[] }) {
    const existing = this.orders.get(r.idempotencyKey);
    if (existing) return { externalRef: existing.ref };
    const ref = 'MS-' + (this.orders.size + 1001);
    this.orders.set(r.idempotencyKey, { ref, at: new Date(), items: r.items });
    return { externalRef: ref };
  }
  get placedCount() { return this.orders.size; }
  async findOrderByReference(reference: string) {
    const o = this.orders.get(reference);
    return o ? { externalRef: o.ref, status: 'PLACED' } : null;
  }
  /** Simulation hook: suppress tracking to test "missing tracking" alerts. */
  public withholdTracking = false;
  async getTracking(orders: { reference: string; externalRef: string }[]): Promise<SupplierTracking[]> {
    if (this.withholdTracking) return [];
    return orders.map((o) => o.reference).filter((r) => this.orders.has(r)).map((r) => ({
      reference: r, carrier: 'PostNord', trackingNumber: 'PN' + this.orders.get(r)!.ref.replace(/\D/g, '') + 'SE',
      trackingUrl: 'https://tracking.example/' + r, shippedAt: new Date(), delivered: false,
    }));
  }
}

export class MockMarketplace implements MarketplaceAdapter {
  readonly live = false;
  listings = new Map<string, ListingPayload & { externalId: string }>();
  private orderSeq = 1;
  private pending: MkOrder[] = [];
  shipments: { orderId: string; tracking: string }[] = [];
  health: HealthMetrics = { odrPct: 0.2, lateShipmentPct: 0.5, cancelRatePct: 0.3, validTrackingPct: 99.5, policyWarnings: 0, accountStatus: 'NORMAL' };
  constructor(readonly code: string, private currency: string) {}

  /** Simulation hook: generate demand for active listings. */
  simulateDemand(maxOrders = 3) {
    for (const l of this.listings.values()) {
      if (l.quantity <= 0) continue;
      if (rnd() < 0.6 && this.pending.length < maxOrders) this.injectOrder(l.sku, 1, l.price);
    }
  }
  injectOrder(sku: string, qty: number, unitPrice: number, extra: Partial<MkOrder> = {}): MkOrder {
    const o: MkOrder = {
      externalId: `${this.code}-${String(this.orderSeq++).padStart(6, '0')}`, status: 'Unshipped', paymentConfirmed: true, cancelled: false,
      total: unitPrice * qty, currency: this.currency, placedAt: new Date(), shipBy: new Date(Date.now() + 2 * 864e5),
      deliverBy: new Date(Date.now() + 7 * 864e5), buyerRef: 'buyer-' + Math.floor(rnd() * 1000), shipCountry: 'SE',
      items: [{ sku, externalItemId: 'it-' + this.orderSeq, quantity: qty, unitPrice }], ...extra,
    };
    this.pending.push(o);
    return o;
  }
  async fetchOrders(): Promise<MkOrder[]> { const o = this.pending; this.pending = []; return o; }
  async getShippingAddress(): Promise<Address> { return { name: 'Test Kund', line1: 'Testgatan 1', city: 'Stockholm', postalCode: '11122', country: 'SE' }; }
  async confirmShipment(externalOrderId: string, _i: unknown, t: { trackingNumber: string }) { this.shipments.push({ orderId: externalOrderId, tracking: t.trackingNumber }); }
  async upsertListing(l: ListingPayload) {
    const externalId = l.asin ?? 'MOCK-' + l.sku;
    this.listings.set(l.sku, { ...l, externalId });
    return { externalId, status: 'ACTIVE' as const, issues: [] };
  }
  async updatePriceQuantity(sku: string, u: { price?: number; quantity?: number }) {
    const l = this.listings.get(sku); if (!l) return;
    if (u.price != null) l.price = u.price;
    if (u.quantity != null) l.quantity = u.quantity;
  }
  async getCompetitivePrices(keys: string[]): Promise<CompetitivePrice[]> {
    return keys.map((k) => {
      const m = MOCK_CATALOGUE.find((x) => x.c.asin === k || x.c.ean === k);
      const sek = m?.c.avgPriceSek90d ?? null;
      const base = sek == null ? null : sek / (MOCK_FX[this.currency] ?? 1); // marketplace currency
      return { key: k, lowest: base ? Math.round(base * (0.95 + rnd() * 0.1) * 100) / 100 : null, buyBox: base, offerCount: m?.c.offerCount ?? null, amazonOnListing: m?.c.amazonIsSeller ?? null };
    });
  }
  async getAccountHealth() { return this.health; }
  async fetchReturns(): Promise<MkReturn[]> { return []; }
}
