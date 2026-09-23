-- AutoCommerce core schema. All money in SEK unless column says otherwise.
-- Every automated decision is written to agent_actions (+ audit_logs for mutations).

CREATE TABLE IF NOT EXISTS system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS marketplaces (
  id               serial PRIMARY KEY,
  code             text UNIQUE NOT NULL,          -- AMAZON_SE, AMAZON_DE, EBAY_DE, EBAY_SE ...
  channel          text NOT NULL CHECK (channel IN ('AMAZON','EBAY')),
  external_id      text NOT NULL,                 -- Amazon marketplaceId / eBay MarketplaceIdEnum
  currency         text NOT NULL,
  vat_rate         numeric(5,4) NOT NULL,         -- destination VAT used for estimates
  enabled          boolean NOT NULL DEFAULT false,
  automation_state text NOT NULL DEFAULT 'ACTIVE' CHECK (automation_state IN ('ACTIVE','PAUSED_HEALTH','PAUSED_OWNER')),
  health_status    text NOT NULL DEFAULT 'UNKNOWN',
  health_snapshot  jsonb,
  health_checked_at timestamptz
);

CREATE TABLE IF NOT EXISTS products (
  id              bigserial PRIMARY KEY,
  title           text NOT NULL,
  brand           text,
  ean             text,
  asin            text,
  category        text,
  status          text NOT NULL DEFAULT 'RESEARCHING'
                  CHECK (status IN ('RESEARCHING','REQUIRES_VERIFICATION','REJECTED','APPROVED_FOR_LISTING','ACTIVE','PAUSED','BLOCKED')),
  status_reason   text,
  attributes      jsonb NOT NULL DEFAULT '{}',   -- only facts sourced from supplier/catalog; never invented
  source          text NOT NULL,                  -- keepa | spapi | ebay_browse | supplier_catalog | mock
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS products_ean_uq ON products(ean) WHERE ean IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_status_idx ON products(status);

CREATE TABLE IF NOT EXISTS product_research (
  id                  bigserial PRIMARY KEY,
  product_id          bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  marketplace_code    text NOT NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  sales_rank          integer,
  sales_rank_drops_30d integer,          -- Keepa proxy for sales velocity
  est_monthly_sales   integer,
  avg_price_sek_90d   numeric(12,2),
  price_stddev_pct    numeric(6,2),
  offer_count         integer,
  amazon_is_seller    boolean,
  rating              numeric(3,2),
  review_count        integer,
  review_growth_30d   integer,
  negative_themes     jsonb,
  trend_index         numeric(6,2),       -- -100..100, trend slope
  seasonality         text,
  ad_intensity        text,               -- LOW | MEDIUM | HIGH | UNKNOWN
  raw                 jsonb
);
CREATE INDEX IF NOT EXISTS product_research_pid ON product_research(product_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS suppliers (
  id                  serial PRIMARY KEY,
  code                text UNIQUE NOT NULL,     -- BIGBUY, VIDAXL, CJ_EU, MOCK_EU ...
  name                text NOT NULL,
  country             text,
  eu_warehouse        boolean NOT NULL DEFAULT false,
  has_api             boolean NOT NULL DEFAULT false,
  auto_ordering       boolean NOT NULL DEFAULT false,
  blind_dropship      boolean NOT NULL DEFAULT false, -- neutral packaging, no supplier branding/invoice to customer
  is_wholesaler       boolean NOT NULL DEFAULT false, -- false => retailer => blocked (eBay/Amazon policy)
  agreement_signed    boolean NOT NULL DEFAULT false, -- dropshipping agreement in place (owner-verified)
  company_verified    boolean NOT NULL DEFAULT false,
  returns_policy      text,
  reliability_score   numeric(5,2) NOT NULL DEFAULT 0,
  avg_delivery_days   numeric(5,2),
  on_time_rate        numeric(5,4),
  defect_rate         numeric(5,4),
  status              text NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN ('UNVERIFIED','VERIFIED','SUSPENDED','BLOCKED')),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_products (
  id                  bigserial PRIMARY KEY,
  supplier_id         int NOT NULL REFERENCES suppliers(id),
  product_id          bigint REFERENCES products(id) ON DELETE SET NULL,
  supplier_sku        text NOT NULL,
  ean                 text,
  title               text,
  cost_price          numeric(12,2) NOT NULL,
  cost_currency       text NOT NULL,
  cost_includes_vat   boolean NOT NULL DEFAULT false,
  shipping_cost       numeric(12,2),
  shipping_currency   text,
  moq                 integer NOT NULL DEFAULT 1,
  stock               integer NOT NULL DEFAULT 0,
  delivery_days_min   integer,
  delivery_days_max   integer,
  ships_from          text,
  tracking_available  boolean,
  ce_marking          text,       -- 'YES' | 'NO' | 'NOT_REQUIRED' | NULL(unknown)
  gpsr_manufacturer   jsonb,      -- {name, address, email} as provided by supplier
  gpsr_eu_responsible jsonb,
  safety_docs         jsonb,      -- links/ids of docs supplied
  images              jsonb,      -- only images supplier licenses for resale
  image_rights        boolean NOT NULL DEFAULT false,
  description         text,
  specs               jsonb,
  last_synced_at      timestamptz,
  active              boolean NOT NULL DEFAULT true,
  UNIQUE (supplier_id, supplier_sku)
);
CREATE INDEX IF NOT EXISTS supplier_products_pid ON supplier_products(product_id);

CREATE TABLE IF NOT EXISTS compliance_checks (
  id            bigserial PRIMARY KEY,
  product_id    bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_product_id bigint REFERENCES supplier_products(id),
  result        text NOT NULL CHECK (result IN ('PASS','BLOCK','REQUIRES_VERIFICATION')),
  risk_level    text NOT NULL,
  findings      jsonb NOT NULL,
  checked_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profit_calculations (
  id                 bigserial PRIMARY KEY,
  product_id         bigint REFERENCES products(id) ON DELETE CASCADE,
  order_id           bigint,
  supplier_product_id bigint REFERENCES supplier_products(id),
  marketplace_code   text NOT NULL,
  sale_price_gross   numeric(12,2) NOT NULL,
  breakdown          jsonb NOT NULL,
  net_profit         numeric(12,2) NOT NULL,
  net_margin_pct     numeric(7,2) NOT NULL,
  roi_pct            numeric(8,2) NOT NULL,
  break_even_price   numeric(12,2) NOT NULL,
  break_even_ad_spend numeric(12,2) NOT NULL,
  max_supplier_cost  numeric(12,2) NOT NULL,
  min_allowed_price  numeric(12,2) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_scores (
  id                bigserial PRIMARY KEY,
  product_id        bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  marketplace_code  text NOT NULL,
  supplier_product_id bigint REFERENCES supplier_products(id),
  score             numeric(5,2) NOT NULL,
  components        jsonb NOT NULL,
  reasons           jsonb NOT NULL,
  decision          text NOT NULL CHECK (decision IN ('APPROVED_FOR_LISTING','REJECTED','REQUIRES_VERIFICATION')),
  decision_reasons  jsonb NOT NULL,
  profit_calc_id    bigint REFERENCES profit_calculations(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_scores_pid ON product_scores(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS listings (
  id                 bigserial PRIMARY KEY,
  product_id         bigint NOT NULL REFERENCES products(id),
  supplier_product_id bigint NOT NULL REFERENCES supplier_products(id),
  marketplace_code   text NOT NULL REFERENCES marketplaces(code),
  sku                text NOT NULL,
  external_id        text,               -- ASIN / eBay listingId
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_PUBLISH','ACTIVE','PAUSED','ENDED','ERROR')),
  pause_reason       text,
  price              numeric(12,2),
  min_price          numeric(12,2),
  max_price          numeric(12,2),
  quantity           integer NOT NULL DEFAULT 0,
  content            jsonb,              -- title, bullets, description, attributes, legal info
  last_published_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace_code, sku)
);

CREATE TABLE IF NOT EXISTS competitor_data (
  id               bigserial PRIMARY KEY,
  product_id       bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  marketplace_code text NOT NULL,
  captured_at      timestamptz NOT NULL DEFAULT now(),
  lowest_price     numeric(12,2),
  buybox_price     numeric(12,2),
  offer_count      integer,
  amazon_on_listing boolean,
  raw              jsonb
);
CREATE INDEX IF NOT EXISTS competitor_data_pid ON competitor_data(product_id, marketplace_code, captured_at DESC);

CREATE TABLE IF NOT EXISTS pricing_history (
  id          bigserial PRIMARY KEY,
  listing_id  bigint NOT NULL REFERENCES listings(id),
  old_price   numeric(12,2),
  new_price   numeric(12,2) NOT NULL,
  floor_price numeric(12,2) NOT NULL,
  reason      text NOT NULL,
  applied     boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_history (
  id                  bigserial PRIMARY KEY,
  supplier_product_id bigint NOT NULL REFERENCES supplier_products(id),
  stock               integer NOT NULL,
  cost_price          numeric(12,2),
  captured_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id              bigserial PRIMARY KEY,
  marketplace_code text NOT NULL,
  external_buyer_ref text NOT NULL,      -- marketplace-provided pseudonymous id
  country         text,
  order_count     integer NOT NULL DEFAULT 0,
  flagged         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace_code, external_buyer_ref)
);
-- Shipping addresses are NOT stored long-term: fetched just-in-time for supplier order, then only country kept (GDPR data minimisation).

CREATE TABLE IF NOT EXISTS orders (
  id                 bigserial PRIMARY KEY,
  marketplace_code   text NOT NULL REFERENCES marketplaces(code),
  external_order_id  text NOT NULL,
  customer_id        bigint REFERENCES customers(id),
  status             text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN (
                       'RECEIVED','AWAITING_PAYMENT','VALIDATING','ON_HOLD','AWAITING_APPROVAL',
                       'PLACING_SUPPLIER_ORDER','SUPPLIER_ORDERED','SHIPPED','TRACKING_UPLOADED',
                       'DELIVERED','CANCELLED','REFUNDED','ERROR')),
  hold_reason        text,
  payment_status     text,
  order_total        numeric(12,2) NOT NULL,
  currency           text NOT NULL,
  order_total_sek    numeric(12,2) NOT NULL,
  ship_by            timestamptz,
  deliver_by         timestamptz,
  ship_country       text,
  fraud_score        integer,
  raw                jsonb,
  placed_at          timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace_code, external_order_id)
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id            bigserial PRIMARY KEY,
  order_id      bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  listing_id    bigint REFERENCES listings(id),
  sku           text NOT NULL,
  external_item_id text,
  quantity      integer NOT NULL,
  unit_price    numeric(12,2) NOT NULL,
  unit_price_sek numeric(12,2) NOT NULL
);

-- One supplier order per marketplace order. UNIQUE(order_id) is the hard idempotency guard against double purchasing.
CREATE TABLE IF NOT EXISTS supplier_orders (
  id                bigserial PRIMARY KEY,
  order_id          bigint NOT NULL UNIQUE REFERENCES orders(id),
  supplier_id       int NOT NULL REFERENCES suppliers(id),
  idempotency_key   text NOT NULL UNIQUE,
  external_ref      text,
  status            text NOT NULL CHECK (status IN ('PLACING','PLACED','FAILED','UNKNOWN_NEEDS_RECONCILE','CANCELLED')),
  cost_total_sek    numeric(12,2) NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shipments (
  id              bigserial PRIMARY KEY,
  order_id        bigint NOT NULL UNIQUE REFERENCES orders(id),
  carrier         text,
  tracking_number text,
  tracking_url    text,
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  uploaded_to_marketplace_at timestamptz,
  last_event      text,
  last_checked_at timestamptz
);

CREATE TABLE IF NOT EXISTS returns (
  id               bigserial PRIMARY KEY,
  order_id         bigint NOT NULL REFERENCES orders(id),
  external_return_id text,
  reason           text,
  status           text NOT NULL DEFAULT 'REQUESTED',
  refund_amount_sek numeric(12,2),
  requires_owner   boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, external_return_id)
);

CREATE TABLE IF NOT EXISTS fees (
  id               bigserial PRIMARY KEY,
  marketplace_code text NOT NULL,
  category         text NOT NULL DEFAULT '*',
  referral_pct     numeric(6,4) NOT NULL,
  referral_min     numeric(10,2) NOT NULL DEFAULT 0,
  fixed_fee        numeric(10,2) NOT NULL DEFAULT 0,
  payment_pct      numeric(6,4) NOT NULL DEFAULT 0,
  source           text NOT NULL,       -- where the value came from + verification status
  verified         boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace_code, category)
);

CREATE TABLE IF NOT EXISTS transactions (
  id             bigserial PRIMARY KEY,
  order_id       bigint REFERENCES orders(id),
  kind           text NOT NULL,   -- SALE | SUPPLIER_COST | MARKETPLACE_FEE | AD_SPEND | REFUND | SHIPPING | VAT_ESTIMATE | OTHER
  amount_sek     numeric(12,2) NOT NULL,
  amount_orig    numeric(12,2),
  currency       text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  source_ref     text,
  UNIQUE (kind, source_ref)
);

CREATE TABLE IF NOT EXISTS exchange_rates (
  currency   text NOT NULL,
  rate_date  date NOT NULL,
  sek_per_unit numeric(14,6) NOT NULL,
  source     text NOT NULL,
  PRIMARY KEY (currency, rate_date)
);

CREATE TABLE IF NOT EXISTS alerts (
  id           bigserial PRIMARY KEY,
  severity     text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  category     text NOT NULL,
  title        text NOT NULL,
  detail       jsonb,
  dedupe_key   text,
  requires_owner boolean NOT NULL DEFAULT false,
  notified_at  timestamptz,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_dedupe ON alerts(dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS approval_requests (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,       -- ORDER_OVER_LIMIT | REFUND | NEW_SUPPLIER | PRICE_OUT_OF_BAND | GO_LIVE ...
  subject_ref text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, subject_ref)
);

CREATE TABLE IF NOT EXISTS agent_actions (
  id          bigserial PRIMARY KEY,
  agent       text NOT NULL,
  action      text NOT NULL,
  subject_type text,
  subject_id  text,
  decision    text,
  reasons     jsonb,
  data        jsonb,
  dry_run     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_actions_subject ON agent_actions(subject_type, subject_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         bigserial PRIMARY KEY,
  actor      text NOT NULL,          -- agent name or 'owner'
  entity     text NOT NULL,
  entity_id  text,
  change     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_runs (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','OK','FAILED','SKIPPED')),
  summary     jsonb,
  error       text
);
CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job, started_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,       -- DAILY | WEEKLY
  period_key  text NOT NULL,       -- 2026-09-23 | 2026-W39
  body        jsonb NOT NULL,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, period_key)
);

CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
