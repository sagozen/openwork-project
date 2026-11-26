-- Opt-in platform module: WarriorPlus purchases. An app enables it with
-- "modules": ["workspaces","warriorplus"] in its migrations.manifest.json.
--
-- Expand-only: during a canary the old and new Worker versions share this database, so this
-- file only adds tables, nullable columns, defaults and indexes. Never drop or tighten here.

CREATE TABLE IF NOT EXISTS wp_ipn_events (
  ipn_id TEXT NOT NULL,
  app TEXT NOT NULL,
  action TEXT NOT NULL,
  sale TEXT,
  item_number TEXT,
  subscr_id TEXT,
  payment_num TEXT,
  -- JSON payload with WP_SECURITYKEY removed. Buyer PII stays only inside this column.
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processed','ignored','failed','needs_review')),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (app, ipn_id)
);
CREATE INDEX IF NOT EXISTS wp_ipn_events_status_idx ON wp_ipn_events (app, status, received_at);
CREATE INDEX IF NOT EXISTS wp_ipn_events_sale_idx ON wp_ipn_events (app, sale);

CREATE TABLE IF NOT EXISTS wp_purchases (
  id TEXT NOT NULL PRIMARY KEY,
  app TEXT NOT NULL,
  sale TEXT NOT NULL,
  item_number TEXT NOT NULL,
  product_code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('one_time','recurring','comp')),
  buyer_email TEXT NOT NULL,
  -- NULL until the buyer's verified email exists and the purchase is claimed.
  tenant_id TEXT,
  workspace_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','refunded','disputed','cancelled','suspended','ended','revoked','needs_review')),
  subscr_id TEXT,
  last_payment_num INTEGER,
  last_granted_payment_num INTEGER,
  current_period_end TEXT,
  expires_at TEXT,
  amount_cents INTEGER,
  source TEXT NOT NULL CHECK (source IN ('ipn','reconcile','comp')),
  verified_at TEXT,
  review_reason TEXT,
  comp_reason TEXT,
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS wp_purchases_sale_item_uidx ON wp_purchases (app, sale, item_number);
CREATE INDEX IF NOT EXISTS wp_purchases_email_idx ON wp_purchases (app, buyer_email);
CREATE INDEX IF NOT EXISTS wp_purchases_tenant_idx ON wp_purchases (app, tenant_id);
CREATE INDEX IF NOT EXISTS wp_purchases_unverified_idx ON wp_purchases (app, verified_at, status);

CREATE TABLE IF NOT EXISTS wp_subscription_payments (
  app TEXT NOT NULL,
  sale TEXT NOT NULL,
  payment_num INTEGER NOT NULL,
  action TEXT NOT NULL,
  ipn_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app, sale, payment_num, action)
);

-- Send Test requests, written only while an admin test window is open. Nothing reads this table.
CREATE TABLE IF NOT EXISTS wp_ipn_test_events (
  id TEXT NOT NULL PRIMARY KEY,
  app TEXT NOT NULL,
  action TEXT,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wp_ipn_test_events_age_idx ON wp_ipn_test_events (app, received_at);

CREATE TABLE IF NOT EXISTS wp_test_window (
  app TEXT NOT NULL PRIMARY KEY,
  opened_by TEXT NOT NULL,
  until TEXT NOT NULL,
  opened_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wp_entitlement_state (
  app TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app, tenant_id)
);

-- Sign-in link resends are limited per purchase and per day. Only ids and timestamps are kept.
CREATE TABLE IF NOT EXISTS wp_resend_log (
  id TEXT NOT NULL PRIMARY KEY,
  app TEXT NOT NULL,
  sale TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wp_resend_log_sale_idx ON wp_resend_log (app, sale, sent_at);
