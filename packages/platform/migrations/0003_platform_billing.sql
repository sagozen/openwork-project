-- Platform billing: purchases, provider events, provider customers, reconciliation and the
-- ledger links that make a grant attributable to exactly one payment.

CREATE TABLE IF NOT EXISTS payments (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  user_id text REFERENCES "user" (id) ON DELETE SET NULL,
  provider text NOT NULL,
  provider_checkout_id text,
  provider_payment_id text,
  checkout_url text,
  pack_id text NOT NULL,
  credits integer NOT NULL,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  tax_cents integer,
  total_cents integer,
  status text NOT NULL,
  refunded_cents integer NOT NULL DEFAULT 0,
  idempotency_key text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  paid_at text
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_checkout_uidx ON payments (provider, provider_checkout_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_idem_uidx ON payments (tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS payments_tenant_idx ON payments (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status, updated_at);

CREATE TABLE IF NOT EXISTS payment_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payment_id text,
  outcome text NOT NULL,
  received_at text NOT NULL,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE IF NOT EXISTS provider_customers (
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider text NOT NULL,
  customer_id text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (tenant_id, provider)
);

CREATE TABLE IF NOT EXISTS reconciliation_findings (
  id text NOT NULL PRIMARY KEY,
  run_at text NOT NULL,
  kind text NOT NULL,
  tenant_id text,
  payment_id text,
  detail_json text NOT NULL,
  resolved_at text
);

CREATE INDEX IF NOT EXISTS reconciliation_findings_run_idx ON reconciliation_findings (run_at DESC);
CREATE INDEX IF NOT EXISTS reconciliation_findings_kind_idx ON reconciliation_findings (kind, resolved_at);

ALTER TABLE ledger_entries ADD COLUMN payment_id text;
ALTER TABLE ledger_entries ADD COLUMN ref text;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_payment_grant_uidx
  ON ledger_entries (payment_id) WHERE kind = 'grant' AND payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_payment_ref_uidx
  ON ledger_entries (payment_id, kind, ref) WHERE payment_id IS NOT NULL AND ref IS NOT NULL;
