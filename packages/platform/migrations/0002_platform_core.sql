-- Platform core: accounts, tenants, API keys, wallet, quota bookkeeping, webhooks,
-- audit and the email outbox. Nothing in this file depends on a product table.
--
-- New apps compose this baseline through `packages/platform/scripts/compose-migrations.mjs`.
-- templatedesign predates the split and keeps its own frozen history (see
-- apps/web/migrations.manifest.json); new statements here reach new apps only.

CREATE TABLE IF NOT EXISTS tenants (
  id text NOT NULL PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id text NOT NULL PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner',
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS memberships_tenant_idx ON memberships (tenant_id);

CREATE TABLE IF NOT EXISTS profiles (
  user_id text NOT NULL PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '',
  ui_language text NOT NULL DEFAULT 'en',
  doc_language text NOT NULL DEFAULT 'en',
  default_retention_seconds integer NOT NULL DEFAULT 3600,
  number_locale text NOT NULL DEFAULT 'en-US',
  date_locale text NOT NULL DEFAULT 'en-GB',
  low_balance_email integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS profiles_tenant_idx ON profiles (tenant_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  hash text NOT NULL UNIQUE,
  scopes text NOT NULL DEFAULT '[]',
  spend_cap_daily integer,
  created_at text NOT NULL,
  last_used_at text,
  revoked_at text
);

CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (hash);

CREATE TABLE IF NOT EXISTS wallets (
  tenant_id text NOT NULL PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  free_balance integer NOT NULL DEFAULT 0,
  purchased_balance integer NOT NULL DEFAULT 0,
  reserved_credits integer NOT NULL DEFAULT 0,
  free_reset_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  job_id text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket text NOT NULL,
  window_start integer NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS guest_usage (
  guest_id text NOT NULL,
  day text NOT NULL,
  credits_used integer NOT NULL DEFAULT 0,
  updated_at text NOT NULL,
  PRIMARY KEY (guest_id, day)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id text REFERENCES "user" (id) ON DELETE SET NULL,
  kind text NOT NULL,
  credits integer NOT NULL,
  source text NOT NULL,
  job_id text,
  created_at text NOT NULL,
  anonymized_at text
);

CREATE INDEX IF NOT EXISTS ledger_tenant_idx ON ledger_entries (tenant_id);

CREATE TABLE IF NOT EXISTS export_jobs (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  artifact_key text,
  error_code text,
  created_at text NOT NULL,
  started_at text,
  completed_at text,
  expires_at text
);

CREATE INDEX IF NOT EXISTS export_jobs_tenant_idx ON export_jobs (tenant_id);
CREATE INDEX IF NOT EXISTS export_jobs_status_idx ON export_jobs (status);

CREATE TABLE IF NOT EXISTS deletion_requests (
  id text NOT NULL PRIMARY KEY,
  user_id text NOT NULL,
  tenant_id text NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  credits_forfeited integer NOT NULL DEFAULT 0,
  requested_at text NOT NULL,
  hard_delete_at text NOT NULL,
  completed_at text,
  last_error text
);

CREATE INDEX IF NOT EXISTS deletion_requests_due_idx ON deletion_requests (status, hard_delete_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id text NOT NULL PRIMARY KEY,
  tenant_id text,
  actor_user_id text,
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_idx ON audit_log (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS email_outbox (
  id text NOT NULL PRIMARY KEY,
  user_id text,
  to_email text NOT NULL,
  locale text NOT NULL DEFAULT 'en',
  template text NOT NULL,
  payload_json text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  provider text,
  provider_message_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at text NOT NULL,
  sent_at text
);

CREATE INDEX IF NOT EXISTS email_outbox_status_idx ON email_outbox (status, created_at);

ALTER TABLE tenants ADD COLUMN suspended_at text;
ALTER TABLE tenants ADD COLUMN suspension_reason text;

CREATE TABLE IF NOT EXISTS admin_roles (
  user_id text NOT NULL PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'support')),
  created_by text,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id text NOT NULL PRIMARY KEY,
  actor_user_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  reason text,
  metadata_json text,
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_actor_idx ON admin_audit (actor_user_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS admin_audit_no_update
BEFORE UPDATE ON admin_audit
BEGIN
  SELECT RAISE(ABORT, 'admin_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete
BEFORE DELETE ON admin_audit
BEGIN
  SELECT RAISE(ABORT, 'admin_audit is append-only');
END;

CREATE TABLE IF NOT EXISTS admin_settings (
  key text NOT NULL PRIMARY KEY,
  value_json text NOT NULL,
  updated_by text,
  updated_at text NOT NULL
);

INSERT OR IGNORE INTO admin_settings (key, value_json, updated_by, updated_at) VALUES
  ('free_monthly_credits', '50', NULL, '2026-10-23T00:00:00.000Z'),
  ('guest_daily_credits', '3', NULL, '2026-10-23T00:00:00.000Z'),
  ('test_daily_cap', '50', NULL, '2026-10-23T00:00:00.000Z'),
  ('pause.admission', 'false', NULL, '2026-10-23T00:00:00.000Z'),
  ('pause.preview', 'false', NULL, '2026-10-23T00:00:00.000Z'),
  ('pause.checkout', 'true', NULL, '2026-10-23T00:00:00.000Z'),
  ('pause.webhooks', 'false', NULL, '2026-10-23T00:00:00.000Z'),
  ('ads.enabled', 'true', NULL, '2026-10-23T00:00:00.000Z'),
  ('incident.active', 'false', NULL, '2026-10-23T00:00:00.000Z'),
  ('incident.banner_en', '""', NULL, '2026-10-23T00:00:00.000Z'),
  ('incident.banner_vi', '""', NULL, '2026-10-23T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS admin_overrides (
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key text NOT NULL,
  value_json text NOT NULL,
  expires_at text,
  created_by text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

-- Moderation rows are keyed by product ids (`share_id`, `output_id`) but carry no foreign
-- keys, so every product can keep the table even when it has no share links.
CREATE TABLE IF NOT EXISTS abuse_reports (
  id text NOT NULL PRIMARY KEY,
  share_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  output_id text NOT NULL,
  reason text NOT NULL,
  detail text,
  reporter_hash text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at text NOT NULL,
  reviewed_by text,
  reviewed_at text,
  action text,
  resolution_note text
);

CREATE INDEX IF NOT EXISTS abuse_reports_status_idx ON abuse_reports (status, created_at);
CREATE INDEX IF NOT EXISTS abuse_reports_tenant_idx ON abuse_reports (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  url text NOT NULL,
  secret_hash text NOT NULL,
  secret text,
  events text NOT NULL DEFAULT '["job.succeeded","job.failed"]',
  verified_at text,
  verification_challenge text,
  failure_count integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at text,
  disabled_at text,
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  endpoint_id text NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event_id text NOT NULL,
  type text NOT NULL,
  payload_json text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at text,
  response_status integer,
  error text,
  created_at text NOT NULL,
  delivered_at text
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_tenant_idx ON webhook_deliveries (tenant_id, created_at DESC);
