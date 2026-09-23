/**
 * Dry-run the whole autonomous loop against mocks — no real money, no real customers.
 *   DATABASE_URL=postgres://... npm run simulate   (the database is WIPED)
 */
process.env.APP_MODE = 'simulation';
const { db, closeDb, many } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { updateSetting } = await import('../src/domain/settings.js');
const { registry } = await import('../src/integrations/registry.js');
const { tick } = await import('../src/scheduler.js');
const { runOrderCycle, syncTracking } = await import('../src/agents/orders.js');
const { runInventory } = await import('../src/agents/inventory.js');
const { buildDailyReport } = await import('../src/agents/reports.js');
type MockMarketplace = import('../src/integrations/mock/index.js').MockMarketplace;

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') && !process.argv.includes('--force')) {
  console.error('Refusing to wipe a non-local database. Pass --force if you really mean it.'); process.exit(1);
}
await db().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate();
await updateSetting('CURRENT_CASH_SEK', 50000, 'simulation');

console.log('\n== Cycle 1: all scheduled jobs (research → sourcing → evaluation → listing …)');
await tick();
const mps = [...registry().marketplaces.values()] as MockMarketplace[];
for (let hour = 0; hour < 6; hour++) {
  for (const m of mps) m.simulateDemand(2);
  const r = await runOrderCycle();
  const t = await syncTracking();
  console.log(`hour ${hour}: orders ${JSON.stringify(r)} tracking ${JSON.stringify(t)}`);
}
// Scenario: supplier stock-out on one SKU
const sup: any = registry().suppliers.get('MOCK_EU_WHOLESALE');
sup.stockOverride.set('NHG-GKP', 0);
console.log('inventory after stock-out:', await runInventory());

const decisions = await many(`SELECT data->>'explanation' e FROM agent_actions WHERE action='PRODUCT_DECISION' ORDER BY id LIMIT 4`);
console.log('\n== Sample decision explanations\n' + decisions.map((d) => d.e).join('\n\n'));
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
console.log('\n' + (await buildDailyReport(today)).text);
await closeDb();
