import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, closeDb } from './pool.js';
import { seedSettings } from '../domain/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
// migrations live in src/db/migrations (copied next to dist by the build script)
const MIGRATIONS_DIR = [join(here, 'migrations'), join(here, '../../../src/db/migrations')].find((p) => {
  try { readdirSync(p); return true; } catch { return false; }
})!;

/** Marketplace IDs per SP-API "Marketplace IDs" docs / eBay MarketplaceIdEnum. VAT = destination standard rate. */
const MARKETPLACES = [
  ['AMAZON_SE', 'AMAZON', 'A2NODRKZP88ZB9', 'SEK', 0.25],
  ['AMAZON_DE', 'AMAZON', 'A1PA6795UKMFR9', 'EUR', 0.19],
  ['AMAZON_FR', 'AMAZON', 'A13V1IB3VIYZZH', 'EUR', 0.20],
  ['AMAZON_IT', 'AMAZON', 'APJ6JRA9NG5V4', 'EUR', 0.22],
  ['AMAZON_ES', 'AMAZON', 'A1RKKUPIHCS9HS', 'EUR', 0.21],
  ['AMAZON_NL', 'AMAZON', 'A1805IZSGTT6HS', 'EUR', 0.21],
  ['AMAZON_UK', 'AMAZON', 'A1F83G8C2ARO7P', 'GBP', 0.20],
  ['EBAY_DE', 'EBAY', 'EBAY_DE', 'EUR', 0.19],
  ['EBAY_SE', 'EBAY', 'EBAY_SE', 'SEK', 0.25],
  ['EBAY_GB', 'EBAY', 'EBAY_GB', 'GBP', 0.20],
] as const;

/** Conservative fee defaults. verified=false until the Fees agent confirms via SP-API getMyFeesEstimate / eBay invoice data. */
const FEES = [
  ['AMAZON_SE', '*', 0.15, 0, 0, 'sell.amazon.se/en/priser (Sep 2026): most categories 15%; some 8%. Conservative default.'],
  ['AMAZON_DE', '*', 0.15, 0, 0, 'Conservative default; confirm via Product Fees API'],
  ['EBAY_DE', '*', 0.12, 4, 0, 'UNVERIFIED conservative estimate for business sellers incl. per-order fee'],
  ['EBAY_SE', '*', 0.12, 4, 0, 'UNVERIFIED conservative estimate'],
] as const;

export async function migrate() {
  const pool = db();
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
    if (done.rowCount) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      console.log('[migrate] applied', f);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally { c.release(); }
  }
  await seedSettings();
  for (const [code, channel, ext, cur, vat] of MARKETPLACES) {
    await pool.query(
      `INSERT INTO marketplaces(code, channel, external_id, currency, vat_rate, enabled) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO NOTHING`,
      [code, channel, ext, cur, vat, code === 'AMAZON_SE' || code === 'EBAY_DE'],
    );
  }
  for (const [mp, cat, pct, fixed, pay, src] of FEES) {
    await pool.query(
      `INSERT INTO fees(marketplace_code, category, referral_pct, fixed_fee, payment_pct, source) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (marketplace_code, category) DO NOTHING`,
      [mp, cat, pct, fixed, pay, src],
    );
  }
  await pool.query(
    `INSERT INTO exchange_rates(currency, rate_date, sek_per_unit, source) VALUES ('SEK', '2000-01-01', 1, 'identity') ON CONFLICT DO NOTHING`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => closeDb()).then(() => console.log('[migrate] done')).catch((e) => { console.error(e); process.exit(1); });
}
