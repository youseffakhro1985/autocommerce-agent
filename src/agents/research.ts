/** Product Research Agent — discovers candidates and stores market metrics (section 3). */
import { one, db } from '../db/pool.js';
import { logAction } from '../services/audit.js';
import { ctx, estimateReturnRate } from './context.js';

export async function runResearch(maxPerSource = 50) {
  const c = await ctx();
  if (!c.caps.research) return { skipped: 'automation disabled' };
  let found = 0, updated = 0;
  for (const mp of c.marketplaces) {
    for (const src of c.reg.marketData) {
      const cands = await src.discover(mp.code, { maxResults: maxPerSource });
      for (const cand of cands) {
        if (!cand.ean && !cand.asin) continue;
        const existing = await one<{ id: number; status: string; updated_at: Date }>(
          `SELECT id, status, updated_at FROM products WHERE (ean IS NOT NULL AND ean=$1) OR (asin IS NOT NULL AND asin=$2) LIMIT 1`, [cand.ean ?? null, cand.asin ?? null]);
        let productId: number;
        if (existing) {
          productId = existing.id; updated++;
          await db().query(`UPDATE products SET asin=COALESCE(asin,$2), ean=COALESCE(ean,$3), updated_at=now() WHERE id=$1`, [productId, cand.asin ?? null, cand.ean ?? null]);
        } else {
          const r = await one<{ id: number }>(
            `INSERT INTO products(title, brand, ean, asin, category, source, status) VALUES ($1,$2,$3,$4,$5,$6,'RESEARCHING') RETURNING id`,
            [cand.title.slice(0, 500), cand.brand ?? null, cand.ean ?? null, cand.asin ?? null, cand.category ?? null, cand.source]);
          productId = r!.id; found++;
          await logAction({ agent: 'research', action: 'DISCOVERED', subjectType: 'product', subjectId: productId, data: { title: cand.title, marketplace: mp.code, source: cand.source } });
        }
        await db().query(
          `INSERT INTO product_research(product_id, marketplace_code, sales_rank, sales_rank_drops_30d, est_monthly_sales, avg_price_sek_90d, price_stddev_pct,
             offer_count, amazon_is_seller, rating, review_count, review_growth_30d, negative_themes, trend_index, ad_intensity, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [productId, mp.code, cand.salesRank ?? null, cand.salesRankDrops30d ?? null, cand.estMonthlySales ?? null, cand.avgPriceSek90d ?? null,
            cand.priceStddevPct ?? null, cand.offerCount ?? null, cand.amazonIsSeller ?? null, cand.rating ?? null, cand.reviewCount ?? null,
            cand.reviewGrowth30d ?? null, JSON.stringify(cand.negativeThemes ?? []), cand.trendIndex ?? null, cand.adIntensity ?? 'UNKNOWN',
            JSON.stringify({ ...(cand.raw as object ?? {}), expectedReturnRate: cand.expectedReturnRate ?? estimateReturnRate(cand.category), returnRateEstimated: cand.expectedReturnRate == null })]);
        if (cand.avgPriceSek90d != null || cand.offerCount != null) {
          await db().query(`INSERT INTO competitor_data(product_id, marketplace_code, lowest_price, offer_count, amazon_on_listing, raw) VALUES ($1,$2,$3,$4,$5,$6)`,
            [productId, mp.code, cand.avgPriceSek90d ?? null, cand.offerCount ?? null, cand.amazonIsSeller ?? null, JSON.stringify({ source: cand.source, basis: 'avg90' })]);
        }
      }
    }
  }
  return { found, updated };
}
