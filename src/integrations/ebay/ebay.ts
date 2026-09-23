/**
 * eBay REST adapter (Sell Inventory, Sell Fulfillment, Sell Analytics, Buy Browse).
 * Status (checked 2026-09-23):
 *  - Finding & Shopping APIs decommissioned 2025-02-04 -> Browse API used for competitor prices.             VERIFIED
 *  - Product API decommissioned 2026-08-15; UploadSiteHostedPictures decommission 2026-09-30 -> Media API.   VERIFIED
 *  - Post-Order API: many return/case methods decommissioned Jan–Mar 2026; returns read-only here.           VERIFIED (partial) / replacement UNVERIFIED
 *  - EBAY_SE exists in MarketplaceIdEnum (ebay.com/sch/Sweden, no full local site) -> EBAY_DE is primary EU. VERIFIED
 *  - Marketplace Account Deletion notification endpoint is mandatory for production keys (see server.ts).
 * Dropshipping: only from wholesale suppliers; retail-arbitrage is blocked in compliance.ts.               VERIFIED (eBay help id=4176)
 */
import { http } from '../http.js';
import type { MarketplaceAdapter, MkOrder, ListingPayload, CompetitivePrice, Address, MkOrderItem, MkReturn } from '../types.js';
import type { HealthMetrics } from '../../domain/risk.js';

export interface EbayConfig {
  clientId: string; clientSecret: string; refreshToken: string; env: 'sandbox' | 'production';
  marketplaceId: string; code: string; currency: string; contentLanguage: string; live: boolean;
  policies?: { fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string; merchantLocationKey?: string };
}

const SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
].join(' ');

export class EbayAdapter implements MarketplaceAdapter {
  private userToken?: { v: string; exp: number };
  private appToken?: { v: string; exp: number };
  private offerIds = new Map<string, string>();
  constructor(private cfg: EbayConfig) {}
  get code() { return this.cfg.code; }
  get live() { return this.cfg.live; }
  private get base() { return this.cfg.env === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'; }

  private async token(kind: 'user' | 'app'): Promise<string> {
    const cached = kind === 'user' ? this.userToken : this.appToken;
    if (cached && cached.exp > Date.now() + 60_000) return cached.v;
    const body = kind === 'user'
      ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.cfg.refreshToken, scope: SCOPES })
      : new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' });
    const r = await http<{ access_token: string; expires_in: number }>(`${this.base}/identity/v1/oauth2/token`, {
      method: 'POST', retries: 2,
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64') },
      body,
    });
    const t = { v: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    if (kind === 'user') this.userToken = t; else this.appToken = t;
    return t.v;
  }

