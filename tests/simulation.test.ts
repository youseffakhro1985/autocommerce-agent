/**
 * End-to-end simulation against a real Postgres with mock marketplaces/suppliers. No real money.
 * DATABASE_URL must point to a disposable database (it is wiped).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

process.env.APP_MODE = 'simulation';
process.env.DATABASE_URL ??= 'postgres://postgres@localhost:5433/ac_test';

const { db, closeDb, many, one } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { updateSetting } = await import('../src/domain/settings.js');
const { registry, setRegistry } = await import('../src/integrations/registry.js');
const { resetMockRng } = await import('../src/integrations/mock/index.js');
type MockMarketplace = import('../src/integrations/mock/index.js').MockMarketplace;
type MockSupplier = import('../src/integrations/mock/index.js').MockSupplier;
const { runResearch } = await import('../src/agents/research.js');
const { runSourcing } = await import('../src/agents/sourcing.js');
const { runEvaluation } = await import('../src/agents/evaluation.js');
const { runListing } = await import('../src/agents/listing.js');
const { runInventory } = await import('../src/agents/inventory.js');
const { runPricing } = await import('../src/agents/pricing.js');
const { runOrderCycle, syncTracking, reconcileSupplierOrders } = await import('../src/agents/orders.js');
const { runHealth } = await import('../src/agents/health.js');
const { buildDailyReport } = await import('../src/agents/reports.js');
const { JOBS, runJob } = await import('../src/scheduler.js');

const amazon = () => registry().marketplaces.get('AMAZON_SE') as MockMarketplace;
const supplier = () => registry().suppliers.get('MOCK_EU_WHOLESALE') as MockSupplier;

beforeAll(async () => {
  await db().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  setRegistry(undefined); resetMockRng(42);
  await migrate();
  await updateSetting('CURRENT_CASH_SEK', 50000, 'test');
});
afterAll(async () => { await closeDb(); });

describe('autonomous pipeline (simulation)', () => {
  it('research → sourcing → evaluation produce explained decisions', async () => {
    const r = await runResearch();
    expect(r.found).toBe(11);
    const s = await runSourcing();
    expect(s.offers).toBeGreaterThanOrEqual(9);
    await runEvaluation();
    const rows = await many<{ title: string; status: string }>(`SELECT title, status FROM products ORDER BY id`);
    const st = Object.fromEntries(rows.map((x) => [x.title, x.status]));
    expect(st['Bamboo Kitchen Utensil Set 6 pcs with Holder']).toBe('APPROVED_FOR_LISTING');
    expect(st['Collapsible Silicone Storage Box Set 3 pcs']).toBe('APPROVED_FOR_LISTING');
    expect(st['Stainless Steel Drinking Straws 8 pcs']).toBe('REJECTED');        // margin / competition
    expect(st['Desk Cable Management Tray']).toBe('REJECTED');                    // delivery 16 days
    expect(st['Mini Power Bank 10000mAh Lithium']).toBe('BLOCKED');               // batteries
    expect(st['Wooden Stacking Toy for Toddlers']).toBe('BLOCKED');               // toys
    expect(st['Nike Style Gym Bag']).toBe('BLOCKED');                             // IP
    expect(st['Cotton Waffle Kitchen Towels 4 pcs']).toBe('REQUIRES_VERIFICATION'); // GPSR missing
    expect(st['Glass Meal Prep Containers 5 pcs']).toBe('BLOCKED');               // retailer source
    expect(st['Linen Table Runner 180 cm']).toBe('REQUIRES_VERIFICATION');        // no supplier
    const expl = await one(`SELECT data->>'explanation' e FROM agent_actions WHERE action='PRODUCT_DECISION' AND decision='APPROVED_FOR_LISTING' LIMIT 1`);
    expect(expl.e).toMatch(/Expected profit: \d+ SEK/);
    const rej = await one(`SELECT data->>'explanation' e FROM agent_actions a JOIN products p ON p.id::text=a.subject_id WHERE p.title LIKE 'Desk Cable%' AND a.action='PRODUCT_DECISION' LIMIT 1`);
    expect(rej.e).toMatch(/delivery 16 days/);
  });

  it('lists only approved products, never below floor, on both marketplaces', async () => {
    const r = await runListing();
    expect(r.created).toBeGreaterThanOrEqual(2);
    const ls = await many(`SELECT * FROM listings`);
    for (const l of ls) expect(Number(l.price)).toBeGreaterThanOrEqual(Number(l.min_price));
    expect(new Set(ls.map((l) => l.marketplace_code))).toEqual(new Set(['AMAZON_SE', 'EBAY_DE']));
    expect(amazon().listings.size).toBeGreaterThanOrEqual(1);
    const eb = registry().marketplaces.get('EBAY_DE') as MockMarketplace;
    const any = [...eb.listings.values()][0];
    expect(any.currency).toBe('EUR');
    expect(any.price).toBeLessThan(60); // SEK converted to EUR at boundary
  });

  it('places exactly one supplier order per marketplace order, even when jobs run twice', async () => {
    const l = [...amazon().listings.values()][0];
    amazon().injectOrder(l.sku, 1, l.price);
    amazon().injectOrder(l.sku, 1, l.price);
    const a = await runOrderCycle();
    const b = await runOrderCycle(); // re-run: nothing new
    expect(a.placed).toBe(2);
    expect(b.placed).toBe(0);
    const so = await many(`SELECT * FROM supplier_orders`);
    expect(so.length).toBe(2);
    expect(supplier().placedCount).toBe(2);
    const fin = await one(`SELECT count(*)::int n FROM transactions WHERE kind='SALE'`);
    expect(fin.n).toBe(2);
  });

  it('crash between PLACING and API reply is reconciled, not re-ordered', async () => {
    await db().query(`UPDATE supplier_orders SET status='UNKNOWN_NEEDS_RECONCILE' WHERE id=(SELECT min(id) FROM supplier_orders)`);
    const before = supplier().placedCount;
    const r = await reconcileSupplierOrders();
    expect(r.fixed).toBe(1);
    expect(supplier().placedCount).toBe(before);
  });

  it('imports tracking and uploads it to the marketplace once', async () => {
    const t1 = await syncTracking();
    const t2 = await syncTracking();
    expect(t1.uploaded).toBe(2);
    expect(t2.uploaded).toBe(0);
    expect(amazon().shipments.length).toBe(2);
    const st = await many(`SELECT status FROM orders`);
    expect(st.every((o) => o.status === 'TRACKING_UPLOADED')).toBe(true);
  });

  it('holds orders that exceed spending limits for owner approval', async () => {
    await updateSetting('MAX_ORDER_VALUE_SEK', 100, 'test');
    const l = [...amazon().listings.values()][0];
    amazon().injectOrder(l.sku, 1, l.price);
    const r = await runOrderCycle();
    expect(r.awaitingApproval).toBe(1);
    const ap = await one(`SELECT * FROM approval_requests WHERE kind='PLACE_SUPPLIER_ORDER' AND status='PENDING'`);
    expect(ap).toBeTruthy();
    // owner approves -> placed on next cycle
    await db().query(`UPDATE approval_requests SET status='APPROVED' WHERE id=$1`, [ap.id]);
    const r2 = await runOrderCycle();
    expect(r2.placed).toBe(1);
    await updateSetting('MAX_ORDER_VALUE_SEK', 1500, 'test');
  });

  it('holds suspected fraud', async () => {
    const l = [...amazon().listings.values()][0];
    amazon().injectOrder(l.sku, 1, l.price, { shipCountry: 'US' });
    const r = await runOrderCycle();
    expect(r.held).toBe(1);
    const o = await one(`SELECT status, hold_reason FROM orders WHERE ship_country='US'`);
    expect(o.status).toBe('ON_HOLD');
    expect(o.hold_reason).toMatch(/fraud/);
  });

  it('pauses listing when supplier stock runs out, resumes when back', async () => {
    const sku = [...amazon().listings.values()][0].sku;
    const lrow = await one(`SELECT l.*, sp.supplier_sku FROM listings l JOIN supplier_products sp ON sp.id=l.supplier_product_id WHERE l.sku=$1`, [sku]);
    supplier().stockOverride.set(lrow.supplier_sku, 0);
    await runInventory();
    expect((await one(`SELECT status FROM listings WHERE sku=$1`, [sku])).status).toBe('PAUSED');
    expect(amazon().listings.get(sku)!.quantity).toBe(0);
    supplier().stockOverride.set(lrow.supplier_sku, 300);
    await runInventory();
    expect((await one(`SELECT status FROM listings WHERE sku=$1`, [sku])).status).toBe('ACTIVE');
  });

  it('supplier price spike: no loss sales — listing paused, loss order held', async () => {
    const sku = [...amazon().listings.values()][0].sku;
    const lrow = await one(`SELECT l.*, sp.supplier_sku FROM listings l JOIN supplier_products sp ON sp.id=l.supplier_product_id WHERE l.sku=$1`, [sku]);
    supplier().costOverride.set(lrow.supplier_sku, 40); // EUR, was ~7
    amazon().injectOrder(sku, 1, Number(lrow.price));
    const r = await runOrderCycle();
    expect(r.held).toBe(1);
    const o = await one(`SELECT hold_reason FROM orders ORDER BY id DESC LIMIT 1`);
    expect(o.hold_reason).toMatch(/loss-making/);
    expect((await one(`SELECT status FROM listings WHERE sku=$1`, [sku])).status).toBe('PAUSED');
    supplier().costOverride.delete(lrow.supplier_sku);
  });

  it('repricing respects the floor', async () => {
    await db().query(`UPDATE listings SET status='ACTIVE', pause_reason=NULL WHERE status='PAUSED'`);
    await db().query(`UPDATE pricing_history SET created_at = now() - interval '1 day'`);
    await runPricing();
    const ls = await many(`SELECT price, min_price FROM listings`);
    for (const l of ls) expect(Number(l.price)).toBeGreaterThanOrEqual(Number(l.min_price));
  });

  it('account-health degradation pauses automation before marketplace thresholds', async () => {
    amazon().health = { ...amazon().health, lateShipmentPct: 3.1 };
    const h = await runHealth();
    expect(h.AMAZON_SE).toBe('AT_RISK');
    expect((await one(`SELECT automation_state FROM marketplaces WHERE code='AMAZON_SE'`)).automation_state).toBe('PAUSED_HEALTH');
    const al = await one(`SELECT * FROM alerts WHERE dedupe_key='health:AMAZON_SE'`);
    expect(al.severity).toBe('CRITICAL');
  });

  it('scheduler: locking + restart safety + report', async () => {
    const job = JOBS.find((j) => j.name === 'orders.cycle')!;
    const [a, b] = await Promise.all([runJob(job, true), runJob(job, true)]);
    expect([a, b].sort()).toEqual(['LOCKED', 'OK'].sort());
    await db().query(`INSERT INTO job_runs(job, status) VALUES ('orders.tracking','RUNNING')`); // simulated crash
    await runJob(JOBS.find((j) => j.name === 'orders.tracking')!, true);
    const orphan = await one(`SELECT count(*)::int n FROM job_runs WHERE job='orders.tracking' AND error LIKE 'orphaned%'`);
    expect(orphan.n).toBe(1);
    const rep = await buildDailyReport(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date()));
    expect(rep.text).toMatch(/AUTONOMOUS E-COMMERCE REPORT/);
    expect(rep.text).toMatch(/12\. Problems requiring your action/);
  });

  it('every mutation-worthy decision is auditable', async () => {
    const n = await one(`SELECT count(*)::int n FROM agent_actions`);
    expect(n.n).toBeGreaterThan(20);
    const agents = await many(`SELECT DISTINCT agent FROM agent_actions`);
    expect(agents.map((a) => a.agent)).toEqual(expect.arrayContaining(['research', 'evaluation', 'listing', 'orders', 'health']));
  });
});
