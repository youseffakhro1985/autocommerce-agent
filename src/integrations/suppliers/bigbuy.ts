/**
 * BigBuy (Spain, EU warehouse) wholesale/dropshipping supplier.
 * VERIFIED (bigbuy.eu, 2026-09): REST/JSON API with Catalog, Orders, Shipping, Tracking; sandbox exists;
 *   "Pack Marketplace" plan includes Amazon/eBay connectors (third-party pricing ~€119/mo — UNVERIFIED).
 * UNVERIFIED: exact endpoint paths/field names below follow BigBuy's public API guide (api.bigbuy.eu/rest/doc);
 *   validate every call against the sandbox before APP_MODE=live. Rate limits are strict on catalog calls.
 * Supplier must also be verified by the owner (agreement, blind shipping, GPSR data) before products can pass compliance.
 */
import { http } from '../http.js';
import type { SupplierAdapter, SupplierOffer, SupplierOrderRequest, SupplierTracking } from '../types.js';

export class BigBuyAdapter implements SupplierAdapter {
  readonly code = 'BIGBUY';
  constructor(private apiKey: string, private env: 'sandbox' | 'production', readonly live: boolean) {}
  private get base() { return this.env === 'sandbox' ? 'https://api.sandbox.bigbuy.eu' : 'https://api.bigbuy.eu'; }
  private call<T = any>(method: string, path: string, body?: unknown) {
    return http<T>(this.base + path, { method, headers: { authorization: 'Bearer ' + this.apiKey, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  }

  async searchOffers(q: { eans?: string[] }): Promise<SupplierOffer[]> {
    // BigBuy exposes the full catalogue (paged) rather than EAN search; we cache it and filter locally.
    const products = await this.call<any[]>('GET', '/rest/catalog/products.json?isoCode=en&pageSize=1000&page=0');
    const wanted = q.eans ? new Set(q.eans) : null;
    const hits = products.filter((p) => !wanted || wanted.has(String(p.ean13)));
    if (!hits.length) return [];
    const stock = await this.getStock(hits.map((p) => String(p.sku)));
    return hits.map((p) => ({
      supplierSku: String(p.sku), ean: String(p.ean13 ?? ''), title: p.name ?? String(p.sku), brand: p.manufacturer ? String(p.manufacturer) : null, category: p.category ? String(p.category) : null,
      costPrice: Number(p.wholesalePrice), currency: 'EUR', shippingCost: null, moq: 1,
      stock: stock.find((s) => s.supplierSku === String(p.sku))?.stock ?? 0,
      deliveryDaysMin: null, deliveryDaysMax: null, shipsFrom: 'ES', trackingAvailable: true,
      ceMarking: null, gpsrManufacturer: null, gpsrEuResponsible: null, safetyDocs: null, // fetched via product information / GPSR endpoints after sandbox validation
      images: [], imageRights: false, description: null, specs: { weight: p.weight, width: p.width, height: p.height, depth: p.depth },
    }));
  }

  async getStock(skus: string[]) {
    const r = await this.call<any[]>('GET', '/rest/catalog/productsstockavailable.json');
    const set = new Set(skus);
    return r.filter((x) => set.has(String(x.sku))).map((x) => ({
      supplierSku: String(x.sku), stock: (x.stocks ?? []).reduce((a: number, s: any) => a + Number(s.quantity ?? 0), 0), costPrice: NaN, currency: 'EUR',
    }));
  }

  async placeOrder(r: SupplierOrderRequest) {
    const order = {
      order: {
        internalReference: r.idempotencyKey, language: 'en', paymentMethod: 'moneybox',
        carriers: [{ name: 'standard shipment' }],
        shippingAddress: {
          firstName: r.shipTo.name, lastName: '-', country: r.shipTo.country, postcode: r.shipTo.postalCode, town: r.shipTo.city,
          address: [r.shipTo.line1, r.shipTo.line2].filter(Boolean).join(', '), phone: r.shipTo.phone ?? '', email: '', comment: '',
        },
        products: r.items.map((i) => ({ reference: i.supplierSku, quantity: i.quantity })),
        dropshipping: true, // neutral packaging; UNVERIFIED flag name — confirm blind-shipping setting in BigBuy account
      },
    };
    await this.call('POST', '/rest/order/check/multishipping.json', order);
    const res = await this.call('POST', '/rest/order/create/multishipping.json', order);
    return { externalRef: String(res.orders?.[0]?.id ?? res.id ?? r.idempotencyKey) };
  }

  async findOrderByReference(reference: string) {
    const r = await this.call('GET', `/rest/order/reference/${encodeURIComponent(reference)}.json`).catch(() => null);
    return r ? { externalRef: String(r.id), status: String(r.status ?? 'UNKNOWN') } : null;
  }

  async getTracking(orders: { reference: string; externalRef: string }[]): Promise<SupplierTracking[]> {
    if (!orders.length) return [];
    const byId = new Map(orders.map((o) => [o.externalRef, o.reference]));
    const r = await this.call<any[]>('POST', '/rest/tracking/orders.json', { trackingOrders: { orders: orders.map((o) => ({ id: o.externalRef })) } });
    const out: SupplierTracking[] = [];
    for (const o of r ?? []) for (const t of o.trackings ?? []) {
      out.push({ reference: byId.get(String(o.id)) ?? String(o.id), carrier: String(t.carrier?.name ?? 'Other'), trackingNumber: String(t.trackingNumber), trackingUrl: t.trackingUrl, shippedAt: new Date(t.statusDate ?? Date.now()), delivered: /deliver/i.test(String(t.statusDescription ?? '')) });
    }
    return out;
  }
}
