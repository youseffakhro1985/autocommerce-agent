/**
 * Amazon Selling Partner API adapter (EU endpoint). Official API only — no scraping of Amazon.
 *
 * Status (checked 2026-09-23, see docs/INTEGRATIONS.md):
 *  - Auth: LWA refresh-token -> access token, header x-amz-access-token (AWS SigV4 no longer required).     VERIFIED (docs)
 *  - Orders v0 deprecated 2026-01-28, REMOVED 2027-03-27 -> migrate to Orders v2026-01-01 before then.      VERIFIED (deprecation schedule)
 *    This adapter still uses v0 paths; the v2026 migration is tracked as TODO(ORDERS_V2026).                 UNVERIFIED (v2026 path/params)
 *  - Listings Items 2021-08-01 (put/patch), Product Pricing 2022-05-01 competitiveSummary, Product Fees v0,
 *    Reports API GET_V2_SELLER_PERFORMANCE_REPORT for account health, Tokens API RDT for PII.                  UNVERIFIED (payload details: validate in SP-API sandbox)
 *  - SP-API usage fees: announced Nov 2025, cancelled 2026-05-12.                                             VERIFIED (secondary sources)
 */
import { http } from '../http.js';
import type { MarketplaceAdapter, MkOrder, ListingPayload, CompetitivePrice, Address, MkOrderItem, MkReturn } from '../types.js';
import type { HealthMetrics } from '../../domain/risk.js';

export interface SpApiConfig {
  clientId: string; clientSecret: string; refreshToken: string; sellerId: string; endpoint: string;
  marketplaceId: string; code: string; currency: string; live: boolean;
}

