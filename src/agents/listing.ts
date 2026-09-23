/** Listing Agent (section 9). Prices stored internally in SEK; converted to marketplace currency at the API boundary. */
import { many, one, db, tx } from '../db/pool.js';
import { buildContent } from '../services/content.js';
import { fromSek } from '../services/fx.js';
import { logAction } from '../services/audit.js';
import { raiseAlert } from '../services/alerts.js';
import { listedQuantity } from '../domain/pricing.js';
import { ctx } from './context.js';

export async function runListing() {
  const c = await ctx();
  if (!c.caps.listing) return { skipped: `listing disabled (mode=${c.mode}, stage=${c.s.GO_LIVE_STAGE})` };
  const active = await one<{ n: number }>(`SELECT count(*)::int AS n FROM listings WHERE status IN ('ACTIVE','PENDING_PUBLISH')`);
  let slots = c.s.MAX_ACTIVE_LISTINGS - (active?.n ?? 0);
  if (slots <= 0) return { skipped: 'MAX_ACTIVE_LISTINGS reached' };

  // Latest APPROVED score per (product, marketplace), best score first, no listing yet.
  const rows = await many(`
    SELECT DISTINCT ON (ps.product_id, ps.marketplace_code) ps.*, p.title, p.brand, p.ean, p.asin, p.category, pc.min_allowed_price, pc.sale_price_gross
    FROM product_scores ps JOIN products p ON p.id=ps.product_id LEFT JOIN profit_calculations pc ON pc.id=ps.profit_calc_id
    WHERE p.status IN ('APPROVED_FOR_LISTING','ACTIVE')
    ORDER BY ps.product_id, ps.marketplace_code, ps.created_at DESC`);
  const candidates = rows.filter((r) => r.decision === 'APPROVED_FOR_LISTING').sort((a, b) => Number(b.score) - Number(a.score));
  let created = 0;
  for (const r of candidates) {
    if (slots <= 0) break;
    const mp = c.marketplaces.find((m) => m.code === r.marketplace_code);
    const adapter = c.reg.marketplaces.get(r.marketplace_code);
    if (!mp || !adapter || mp.automation_state !== 'ACTIVE') continue;
    const exists = await one(`SELECT id FROM listings WHERE product_id=$1 AND marketplace_code=$2`, [r.product_id, r.marketplace_code]);
    if (exists) continue;
    const sp = await one(`SELECT * FROM supplier_products WHERE id=$1`, [r.supplier_product_id]);
    if (!sp) continue;

    const content = await buildContent(r.marketplace_code, {
      title: sp.title ?? r.title, brand: r.brand, ean: r.ean, description: sp.description, specs: sp.specs,
      deliveryDaysMin: sp.delivery_days_min, deliveryDaysMax: sp.delivery_days_max,
      manufacturer: sp.gpsr_manufacturer, euResponsible: sp.gpsr_eu_responsible, safetyInfo: Array.isArray(sp.safety_docs) && sp.safety_docs.length ? 'See enclosed safety information' : null,
    });
    const floor = Number(r.min_allowed_price);
    const priceSek = Math.max(floor, Math.ceil(Number(r.sale_price_gross)));
    const qty = listedQuantity(sp.stock, c.s.SAFETY_STOCK, c.s.MIN_STOCK_BUFFER, c.s.MAX_LISTED_QTY);
    const sku = `AC-${r.product_id}-${r.marketplace_code}`;
    const needsLocalisation = c.mode !== 'simulation' && content.generator === 'template' && content.language !== 'en';

    const listingId = (await one<{ id: number }>(
      `INSERT INTO listings(product_id, supplier_product_id, marketplace_code, sku, status, price, min_price, max_price, quantity, content)
       VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9) ON CONFLICT (marketplace_code, sku) DO UPDATE SET updated_at=now() RETURNING id`,
      [r.product_id, sp.id, r.marketplace_code, sku, priceSek, floor, Math.floor(floor * c.s.PRICE_CEILING_MULTIPLIER), qty.qty, JSON.stringify(content)]))!.id;

    if (needsLocalisation || qty.pause) {
      await raiseAlert({ severity: 'INFO', category: 'LISTING', title: `Listing ${sku} kept as DRAFT: ${needsLocalisation ? 'needs localised copy (set ANTHROPIC_API_KEY)' : qty.reason}`, dedupeKey: `draft:${sku}` });
      continue;
    }
    const price = await fromSek(priceSek, mp.currency);
    const res = await adapter.upsertListing({
      sku, marketplaceCode: r.marketplace_code, ean: r.ean, asin: r.asin, title: content.title, bullets: content.bullets, description: content.description,
      attributes: content.attributes, images: sp.image_rights ? (sp.images ?? []) : [], price, currency: mp.currency, quantity: qty.qty,
      handlingDays: Math.max(1, Math.min(3, (sp.delivery_days_min ?? 2) - 1)), legal: { manufacturer: sp.gpsr_manufacturer, euResponsible: sp.gpsr_eu_responsible },
    });
    await tx(async (q) => {
      await q.query(`UPDATE listings SET status=$2, external_id=$3, last_published_at=now(), updated_at=now() WHERE id=$1`, [listingId, res.status, res.externalId]);
      if (res.status !== 'ERROR') await q.query(`UPDATE products SET status='ACTIVE', updated_at=now() WHERE id=$1`, [r.product_id]);
      await q.query(`INSERT INTO pricing_history(listing_id, old_price, new_price, floor_price, reason, applied) VALUES ($1,NULL,$2,$3,'initial listing',true)`, [listingId, priceSek, floor]);
      await logAction({ agent: 'listing', action: 'PUBLISH', subjectType: 'listing', subjectId: listingId, decision: res.status, reasons: res.issues,
        data: { sku, marketplace: r.marketplace_code, priceSek, price, currency: mp.currency, qty: qty.qty, generator: content.generator }, dryRun: !adapter.live }, q);
    });
    if (res.status === 'ERROR') await raiseAlert({ severity: 'WARNING', category: 'LISTING', title: `Listing ${sku} rejected by marketplace`, detail: res.issues, dedupeKey: `listing-error:${sku}` });
    else { slots--; created++; }
  }
  return { created };
}

/** Pause a listing on marketplace + DB (idempotent). */
export async function pauseListing(listingId: number, reason: string, agent: string) {
  const l = await one(`SELECT * FROM listings WHERE id=$1`, [listingId]);
  if (!l) return;
  const c = await ctx();
  const adapter = c.reg.marketplaces.get(l.marketplace_code);
  if (adapter && l.status !== 'DRAFT') await adapter.updatePriceQuantity(l.sku, { quantity: 0 });
  await db().query(`UPDATE listings SET status='PAUSED', pause_reason=$2, quantity=0, updated_at=now() WHERE id=$1`, [listingId, reason]);
  await logAction({ agent, action: 'PAUSE_LISTING', subjectType: 'listing', subjectId: listingId, reasons: [reason], dryRun: !adapter?.live });
}
