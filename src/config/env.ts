import { z } from 'zod';

/**
 * Environment / secrets. Secrets are ONLY read from process.env, which must be populated by the
 * host's encrypted secret store (Railway/Render env vars, AWS Secrets Manager, Doppler ...).
 * Never commit a .env file with real values. Secrets are never logged (see redact()).
 */
const schema = z.object({
  NODE_ENV: z.string().default('production'),
  APP_MODE: z.enum(['simulation', 'sandbox', 'live']).default('simulation'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1).optional(),   // missing => dashboard shows setup page
  CRON_SECRET: z.string().optional(),           // Vercel Cron sends 'Authorization: Bearer <CRON_SECRET>'
  SIM_DEMAND: z.string().optional(),            // '1' => simulation generates fake customer demand
  DASHBOARD_USER: z.string().default('owner'),
  DASHBOARD_PASSWORD: z.string().optional(),
  WEBHOOK_SHARED_SECRET: z.string().optional(),
  TZ_REPORTS: z.string().default('Europe/Stockholm'),

  // Notifications (any subset)
  NOTIFY_WEBHOOK_URL: z.string().url().optional(),     // Slack/Discord/ntfy/Telegram-bridge compatible JSON POST
  RESEND_API_KEY: z.string().optional(),
  OWNER_EMAIL: z.string().email().optional(),
  NOTIFY_FROM_EMAIL: z.string().optional(),

  // Amazon SP-API (Login with Amazon)
  AMAZON_LWA_CLIENT_ID: z.string().optional(),
  AMAZON_LWA_CLIENT_SECRET: z.string().optional(),
  AMAZON_REFRESH_TOKEN: z.string().optional(),
  AMAZON_SELLER_ID: z.string().optional(),
  AMAZON_SPAPI_ENDPOINT: z.string().default('https://sellingpartnerapi-eu.amazon.com'),

  // eBay
  EBAY_CLIENT_ID: z.string().optional(),
  EBAY_CLIENT_SECRET: z.string().optional(),
  EBAY_REFRESH_TOKEN: z.string().optional(),
  EBAY_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  EBAY_FULFILLMENT_POLICY_ID: z.string().optional(),
  EBAY_PAYMENT_POLICY_ID: z.string().optional(),
  EBAY_RETURN_POLICY_ID: z.string().optional(),
  EBAY_MERCHANT_LOCATION_KEY: z.string().optional(),
  EBAY_VERIFICATION_TOKEN: z.string().optional(),   // Marketplace Account Deletion endpoint token (32-80 chars)
  PUBLIC_BASE_URL: z.string().url().optional(),     // e.g. https://autocommerce.up.railway.app

  // Market data
  KEEPA_API_KEY: z.string().optional(),

  // Suppliers
  BIGBUY_API_KEY: z.string().optional(),
  BIGBUY_ENV: z.enum(['sandbox', 'production']).default('sandbox'),

  // Optional LLM for listing copy (grounded strictly on supplier facts)
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    // Vercel Marketplace Postgres (Neon) may expose POSTGRES_URL instead of DATABASE_URL.
    const parsed = schema.safeParse({ ...process.env, DATABASE_URL: process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined });
    if (!parsed.success) {
      throw new Error('Invalid environment: ' + parsed.error.issues.map((i) => i.path.join('.')).join(', '));
    }
    cached = parsed.data;
    if (cached.APP_MODE === 'live' && !cached.DASHBOARD_PASSWORD) {
      throw new Error('DASHBOARD_PASSWORD is required in live mode');
    }
  }
  return cached;
}

/** For tests */
export function resetEnvCache() { cached = undefined; }

const SECRET_KEYS = /(SECRET|TOKEN|PASSWORD|API_KEY|KEY)$/;
export function redact(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k.toUpperCase()) || /authorization|access_token|refresh_token/i.test(k) ? '[REDACTED]' : redact(v);
  }
  return out;
}
