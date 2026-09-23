/**
 * Keepa API (third-party Amazon price/rank history). VERIFIED (keepa.com/api-docs, 2026-09):
 *  - domains: 1 com, 2 co.uk, 3 de, 4 fr, 5 co.jp, 6 ca, 8 it, 9 es, 10 in, 11 com.mx, 12 com.br
 *  - NOT supported: amazon.se, amazon.nl, amazon.pl  -> for AMAZON_SE we use amazon.de (3) as EU demand proxy
 *    and verify SE price/competition with SP-API Product Pricing.
 *  - product request = 1 token/ASIN (+6 per offer page); product finder (/query) 10 tokens/page; /bestsellers.
 * UNVERIFIED: exact stats field indexes used below (csv type 3 = SALES rank, 1 = NEW price). Validate on first run.
 */
import { http } from '../http.js';
import type { MarketDataAdapter, MarketCandidate } from '../types.js';

const DOMAIN: Record<string, number> = { AMAZON_SE: 3, AMAZON_DE: 3, AMAZON_FR: 4, AMAZON_IT: 8, AMAZON_ES: 9, AMAZON_UK: 2, AMAZON_NL: 3, EBAY_DE: 3, EBAY_SE: 3, EBAY_GB: 2 };

export class KeepaAdapter implements MarketDataAdapter {
  readonly code = 'keepa';
  constructor(private key: string, private fx: (cur: string) => Promise<number>, private categories: number[] = []) {}

  async discover(marketplaceCode: string, { maxResults }: { maxResults: number }): Promise<MarketCandidate[]> {
    const domain = DOMAIN[marketplaceCode] ?? 3;
    // Product Finder: mid-rank, few offers, no Amazon retail, stable-ish price, decent rating.
    const selection = {
      current_SALES_gte: 2000, current_SALES_lte: 60000,
      current_COUNT_NEW_lte: 8, current_NEW_gte: 1500, current_NEW_lte: 8000,   // €15–80 (cents)
      current_RATING_gte: 40, isAdultProduct: false, buyBoxIsAmazon: false,
      ...(this.categories.length ? { rootCategory: this.categories } : {}),
      perPage: Math.min(100, maxResults), page: 0,
    };
    const q = await http<{ asinList?: string[] }>(`https://api.keepa.com/query?key=${this.key}&domain=${domain}&selection=${encodeURIComponent(JSON.stringify(selection))}`);
    const asins = (q.asinList ?? []).slice(0, maxResults);
    if (!asins.length) return [];
    const r = await http<{ products?: any[] }>(`https://api.keepa.com/product?key=${this.key}&domain=${domain}&asin=${asins.join(',')}&stats=90&rating=1`);
    const eurSek = await this.fx(domain === 2 ? 'GBP' : 'EUR');
    return (r.products ?? []).map((p) => {
      const st = p.stats ?? {};
      const avgNew = Array.isArray(st.avg90) ? st.avg90[1] : null;
      const minNew = Array.isArray(st.min90) ? st.min90[1]?.[1] : null;
      const maxNew = Array.isArray(st.max90) ? st.max90[1]?.[1] : null;
      const stddev = avgNew && minNew && maxNew && avgNew > 0 ? ((maxNew - minNew) / 4 / avgNew) * 100 : null;
      return {
        title: String(p.title ?? ''), asin: p.asin, ean: Array.isArray(p.eanList) ? p.eanList[0] : null, brand: p.brand ?? null,
        category: Array.isArray(p.categoryTree) ? p.categoryTree.map((c: any) => c.name).join(' > ') : null,
        marketplaceCode, salesRank: Array.isArray(st.current) ? st.current[3] : null, salesRankDrops30d: st.salesRankDrops30 ?? null,
        estMonthlySales: p.monthlySold ?? null,
        avgPriceSek90d: avgNew && avgNew > 0 ? Math.round((avgNew / 100) * eurSek) : null,
        priceStddevPct: stddev, offerCount: Array.isArray(st.current) ? st.current[11] : null,
        amazonIsSeller: st.buyBoxIsAmazon ?? null, rating: Array.isArray(st.current) && st.current[16] > 0 ? st.current[16] / 10 : null,
        reviewCount: Array.isArray(st.current) ? st.current[17] : null, trendIndex: null, adIntensity: 'UNKNOWN',
        expectedReturnRate: null, source: 'keepa', raw: { asin: p.asin, rootCategory: p.rootCategory },
      } satisfies MarketCandidate;
    });
  }
}
