/** Procurement Agent — finds wholesale suppliers for candidate products (section 4). */
import { many, one, db } from '../db/pool.js';
import { logAction } from '../services/audit.js';
import { raiseAlert } from '../services/alerts.js';
import { ctx, supplierReliability } from './context.js';

const SUPPLIER_DEFAULTS: Record<string, { name: string; country: string; eu: boolean; api: boolean; auto: boolean; wholesaler: boolean; blind: boolean; verified: boolean }> = {
  MOCK_EU_WHOLESALE: { name: 'Mock EU Wholesale (simulation)', country: 'SE', eu: true, api: true, auto: true, wholesaler: true, blind: true, verified: true },
  MOCK_RETAILER: { name: 'Mock Retail Shop (simulation)', country: 'DE', eu: true, api: true, auto: true, wholesaler: false, blind: false, verified: false },
  BIGBUY: { name: 'BigBuy (Spain)', country: 'ES', eu: true, api: true, auto: true, wholesaler: true, blind: false, verified: false },
};

export async function ensureSuppliers() {
  const c = await ctx();
  for (const code of c.reg.suppliers.keys()) {
    const d = SUPPLIER_DEFAULTS[code] ?? { name: code, country: '', eu: false, api: true, auto: false, wholesaler: false, blind: false, verified: false };
    const sim = c.mode === 'simulation' && d.verified;
    await db().query(
      `INSERT INTO suppliers(code, name, country, eu_warehouse, has_api, auto_ordering, is_wholesaler, blind_dropship, agreement_signed, company_verified, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10) ON CONFLICT (code) DO NOTHING`,
      [code, d.name, d.country, d.eu, d.api, d.auto, d.wholesaler, sim ? d.blind : false, sim, sim ? 'VERIFIED' : 'UNVERIFIED']);
    const s = await one<{ id: number; status: string }>('SELECT id, status FROM suppliers WHERE code=$1', [code]);
    if (s?.status === 'UNVERIFIED' && c.mode !== 'simulation') {
      await raiseAlert({ severity: 'WARNING', category: 'OWNER_ACTION', title: `Verify supplier ${code}: sign dropshipping agreement, confirm blind shipping & company details`, dedupeKey: `verify-supplier:${code}`, requiresOwner: true });
    }
  }
  await refreshReliability();
}

export async function refreshReliability() {
  const rows = await many(`SELECT s.*, (SELECT count(*) FROM supplier_orders so WHERE so.supplier_id=s.id AND so.status='PLACED')::int AS order_count FROM suppliers s`);
  for (const s of rows) {
    const score = supplierReliability(s);
    if (score !== s.reliability_score) await db().query('UPDATE suppliers SET reliability_score=$2 WHERE id=$1', [s.id, score]);
  }
}

export async function runSourcing() {
  const c = await ctx();
  if (!c.caps.research) return { skipped: 'automation disabled' };
  await ensureSuppliers();
  const products = await many<{ id: number; ean: string }>(
    `SELECT id, ean FROM products WHERE ean IS NOT NULL AND status IN ('RESEARCHING','REQUIRES_VERIFICATION','APPROVED_FOR_LISTING','ACTIVE') ORDER BY updated_at DESC LIMIT 500`);
  const byEan = new Map(products.map((p) => [p.ean, p.id]));
  let offers = 0;
  for (const [code, adapter] of c.reg.suppliers) {
    const supplier = await one<{ id: number }>('SELECT id FROM suppliers WHERE code=$1', [code]);
    if (!supplier) continue;
    const found = await adapter.searchOffers({ eans: [...byEan.keys()] });
    for (const o of found) {
      const pid = o.ean ? byEan.get(o.ean) : undefined;
      if (!pid) continue;
      const sp = await one<{ id: number }>(
        `INSERT INTO supplier_products(supplier_id, product_id, supplier_sku, ean, title, cost_price, cost_currency, shipping_cost, shipping_currency, moq, stock,
           delivery_days_min, delivery_days_max, ships_from, tracking_available, ce_marking, gpsr_manufacturer, gpsr_eu_responsible, safety_docs, images, image_rights, description, specs, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
         ON CONFLICT (supplier_id, supplier_sku) DO UPDATE SET product_id=EXCLUDED.product_id, cost_price=EXCLUDED.cost_price, stock=EXCLUDED.stock,
           delivery_days_min=EXCLUDED.delivery_days_min, delivery_days_max=EXCLUDED.delivery_days_max, ce_marking=EXCLUDED.ce_marking,
           gpsr_manufacturer=EXCLUDED.gpsr_manufacturer, gpsr_eu_responsible=EXCLUDED.gpsr_eu_responsible, safety_docs=EXCLUDED.safety_docs,
           images=EXCLUDED.images, image_rights=EXCLUDED.image_rights, description=EXCLUDED.description, specs=EXCLUDED.specs, last_synced_at=now()
         RETURNING id`,
        [supplier.id, pid, o.supplierSku, o.ean, o.title, o.costPrice, o.currency, o.shippingCost ?? null, o.moq, o.stock,
          o.deliveryDaysMin ?? null, o.deliveryDaysMax ?? null, o.shipsFrom ?? null, o.trackingAvailable ?? null, o.ceMarking ?? null,
          o.gpsrManufacturer ? JSON.stringify(o.gpsrManufacturer) : null, o.gpsrEuResponsible ? JSON.stringify(o.gpsrEuResponsible) : null,
          o.safetyDocs ? JSON.stringify(o.safetyDocs) : null, JSON.stringify(o.images ?? []), o.imageRights, o.description ?? null, o.specs ? JSON.stringify(o.specs) : null]);
      await db().query('INSERT INTO inventory_history(supplier_product_id, stock, cost_price) VALUES ($1,$2,$3)', [sp!.id, o.stock, o.costPrice]);
      offers++;
    }
    await logAction({ agent: 'sourcing', action: 'SUPPLIER_SEARCH', subjectType: 'supplier', subjectId: code, data: { searched: byEan.size, matched: found.length } });
  }
  return { products: products.length, offers };
}
