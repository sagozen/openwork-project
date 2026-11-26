-- Brand kits: the style system every generation can apply. Reference assets are stored under a
-- private R2 prefix and are never served from the public image route.

CREATE TABLE IF NOT EXISTS brand_kits (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  style_prompt text NOT NULL DEFAULT '',
  negative_prompt text,
  palette_json text NOT NULL DEFAULT '[]',
  typography text,
  default_model text,
  default_preset text,
  lora_url text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  deleted_at text
);

CREATE INDEX IF NOT EXISTS idx_brand_kits_tenant ON brand_kits (tenant_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_kits_tenant_slug
  ON brand_kits (tenant_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS brand_assets (
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id text NOT NULL REFERENCES brand_kits(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('reference', 'logo', 'example')),
  r2_key text NOT NULL,
  mime text NOT NULL,
  width integer,
  height integer,
  bytes integer NOT NULL,
  note text,
  sort integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  deleted_at text
);

CREATE INDEX IF NOT EXISTS idx_brand_assets_tenant_brand ON brand_assets (tenant_id, brand_id, sort);