  private async call<T = any>(method: string, path: string, body?: unknown, kind: 'user' | 'app' = 'user'): Promise<T> {
    return http<T>(this.base + path, {
      method,
      headers: {
        authorization: 'Bearer ' + (await this.token(kind)), 'content-type': 'application/json',
        'content-language': this.cfg.contentLanguage, 'x-ebay-c-marketplace-id': this.cfg.marketplaceId,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async fetchOrders(since: Date): Promise<MkOrder[]> {
    const out: MkOrder[] = [];
    let offset = 0;
    for (;;) {
      const filter = encodeURIComponent(`lastmodifieddate:[${since.toISOString()}..]`);
      const r = await this.call('GET', `/sell/fulfillment/v1/order?filter=${filter}&limit=50&offset=${offset}`);
      for (const o of r.orders ?? []) {
        const ship = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
        out.push({
          externalId: o.orderId, status: o.orderFulfillmentStatus,
          paymentConfirmed: o.orderPaymentStatus === 'PAID',
          cancelled: o.cancelStatus?.cancelState === 'CANCELED',
          total: Number(o.pricingSummary?.total?.value ?? 0), currency: o.pricingSummary?.total?.currency ?? this.cfg.currency,
          placedAt: new Date(o.creationDate),
          shipBy: o.lineItems?.[0]?.lineItemFulfillmentInstructions?.shipByDate ? new Date(o.lineItems[0].lineItemFulfillmentInstructions.shipByDate) : null,
          deliverBy: o.lineItems?.[0]?.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate ? new Date(o.lineItems[0].lineItemFulfillmentInstructions.maxEstimatedDeliveryDate) : null,
          buyerRef: 'ebay:' + (o.buyer?.username ?? o.orderId),
          shipCountry: ship?.contactAddress?.countryCode ?? null,
          items: (o.lineItems ?? []).map((li: any) => ({ sku: li.sku, externalItemId: li.lineItemId, quantity: Number(li.quantity), unitPrice: Number(li.lineItemCost?.value ?? 0) / Math.max(1, Number(li.quantity)) })),
          raw: { orderFulfillmentStatus: o.orderFulfillmentStatus, orderPaymentStatus: o.orderPaymentStatus },
        });
      }
      if (!r.next || !(r.orders?.length)) break;
      offset += 50;
    }
    return out;
  }

  async getShippingAddress(orderId: string): Promise<Address> {
    const o = await this.call('GET', `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`);
    const s = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo ?? {};
    const a = s.contactAddress ?? {};
    return { name: s.fullName, line1: a.addressLine1, line2: a.addressLine2, city: a.city, postalCode: a.postalCode, country: a.countryCode, phone: s.primaryPhone?.phoneNumber };
  }

  async confirmShipment(orderId: string, items: MkOrderItem[], t: { carrier: string; trackingNumber: string; shippedAt: Date }) {
    await this.call('POST', `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, {
      lineItems: items.map((i) => ({ lineItemId: i.externalItemId, quantity: i.quantity })),
      shippedDate: t.shippedAt.toISOString(), shippingCarrierCode: t.carrier, trackingNumber: t.trackingNumber,
    });
  }

  async upsertListing(l: ListingPayload) {
    const issues: string[] = [];
    const p = this.cfg.policies ?? {};
    if (!p.fulfillmentPolicyId || !p.paymentPolicyId || !p.returnPolicyId || !p.merchantLocationKey) {
      return { externalId: null, status: 'ERROR' as const, issues: ['eBay business policies / merchantLocationKey not configured (NEEDS OWNER ACTION)'] };
    }
    await this.call('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(l.sku)}`, {
      availability: { shipToLocationAvailability: { quantity: l.quantity } },
      condition: 'NEW',
      product: {
        title: l.title.slice(0, 80), description: l.description, imageUrls: l.images,
        ean: l.ean ? [l.ean] : undefined,
        aspects: Object.fromEntries(Object.entries(l.attributes).map(([k, v]) => [k, [String(v)]])),
      },
    });
    let offerId = this.offerIds.get(l.sku);
    if (!offerId) {
      const existing = await this.call('GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(l.sku)}&marketplace_id=${this.cfg.marketplaceId}`).catch(() => ({ offers: [] }));
      offerId = existing.offers?.[0]?.offerId;
    }
    const offer = {
      sku: l.sku, marketplaceId: this.cfg.marketplaceId, format: 'FIXED_PRICE', availableQuantity: l.quantity,
      categoryId: l.productType, listingDescription: l.description, merchantLocationKey: p.merchantLocationKey,
      listingPolicies: { fulfillmentPolicyId: p.fulfillmentPolicyId, paymentPolicyId: p.paymentPolicyId, returnPolicyId: p.returnPolicyId },
      pricingSummary: { price: { value: l.price.toFixed(2), currency: l.currency } },
    };
    if (offerId) await this.call('PUT', `/sell/inventory/v1/offer/${offerId}`, offer);
    else offerId = (await this.call('POST', '/sell/inventory/v1/offer', offer)).offerId;
    this.offerIds.set(l.sku, offerId!);
    const pub = await this.call('POST', `/sell/inventory/v1/offer/${offerId}/publish`).catch((e: Error) => { issues.push(e.message); return null; });
    return { externalId: pub?.listingId ?? null, status: pub?.listingId ? 'ACTIVE' as const : 'ERROR' as const, issues };
  }

  async updatePriceQuantity(sku: string, u: { price?: number; currency?: string; quantity?: number }) {
    const offerId = this.offerIds.get(sku) ?? (await this.call('GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${this.cfg.marketplaceId}`)).offers?.[0]?.offerId;
    await this.call('POST', '/sell/inventory/v1/bulk_update_price_quantity', {
      requests: [{
        sku,
        ...(u.quantity != null ? { shipToLocationAvailability: { quantity: u.quantity } } : {}),
        offers: offerId ? [{ offerId, ...(u.quantity != null ? { availableQuantity: u.quantity } : {}), ...(u.price != null ? { price: { value: u.price.toFixed(2), currency: u.currency ?? this.cfg.currency } } : {}) }] : [],
      }],
    });
  }

  /** Browse API search by GTIN (application token). */
  async getCompetitivePrices(gtins: string[]): Promise<CompetitivePrice[]> {
    const out: CompetitivePrice[] = [];
    for (const g of gtins) {
      const r = await this.call('GET', `/buy/browse/v1/item_summary/search?gtin=${encodeURIComponent(g)}&filter=${encodeURIComponent('conditions:{NEW},buyingOptions:{FIXED_PRICE}')}&limit=50`, undefined, 'app');
      const prices = (r.itemSummaries ?? []).map((i: any) => Number(i.price?.value) + Number(i.shippingOptions?.[0]?.shippingCost?.value ?? 0)).filter((n: number) => n > 0);
      out.push({ key: g, lowest: prices.length ? Math.min(...prices) : null, buyBox: null, offerCount: r.total ?? prices.length, amazonOnListing: null });
    }
    return out;
  }

  async getAccountHealth(): Promise<HealthMetrics> {
    const p = await this.call('GET', '/sell/analytics/v1/seller_standards_profile/PROGRAM_DE/CURRENT').catch(() => null);
    if (!p) return {};
    const metric = (key: string) => {
      const m = (p.metrics ?? []).find((x: any) => x.metricKey === key);
      return m?.value?.value != null ? Number(m.value.value) : null;
    };
    return {
      odrPct: metric('DEFECTIVE_TRANSACTION_RATE'),
      lateShipmentPct: metric('SHIPPING_MISS_RATE'),
      cancelRatePct: null,
      validTrackingPct: metric('VALID_TRACKING_UPLOADED_WITHIN_HANDLING_RATE'),
      policyWarnings: 0,
      accountStatus: p.standardsLevel === 'BELOW_STANDARD' ? 'BELOW_STANDARD' : p.standardsLevel ?? null,
    };
  }

  async fetchReturns(_since: Date): Promise<MkReturn[]> {
    // Post-Order return search — remaining availability UNVERIFIED after 2026 decommissions; enable after sandbox check.
    return [];
  }
}
