import { env } from '../config/env.js';
import { loadSettings, type Settings } from '../domain/settings.js';
import { capabilities } from '../domain/risk.js';
import { registry, type Registry } from '../integrations/registry.js';
import { many } from '../db/pool.js';

export interface Ctx {
  mode: 'simulation' | 'sandbox' | 'live';
  s: Settings;
  caps: ReturnType<typeof capabilities>;
  reg: Registry;
  marketplaces: { code: string; channel: string; currency: string; vat_rate: number; automation_state: string }[];
}

export async function ctx(): Promise<Ctx> {
  const s = await loadSettings();
  const mode = env().APP_MODE;
  const marketplaces = await many(`SELECT code, channel, currency, vat_rate, automation_state FROM marketplaces WHERE enabled ORDER BY code`);
  return { mode, s, caps: capabilities(mode, s), reg: registry(), marketplaces };
}

/** Category-based return-rate prior when market data has none (conservative). */
export function estimateReturnRate(category?: string | null): number {
  const c = (category ?? '').toLowerCase();
  if (/cloth|apparel|fashion|shoe|kläd|mode|schuh/.test(c)) return 0.15;
  if (/electronic|elektronik/.test(c)) return 0.08;
  if (/furniture|möbel|möbler/.test(c)) return 0.07;
  if (/home|kitchen|garden|office|kök|hem|trädgård|küche|garten|sport/.test(c)) return 0.04;
  return 0.06;
}

/** Supplier reliability: prior from capabilities, blended with observed performance after 20 orders. */
export function supplierReliability(s: {
  has_api: boolean; eu_warehouse: boolean; auto_ordering: boolean; blind_dropship: boolean; company_verified: boolean; agreement_signed: boolean;
  on_time_rate: number | null; defect_rate: number | null; order_count?: number;
}): number {
  const prior = 60 + (s.has_api ? 8 : 0) + (s.eu_warehouse ? 8 : 0) + (s.auto_ordering ? 6 : 0) + (s.blind_dropship ? 4 : 0) + (s.company_verified ? 4 : 0) + (s.agreement_signed ? 4 : 0);
  const n = s.order_count ?? 0;
  if (n < 20 || s.on_time_rate == null || s.defect_rate == null) return prior;
  const observed = 100 * (0.6 * s.on_time_rate + 0.4 * (1 - s.defect_rate));
  const w = Math.min(1, n / 100);
  return Math.round((prior * (1 - w) + observed * w) * 100) / 100;
}
