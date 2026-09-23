-- Growth layer: lifecycle (test → winner → scale / kill), fulfilment model, supplier quotes,
-- winner analyses, advertising, cash-flow events, review insights.

ALTER TABLE listings ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'TEST'
  CHECK (stage IN ('TEST','WINNER','SCALING','KILLED'));
ALTER TABLE listings ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE listings ADD COLUMN IF NOT EXISTS fulfilment_model text NOT NULL DEFAULT 'DROPSHIP'
  CHECK (fulfilment_model IN ('DROPSHIP','WHOLESALE','FBA','3PL','PRIVATE_LABEL'));

-- Alternative supplier offers (from APIs or entered/uploaded by owner). Only verified quotes drive decisions.
CREATE TABLE IF NOT EXISTS supplier_quotes (
  id               bigserial PRIMARY KEY,
  product_id       bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_name    text NOT NULL,
  supplier_type    text NOT NULL CHECK (supplier_type IN ('WHOLESALER','MANUFACTURER','DROPSHIPPER')),
  unit_price       numeric(12,2) NOT NULL,
  currency         text NOT NULL,
  moq              integer NOT NULL DEFAULT 1,
  freight_per_unit numeric(12,2),
  lead_time_days   integer,
  payment_terms    text,
  warehouse_country text,
  capabilities     jsonb NOT NULL DEFAULT '{}',   -- private_label, custom_packaging, exclusivity, certifications, api, capacity_per_month
  source           text NOT NULL,                  -- api:<code> | owner_entered | owner_upload
  verified         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_quotes_pid ON supplier_quotes(product_id);

CREATE TABLE IF NOT EXISTS winner_analyses (
  id          bigserial PRIMARY KEY,
  listing_id  bigint NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  analysis    jsonb NOT NULL,     -- 15 questions: status, evidence, impact, basis
  negotiation jsonb,              -- negotiation brief (draft, never sent automatically)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS winner_analyses_lid ON winner_analyses(listing_id, created_at DESC);

-- Negative-review themes. Source must be licensed/permitted (no scraping of marketplace reviews).
CREATE TABLE IF NOT EXISTS review_insights (
  id          bigserial PRIMARY KEY,
  product_id  bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  theme       text NOT NULL,
  mentions    integer NOT NULL,
  examples    jsonb,
  source      text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, theme, source)
);

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id               bigserial PRIMARY KEY,
  listing_id       bigint NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  marketplace_code text NOT NULL,
  external_id      text,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','ENDED')),
  daily_budget_sek numeric(12,2) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, marketplace_code)
);

CREATE TABLE IF NOT EXISTS ad_metrics_daily (
  campaign_id  bigint NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  day          date NOT NULL,
  impressions  integer NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  spend_sek    numeric(12,2) NOT NULL DEFAULT 0,
  ad_sales_sek numeric(12,2) NOT NULL DEFAULT 0,
  ad_orders    integer NOT NULL DEFAULT 0,
  source       text NOT NULL,
  PRIMARY KEY (campaign_id, day)
);

-- Known/expected cash movements (payouts, supplier bills, VAT, inventory POs, ads). + = in, − = out.
CREATE TABLE IF NOT EXISTS cash_events (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  amount_sek  numeric(14,2) NOT NULL,
  due_date    date NOT NULL,
  status      text NOT NULL DEFAULT 'EXPECTED' CHECK (status IN ('EXPECTED','CONFIRMED','CANCELLED')),
  source_ref  text UNIQUE,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
