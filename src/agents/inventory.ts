/** Inventory Agent (sections 10 & 13): supplier stock/cost sync, quantity exposure, loss protection. */
import { many, db } from '../db/pool.js';
import { listedQuantity } from '../domain/pricing.js';
import { calculateProfit } from '../domain/profit.js';
import { logAction } from '../services/audit.js';
import { raiseAlert, resolveAlert } from '../services/alerts.js';
import { profitInputFor } from './evaluation.js';
import { pauseListing } from './listing.js';
import { ctx, estimateReturnRate } from './context.js';

export async function runInventory() {
  const c = await ctx();
  const listings = await many(`
    SELECT l.*, sp.supplier_sku, sp.stock AS sp_stock, sp.cost_price, sp.cost_currency, sp.shipping_cost, sp.shipping_currency, sp.ships_from, s.code AS supplier_code, p.category
    FROM listings l JOIN supplier_products sp ON sp.id=l.supplier_product_id JOIN suppliers s ON s.id=sp.supplier_id JOIN products p ON p.id=l.product_id
    WHERE l.status IN ('ACTIVE','PAUSED','PENDING_PUBLISH')`);
  const bySupplier = new Map<string, typeof listings>();
  for (const l of listings) bySupplier.set(l.supplier_code, [...(bySupplier.get(l.supplier_code) ?? []), l]);
  let paused = 0, resumed = 0, adjusted = 0;

  for (const [code, ls] of bySupplier) {
    const adapter = c.reg.suppliers.get(code);
    if (!adapter) continue;
    let stock;
    try { stock = await adapter.getStock([...new Set(ls.map((l) => l.supplier_sku))]); }
    catch (e: any) {
      // Unknown stock = unsafe to sell. Pause after repeated failure is handled by alert escalation.
      await raiseAlert({ severity: 'CRITICAL', category: 'SUPPLIER', title: `Stock feed failed for ${code}: ${e.message}`.slice(0, 300), dedupeKey: `stockfeed:${code}` });
      continue;
    }
    await resolveAlert(`stockfeed:${code}`);
    for (const l of ls) {
      const st = stock.find((x) => x.supplierSku === l.supplier_sku);
      const newStock = st ? st.stock : 0; // missing from feed => treat as out of stock
      const newCost = st && Number.isFinite(st.costPrice) ? st.costPrice : Number(l.cost_price);
      if (newStock !== l.sp_stock || newCost !== Number(l.cost_price)) {
        await db().query(`UPDATE supplier_products SET stock=$2, cost_price=$3, last_synced_at=now() WHERE id=$1`, [l.supplier_product_id, newStock, newCost]);
        await db().query(`INSERT INTO inventory_history(supplier_product_id, stock, cost_price) VALUES ($1,$2,$3)`, [l.supplier_product_id, newStock, newCost]);
      }
      // Loss protection: recompute floor with current cost.
      const mp = c.marketplaces.find((m) => m.code === l.marketplace_code);
      if (!mp) continue;
      const pin = await profitInputFor({ ...l, cost_price: newCost }, mp, Number(l.price), c.s, estimateReturnRate(l.category), l.category);
      const pr = calculateProfit(pin, { minNetMarginPct: c.s.MIN_NET_MARGIN_PCT, minProfitSek: c.s.MIN_PROFIT_PER_ORDER_SEK });
      if (pr.minAllowedPrice !== Number(l.min_price)) {
        await db().query(`UPDATE listings SET min_price=$2, max_price=GREATEST(max_price, $3) WHERE id=$1`, [l.id, pr.minAllowedPrice, Math.floor(pr.minAllowedPrice * c.s.PRICE_CEILING_MULTIPLIER)]);
      }
      const q = listedQuantity(newStock, c.s.SAFETY_STOCK, c.s.MIN_STOCK_BUFFER, c.s.MAX_LISTED_QTY);
      const belowFloor = Number(l.price) < pr.minAllowedPrice;
      if (belowFloor && !c.caps.repricing) {
        if (l.status !== 'PAUSED') {
          await pauseListing(l.id, `supplier cost rose: price ${l.price} < floor ${pr.minAllowedPrice} SEK`, 'inventory'); paused++;
          await raiseAlert({ severity: 'WARNING', category: 'PROFIT', title: `Paused ${l.sku}: unprofitable after supplier price change`, detail: { price: l.price, floor: pr.minAllowedPrice, cost: newCost }, dedupeKey: `unprofitable:${l.sku}` });
        }
        continue;
      }
      const adapterMp = c.reg.marketplaces.get(l.marketplace_code);
      if (q.pause) {
        if (l.status !== 'PAUSED') { await pauseListing(l.id, q.reason, 'inventory'); paused++; }
        else if (adapterMp && l.quantity !== 0) await adapterMp.updatePriceQuantity(l.sku, { quantity: 0 });
      } else if (l.status === 'PAUSED' && /stock/.test(l.pause_reason ?? '') && !belowFloor) {
        await adapterMp?.updatePriceQuantity(l.sku, { quantity: q.qty });
        await db().query(`UPDATE listings SET status='ACTIVE', pause_reason=NULL, quantity=$2, updated_at=now() WHERE id=$1`, [l.id, q.qty]);
        await logAction({ agent: 'inventory', action: 'RESUME_LISTING', subjectType: 'listing', subjectId: l.id, reasons: ['stock recovered'], data: { stock: newStock, qty: q.qty } });
        resumed++;
      } else if (l.status === 'ACTIVE' && q.qty !== l.quantity) {
        await adapterMp?.updatePriceQuantity(l.sku, { quantity: q.qty });
        await db().query(`UPDATE listings SET quantity=$2, updated_at=now() WHERE id=$1`, [l.id, q.qty]);
        await logAction({ agent: 'inventory', action: 'SET_QUANTITY', subjectType: 'listing', subjectId: l.id, reasons: [q.reason], data: { stock: newStock, qty: q.qty } });
        adjusted++;
      }
    }
  }
  return { listings: listings.length, paused, resumed, adjusted };
}
