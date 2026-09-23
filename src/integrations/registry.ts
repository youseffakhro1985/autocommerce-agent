import { env } from '../config/env.js';
import type { MarketplaceAdapter, SupplierAdapter, MarketDataAdapter } from './types.js';
import { MockMarketplace, MockSupplier, MockMarketData } from './mock/index.js';
import { AmazonSpApi } from './amazon/spapi.js';
import { EbayAdapter } from './ebay/ebay.js';
import { BigBuyAdapter } from './suppliers/bigbuy.js';
import { KeepaAdapter } from './marketdata/keepa.js';
import { sekPer } from '../services/fx.js';

/**
 * Adapter wiring. simulation => mocks only. sandbox => real APIs in their sandboxes. live => production APIs.
 * Missing credentials => adapter absent and the Ops agent raises a NEEDS OWNER ACTION alert.
 */
export interface Registry {
  marketplaces: Map<string, MarketplaceAdapter>;
  suppliers: Map<string, SupplierAdapter>;
  marketData: MarketDataAdapter[];
  missing: string[];
}

let reg: Registry | undefined;
export function setRegistry(r: Registry | undefined) { reg = r; }

export function registry(): Registry {
  if (reg) return reg;
  const e = env();
  const r: Registry = { marketplaces: new Map(), suppliers: new Map(), marketData: [], missing: [] };
  if (e.APP_MODE === 'simulation') {
    r.marketplaces.set('AMAZON_SE', new MockMarketplace('AMAZON_SE', 'SEK'));
    r.marketplaces.set('EBAY_DE', new MockMarketplace('EBAY_DE', 'EUR'));
    r.suppliers.set('MOCK_EU_WHOLESALE', new MockSupplier('MOCK_EU_WHOLESALE'));
    r.suppliers.set('MOCK_RETAILER', new MockSupplier('MOCK_RETAILER'));
    r.marketData.push(new MockMarketData());
    return (reg = r);
  }
  const live = e.APP_MODE === 'live';
  if (e.AMAZON_LWA_CLIENT_ID && e.AMAZON_LWA_CLIENT_SECRET && e.AMAZON_REFRESH_TOKEN && e.AMAZON_SELLER_ID) {
    const endpoint = live ? e.AMAZON_SPAPI_ENDPOINT : 'https://sandbox.sellingpartnerapi-eu.amazon.com';
    r.marketplaces.set('AMAZON_SE', new AmazonSpApi({ clientId: e.AMAZON_LWA_CLIENT_ID, clientSecret: e.AMAZON_LWA_CLIENT_SECRET, refreshToken: e.AMAZON_REFRESH_TOKEN, sellerId: e.AMAZON_SELLER_ID, endpoint, marketplaceId: 'A2NODRKZP88ZB9', code: 'AMAZON_SE', currency: 'SEK', live }));
  } else r.missing.push('Amazon SP-API credentials (AMAZON_LWA_CLIENT_ID/SECRET, AMAZON_REFRESH_TOKEN, AMAZON_SELLER_ID)');
  if (e.EBAY_CLIENT_ID && e.EBAY_CLIENT_SECRET && e.EBAY_REFRESH_TOKEN) {
    r.marketplaces.set('EBAY_DE', new EbayAdapter({
      clientId: e.EBAY_CLIENT_ID, clientSecret: e.EBAY_CLIENT_SECRET, refreshToken: e.EBAY_REFRESH_TOKEN, env: live ? 'production' : e.EBAY_ENV,
      marketplaceId: 'EBAY_DE', code: 'EBAY_DE', currency: 'EUR', contentLanguage: 'de-DE', live,
      policies: { fulfillmentPolicyId: e.EBAY_FULFILLMENT_POLICY_ID, paymentPolicyId: e.EBAY_PAYMENT_POLICY_ID, returnPolicyId: e.EBAY_RETURN_POLICY_ID, merchantLocationKey: e.EBAY_MERCHANT_LOCATION_KEY },
    }));
  } else r.missing.push('eBay credentials (EBAY_CLIENT_ID/SECRET, EBAY_REFRESH_TOKEN)');
  if (e.BIGBUY_API_KEY) r.suppliers.set('BIGBUY', new BigBuyAdapter(e.BIGBUY_API_KEY, live ? 'production' : e.BIGBUY_ENV, live));
  else r.missing.push('Supplier API key (BIGBUY_API_KEY) — or another verified wholesaler');
  if (e.KEEPA_API_KEY) r.marketData.push(new KeepaAdapter(e.KEEPA_API_KEY, sekPer));
  else r.missing.push('KEEPA_API_KEY (market research data)');
  return (reg = r);
}
