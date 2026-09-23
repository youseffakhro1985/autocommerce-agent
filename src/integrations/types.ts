/** Integration contracts. Every adapter's text fields are UNTRUSTED DATA (never instructions). */
import type { HealthMetrics } from '../domain/risk.js';

export interface Address {
  name: string; line1: string; line2?: string; city: string; postalCode: string; country: string; phone?: string;
}

export interface MkOrderItem { sku: string; externalItemId: string; quantity: number; unitPrice: number }
export interface MkOrder {
  externalId: string;
  status: string;                 // marketplace raw status
  paymentConfirmed: boolean;
  cancelled: boolean;
  total: number;
  currency: string;
  placedAt: Date;
  shipBy?: Date | null;
  deliverBy?: Date | null;
  buyerRef: string;               // pseudonymous id
  shipCountry: string | null;
  items: MkOrderItem[];
  raw?: unknown;
}

export interface ListingPayload {
  sku: string;
  marketplaceCode: string;
  productType?: string;           // Amazon product type / eBay category id
  ean?: string | null;
  asin?: string | null;           // Amazon: offer on existing ASIN when catalog match exists
  title: string;
  bullets: string[];
  description: string;
  attributes: Record<string, unknown>;
  images: string[];
  price: number;                  // marketplace currency, gross
  currency: string;
  quantity: number;
  handlingDays: number;
  legal: { manufacturer?: unknown; euResponsible?: unknown; safetyInfo?: string };
}

export interface CompetitivePrice { key: string; lowest?: number | null; buyBox?: number | null; offerCount?: number | null; amazonOnListing?: boolean | null }

export interface MkReturn { externalOrderId: string; externalReturnId: string; reason: string; status: string; refundAmount?: number | null }

export interface MarketplaceAdapter {
  readonly code: string;
  readonly live: boolean; // true => real money / real customers
  fetchOrders(since: Date): Promise<MkOrder[]>;
  getShippingAddress(externalOrderId: string): Promise<Address>;
  confirmShipment(externalOrderId: string, items: MkOrderItem[], t: { carrier: string; trackingNumber: string; shippedAt: Date }): Promise<void>;
  upsertListing(l: ListingPayload): Promise<{ externalId: string | null; status: 'ACTIVE' | 'PENDING_PUBLISH' | 'ERROR'; issues: string[] }>;
  updatePriceQuantity(sku: string, u: { price?: number; currency?: string; quantity?: number }): Promise<void>;
  getCompetitivePrices(keys: string[]): Promise<CompetitivePrice[]>;
  getAccountHealth(): Promise<HealthMetrics>;
  fetchReturns(since: Date): Promise<MkReturn[]>;
}

export interface SupplierOffer {
  supplierSku: string; ean?: string | null; title: string; brand?: string | null; category?: string | null;
  costPrice: number; currency: string; shippingCost?: number | null; moq: number; stock: number;
  deliveryDaysMin?: number | null; deliveryDaysMax?: number | null; shipsFrom?: string | null; trackingAvailable?: boolean | null;
  ceMarking?: string | null; gpsrManufacturer?: any; gpsrEuResponsible?: any; safetyDocs?: unknown[] | null;
  images?: string[]; imageRights: boolean; description?: string | null; specs?: Record<string, unknown> | null;
}

export interface SupplierOrderRequest {
  idempotencyKey: string;         // also sent as the supplier-side order reference
  items: { supplierSku: string; quantity: number }[];
  shipTo: Address;
  blindShipping: true;            // neutral packaging, no supplier invoice/price to end customer
}

export interface SupplierTracking { reference: string; carrier: string; trackingNumber: string; trackingUrl?: string; shippedAt: Date; delivered: boolean; deliveredAt?: Date | null; lastEvent?: string }

export interface SupplierAdapter {
  readonly code: string;
  readonly live: boolean;
  searchOffers(q: { eans?: string[]; keywords?: string[] }): Promise<SupplierOffer[]>;
  getStock(skus: string[]): Promise<{ supplierSku: string; stock: number; costPrice: number; currency: string }[]>;
  placeOrder(r: SupplierOrderRequest): Promise<{ externalRef: string }>;
  findOrderByReference(reference: string): Promise<{ externalRef: string; status: string } | null>;
  /** reference = our idempotency key, externalRef = supplier order id */
  getTracking(orders: { reference: string; externalRef: string }[]): Promise<SupplierTracking[]>;
}

export interface MarketCandidate {
  title: string; asin?: string | null; ean?: string | null; brand?: string | null; category?: string | null;
  marketplaceCode: string;
  salesRank?: number | null; salesRankDrops30d?: number | null; estMonthlySales?: number | null;
  avgPriceSek90d?: number | null; priceStddevPct?: number | null; offerCount?: number | null; amazonIsSeller?: boolean | null;
  rating?: number | null; reviewCount?: number | null; reviewGrowth30d?: number | null; trendIndex?: number | null;
  adIntensity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN'; expectedReturnRate?: number | null; negativeThemes?: string[];
  source: string; raw?: unknown;
}

export interface MarketDataAdapter {
  readonly code: string;
  discover(marketplaceCode: string, opts: { maxResults: number }): Promise<MarketCandidate[]>;
}
