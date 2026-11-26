-- ImageFactory: product tables only. Tenants, wallets, the ledger, API keys and admin come from the
-- platform baseline. Every table carries tenant_id and an index that starts with it.

CREATE TABLE IF NOT EXISTS image_jobs (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id text,
  brand_id text,
  kind text NOT NULL CHECK (kind IN ('generate', 'edit')),
  model text NOT NULL,
  params_json text NOT NULL,
  provider text NOT NULL,
  provider_job_id text,
  status_url text,
  response_url text,
  state text NOT NULL CHECK (state IN ('submitting', 'queued', 'running', 'finalizing', 'done', 'failed')),
  num_images integer NOT NULL,
  credits_reserved integer NOT NULL,
  credits_charged integer,
  blocked_count integer NOT NULL DEFAULT 0,
  finalize_token text,
  error_code text,
  error_message text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  finished_at text
);

CREATE INDEX IF NOT EXISTS idx_image_jobs_tenant ON image_jobs (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_image_jobs_tenant_state ON image_jobs (tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_image_jobs_state ON image_jobs (state, updated_at);
-- A provider request id maps to exactly one job, which makes webhook redelivery idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_jobs_provider_job
  ON image_jobs (provider, provider_job_id) WHERE provider_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS images (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
  brand_id text,
  r2_key text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  mime text NOT NULL,
  bytes integer NOT NULL,
  seed integer,
  prompt text NOT NULL,
  title text,
  tags text,
  created_at text NOT NULL,
  deleted_at text
);

CREATE INDEX IF NOT EXISTS idx_images_tenant ON images (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_images_tenant_brand ON images (tenant_id, brand_id, created_at);
CREATE INDEX IF NOT EXISTS idx_images_job ON images (job_id);
