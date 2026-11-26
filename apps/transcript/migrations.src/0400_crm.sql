-- Mini CRM: where each customer (tenant) is on the way from signup to paid.
-- Stage events are derived from existing records by an idempotent reconciler (users, jobs,
-- api_keys, payments), so no request path has to know about the CRM and a CRM write can never
-- fail a customer action. Only ids, step names and minimal detail are stored: no document
-- content, no card or bank data. (tenant_id, step, source_id) keeps every insert idempotent.
CREATE TABLE IF NOT EXISTS crm_events (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id text,
  step text NOT NULL,
  source_id text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '{}',
  occurred_at text NOT NULL,
  UNIQUE (tenant_id, step, source_id)
);

CREATE INDEX IF NOT EXISTS crm_events_tenant_idx ON crm_events (tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS crm_events_step_idx ON crm_events (step, occurred_at);

-- One row per operator email already claimed (checkout, purchase, 6-hour usage report). Claiming
-- the key before sending is what stops a webhook replay or a repeated cron tick from mailing twice.
CREATE TABLE IF NOT EXISTS crm_notices (
  key text NOT NULL PRIMARY KEY,
  sent_at text NOT NULL
);
