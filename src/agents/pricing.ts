/** Pricing Agent (section 11). Never below floor; no price wars. */
import { many, db, tx } from '../db/pool.js';
import { decidePrice } from '../domain/pricing.js';
import { toSek, fromSek } from '../services/fx.js';
import { logAction } from '../services/audit.js';
import { raiseAlert } from '../services/alerts.js';
import { ctx } from './context.js';

export async function runPricing() {
  const c = await ctx();
  if (!c.caps.repricing) return { skipped: `repricing disabled (stage=${c.s.GO_LIVE_STAGE})` };
  let changed = 0;
  for (const mp of c.marketplaces) {
    if (mp.automation_state !== 'ACTIVE') continue;
    const adapter = c.reg.marketplaces.get(mp.code);
    if (!adapter) continue;
    const ls = await many(`
      SELECT l.*, p.asin, p.ean, (SELECT max(created_at) FROM pricing_history ph WHERE ph.listing_id=l.id AND ph.applied) AS last_change
      FROM listings l JOIN products p ON p.id=l.product_id WHERE l.marketplace_code=$1 AND l.status='ACTIVE'`, [mp.code]);
    if (!ls.length) continue;
    const keys = ls.map((l) => (mp.channel === 'AMAZON' ? l.asin : l.ean)).filter(Boolean);
    const prices = await adapter.getCompetitivePrices(keys);
    for (const l of ls) {
      const cp = prices.find((p) => p.key === (mp.channel === 'AMAZON' ? l.asin : l.ean));
      const lowest = cp?.lowest != null ? await toSek(cp.lowest, mp.currency) : null;
      const buyBox = cp?.buyBox != null ? await toSek(cp.buyBox, mp.currency) : null;
      await db().query(`INSERT INTO competitor_data(product_id, marketplace_code, lowest_price, buybox_price, offer_count, amazon_on_listing, raw) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [l.product_id, mp.code, lowest, buyBox, cp?.offerCount ?? null, cp?.amazonOnListing ?? null, JSON.stringify({ source: 'pricing', currency: mp.currency })]);
      const hours = l.last_change ? (Date.now() - new Date(l.last_change).getTime()) / 36e5 : 1e6;
      const d = decidePrice({
        currentPrice: Number(l.price), floor: Number(l.min_price), ceiling: Number(l.max_price), lowestCompetitor: lowest, buyBoxPrice: buyBox,
        hoursSinceLastChange: hours, maxChangePct: c.s.MAX_PRICE_CHANGE_PCT_PER_RUN, cooldownHours: c.s.MIN_HOURS_BETWEEN_PRICE_CHANGES, undercutSek: c.s.UNDERCUT_SEK,
      });
      if (d.competitorBelowFloor) {
        await raiseAlert({ severity: 'INFO', category: 'PRICING', title: `Competitor below our floor on ${l.sku} — holding price (no price war)`, dedupeKey: `below-floor:${l.sku}` });
      }
      if (!d.changed) continue;
      await adapter.updatePriceQuantity(l.sku, { price: await fromSek(d.newPrice, mp.currency), currency: mp.currency });
      await tx(async (q) => {
        await q.query(`UPDATE listings SET price=$2, updated_at=now() WHERE id=$1`, [l.id, d.newPrice]);
        await q.query(`INSERT INTO pricing_history(listing_id, old_price, new_price, floor_price, reason, applied) VALUES ($1,$2,$3,$4,$5,true)`, [l.id, l.price, d.newPrice, l.min_price, d.reason]);
        await logAction({ agent: 'pricing', action: 'REPRICE', subjectType: 'listing', subjectId: l.id, decision: 'CHANGED', reasons: [d.reason], data: { from: l.price, to: d.newPrice, floor: l.min_price, lowest, buyBox }, dryRun: !adapter.live }, q);
      });
      changed++;
    }
  }
  return { changed };
}
