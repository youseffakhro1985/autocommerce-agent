/**
 * FX to SEK using ECB euro reference rates (free, official, daily ~16:00 CET). VERIFIED source:
 * https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
 */
import { one, db } from '../db/pool.js';
import { env } from '../config/env.js';
import { http } from '../integrations/http.js';
import { MOCK_FX } from '../integrations/mock/index.js';

export async function refreshEcbRates(): Promise<number> {
  const xml = await http<string>('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', { raw: true });
  const date = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
  const rates: Record<string, number> = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) rates[m[1]] = Number(m[2]);
  if (!date || !rates.SEK) throw new Error('ECB response missing SEK');
  let n = 0;
  for (const [cur, perEur] of Object.entries(rates)) {
    const sekPer = rates.SEK / perEur;
    await db().query(
      `INSERT INTO exchange_rates(currency, rate_date, sek_per_unit, source) VALUES ($1,$2,$3,'ECB') ON CONFLICT (currency, rate_date) DO UPDATE SET sek_per_unit=EXCLUDED.sek_per_unit`,
      [cur, date, Math.round(sekPer * 1e6) / 1e6],
    );
    n++;
  }
  return n;
}

/** SEK per 1 unit of `currency`. Throws if no rate — never guess an exchange rate in live mode. */
export async function sekPer(currency: string): Promise<number> {
  if (currency === 'SEK') return 1;
  if (env().APP_MODE === 'simulation') return MOCK_FX[currency] ?? (() => { throw new Error('No mock FX ' + currency); })();
  const r = await one<{ sek_per_unit: number; rate_date: string }>(
    `SELECT sek_per_unit, rate_date FROM exchange_rates WHERE currency=$1 AND rate_date > now() - interval '7 days' ORDER BY rate_date DESC LIMIT 1`, [currency]);
  if (!r) throw new Error(`No fresh FX rate for ${currency} (ECB refresh job failing?)`);
  return r.sek_per_unit;
}

export async function toSek(amount: number, currency: string) { return Math.round(amount * (await sekPer(currency)) * 100) / 100; }
export async function fromSek(amountSek: number, currency: string) { return Math.round((amountSek / (await sekPer(currency))) * 100) / 100; }