export class AmazonSpApi implements MarketplaceAdapter {
  private token?: { value: string; exp: number };
  constructor(private cfg: SpApiConfig) {}
  get code() { return this.cfg.code; }
  get live() { return this.cfg.live; }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const r = await http<{ access_token: string; expires_in: number }>('https://api.amazon.com/auth/o2/token', {
      method: 'POST', retries: 2,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.cfg.refreshToken, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
    });
    this.token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    return r.access_token;
  }

  private async call<T = any>(method: string, path: string, body?: unknown, tokenOverride?: string): Promise<T> {
    const token = tokenOverride ?? (await this.accessToken());
    return http<T>(this.cfg.endpoint + path, {
      method,
      headers: { 'x-amz-access-token': token, 'content-type': 'application/json', 'user-agent': 'AutoCommerceAgent/1.0 (Language=TypeScript)' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // ---------- Orders (v0; TODO(ORDERS_V2026) migrate before 2027-03-27) ----------
  async fetchOrders(since: Date): Promise<MkOrder[]> {
    const out: MkOrder[] = [];
    let next: string | undefined;
    do {
      const qs = new URLSearchParams({ MarketplaceIds: this.cfg.marketplaceId, LastUpdatedAfter: since.toISOString(), FulfillmentChannels: 'MFN' });
      if (next) qs.set('NextToken', next);
      const r = await this.call('GET', `/orders/v0/orders?${qs}`);
      for (const o of r.payload?.Orders ?? []) {
        const items = await this.call('GET', `/orders/v0/orders/${encodeURIComponent(o.AmazonOrderId)}/orderItems`);
        out.push({
          externalId: o.AmazonOrderId,
          status: o.OrderStatus,
          // Amazon only releases MFN orders for shipping once payment is authorised: Pending => not payable yet.
          paymentConfirmed: ['Unshipped', 'PartiallyShipped', 'Shipped'].includes(o.OrderStatus),
          cancelled: o.OrderStatus === 'Canceled',
          total: Number(o.OrderTotal?.Amount ?? 0), currency: o.OrderTotal?.CurrencyCode ?? this.cfg.currency,
          placedAt: new Date(o.PurchaseDate),
          shipBy: o.LatestShipDate ? new Date(o.LatestShipDate) : null,
          deliverBy: o.LatestDeliveryDate ? new Date(o.LatestDeliveryDate) : null,
          buyerRef: o.BuyerInfo?.BuyerEmail ? 'amz:' + hash(o.BuyerInfo.BuyerEmail) : 'amz:' + o.AmazonOrderId,
          shipCountry: o.ShippingAddress?.CountryCode ?? null,
          items: (items.payload?.OrderItems ?? []).map((it: any) => ({
            sku: it.SellerSKU, externalItemId: it.OrderItemId, quantity: Number(it.QuantityOrdered),
            unitPrice: Number(it.ItemPrice?.Amount ?? 0) / Math.max(1, Number(it.QuantityOrdered)),
          })),
          raw: { OrderStatus: o.OrderStatus, IsPrime: o.IsPrime, IsBusinessOrder: o.IsBusinessOrder },
        });
      }
      next = r.payload?.NextToken;
    } while (next);
    return out;
  }

  /** PII fetched just-in-time with a Restricted Data Token; never persisted. */
  async getShippingAddress(orderId: string): Promise<Address> {
    const path = `/orders/v0/orders/${encodeURIComponent(orderId)}/address`;
    const rdt = await this.call('POST', '/tokens/2021-03-01/restrictedDataToken', { restrictedResources: [{ method: 'GET', path }] });
    const r = await this.call('GET', path, undefined, rdt.restrictedDataToken);
    const a = r.payload?.ShippingAddress ?? {};
    return { name: a.Name, line1: a.AddressLine1, line2: a.AddressLine2, city: a.City, postalCode: a.PostalCode, country: a.CountryCode, phone: a.Phone };
  }

  async confirmShipment(orderId: string, items: MkOrderItem[], t: { carrier: string; trackingNumber: string; shippedAt: Date }) {
    await this.call('POST', `/orders/v0/orders/${encodeURIComponent(orderId)}/shipmentConfirmation`, {
      marketplaceId: this.cfg.marketplaceId,
      packageDetail: {
        packageReferenceId: '1',
        carrierCode: 'Other', carrierName: t.carrier, trackingNumber: t.trackingNumber, shipDate: t.shippedAt.toISOString(),
        orderItems: items.map((i) => ({ orderItemId: i.externalItemId, quantity: i.quantity })),
      },
    });
  }

  // ---------- Listings Items 2021-08-01 ----------
  async upsertListing(l: ListingPayload) {
    const mp = this.cfg.marketplaceId;
    const offer = offerAttributes(mp, l.price, l.currency, l.quantity, l.handlingDays);
    // Prefer offer-only on an existing catalog ASIN (no new detail page). Full listing requires product type attributes.
    const body = l.asin
      ? { productType: l.productType ?? 'PRODUCT', requirements: 'LISTING_OFFER_ONLY', attributes: { ...offer, condition_type: [{ value: 'new_new', marketplace_id: mp }], merchant_suggested_asin: [{ value: l.asin, marketplace_id: mp }] } }
      : { productType: l.productType ?? 'PRODUCT', requirements: 'LISTING', attributes: { ...offer, ...l.attributes } };
    const r = await this.call('PUT', `/listings/2021-08-01/items/${this.cfg.sellerId}/${encodeURIComponent(l.sku)}?marketplaceIds=${mp}&issueLocale=en_US`, body);
    const issues: string[] = (r.issues ?? []).map((i: any) => `${i.severity}: ${i.message}`);
    const status = r.status === 'ACCEPTED' ? (issues.some((i) => i.startsWith('ERROR')) ? 'ERROR' : 'PENDING_PUBLISH') : 'ERROR';
    return { externalId: l.asin ?? null, status: status as 'PENDING_PUBLISH' | 'ERROR', issues };
  }

  async updatePriceQuantity(sku: string, u: { price?: number; currency?: string; quantity?: number }) {
    const mp = this.cfg.marketplaceId;
    const patches: any[] = [];
    if (u.price != null) patches.push({ op: 'replace', path: '/attributes/purchasable_offer', value: [{ marketplace_id: mp, currency: u.currency ?? this.cfg.currency, our_price: [{ schedule: [{ value_with_tax: u.price }] }] }] });
    if (u.quantity != null) patches.push({ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: u.quantity }] });
    if (!patches.length) return;
    await this.call('PATCH', `/listings/2021-08-01/items/${this.cfg.sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${mp}`, { productType: 'PRODUCT', patches });
  }

  // ---------- Pricing 2022-05-01 (batch, max 20 ASINs) ----------
  async getCompetitivePrices(asins: string[]): Promise<CompetitivePrice[]> {
    const out: CompetitivePrice[] = [];
    for (let i = 0; i < asins.length; i += 20) {
      const chunk = asins.slice(i, i + 20);
      const r = await this.call('POST', '/batches/products/pricing/2022-05-01/items/competitiveSummary', {
        requests: chunk.map((asin) => ({
          asin, marketplaceId: this.cfg.marketplaceId, includedData: ['featuredBuyingOptions', 'lowestPricedOffers'],
          lowestPricedOffersInputs: [{ itemCondition: 'New', offerType: 'Consumer' }], method: 'GET', uri: '/products/pricing/2022-05-01/items/competitiveSummary',
        })),
      });
      for (const resp of r.responses ?? []) {
        const b = resp.body ?? {};
        const fo = b.featuredBuyingOptions?.[0]?.segmentedFeaturedOffers?.[0];
        const lows = (b.lowestPricedOffers?.[0]?.offers ?? []).map((o: any) => Number(o.listingPrice?.amount) + Number(o.shippingOptions?.[0]?.price?.amount ?? 0));
        out.push({
          key: b.asin ?? resp.request?.asin,
          buyBox: fo ? Number(fo.listingPrice?.amount) : null,
          lowest: lows.length ? Math.min(...lows) : null,
          offerCount: b.lowestPricedOffers?.[0]?.offers?.length ?? null,
          // Amazon-retail presence comes from Keepa (buyBoxIsAmazon / csv AMAZON); not derivable reliably here.
          amazonOnListing: null,
        });
      }
    }
    return out;
  }

  /** Product Fees v0 — used to verify/overwrite the conservative fee table. */
  async estimateFees(asin: string, price: number): Promise<{ total: number } | null> {
    const r = await this.call('POST', `/products/fees/v0/items/${encodeURIComponent(asin)}/feesEstimate`, {
      FeesEstimateRequest: { MarketplaceId: this.cfg.marketplaceId, IsAmazonFulfilled: false, Identifier: `fe-${asin}-${price}`, PriceToEstimateFees: { ListingPrice: { CurrencyCode: this.cfg.currency, Amount: price } } },
    });
    const t = r.payload?.FeesEstimateResult?.FeesEstimate?.TotalFeesEstimate?.Amount;
    return t != null ? { total: Number(t) } : null;
  }

  // ---------- Account health via Reports API ----------
  async getAccountHealth(): Promise<HealthMetrics> {
    const created = await this.call('POST', '/reports/2021-06-30/reports', { reportType: 'GET_V2_SELLER_PERFORMANCE_REPORT', marketplaceIds: [this.cfg.marketplaceId] });
    let rep: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 15_000));
      rep = await this.call('GET', `/reports/2021-06-30/reports/${created.reportId}`);
      if (['DONE', 'CANCELLED', 'FATAL'].includes(rep.processingStatus)) break;
    }
    if (rep?.processingStatus !== 'DONE') return {};
    const doc = await this.call('GET', `/reports/2021-06-30/documents/${rep.reportDocumentId}`);
    const raw = await http<string>(doc.url, { raw: true });
    const j = JSON.parse(raw);
    const m = j.performanceMetrics?.[0] ?? {};
    const pct = (x: any) => (x?.rate != null ? Number(x.rate) * 100 : null);
    return {
      odrPct: pct(m.orderDefectRate?.mfn),
      lateShipmentPct: pct(m.lateShipmentRate),
      cancelRatePct: pct(m.preFulfillmentCancellationRate),
      validTrackingPct: pct(m.validTrackingRate),
      policyWarnings: Number(m.policyViolationDefects?.defectsCount ?? 0) + Number(m.listingPolicyViolations?.defectsCount ?? 0),
      accountStatus: j.accountStatuses?.find((a: any) => a.marketplaceId === this.cfg.marketplaceId)?.status ?? null,
    };
  }

  async fetchReturns(_since: Date): Promise<MkReturn[]> {
    // MFN returns: Reports API GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE (UNVERIFIED for EU MFN) — implement after sandbox validation.
    return [];
  }
}

function offerAttributes(mp: string, price: number, currency: string, qty: number, handlingDays: number) {
  return {
    purchasable_offer: [{ marketplace_id: mp, currency, our_price: [{ schedule: [{ value_with_tax: price }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: qty, lead_time_to_ship_max_days: handlingDays }],
  };
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
