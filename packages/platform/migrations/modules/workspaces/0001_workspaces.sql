-- Opt-in platform module: workspaces. An app enables it with `"modules": ["workspaces"]` in its
-- migrations.manifest.json. A workspace is one customer site on a shared Worker, addressed by
-- `/<slug>/` under the app's host. Apps that do not list the module never receive these tables.

CREATE TABLE IF NOT EXISTS workspaces (
  id text NOT NULL PRIMARY KEY,
  app text NOT NULL,
  slug text NOT NULL,
  -- The owner's account tenant: wallet, API keys and webhooks stay on the account.
  tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  -- A paid plan bought with credits runs until this instant; NULL means it does not expire.
  plan_expires_at text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked')),
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_app_slug_idx ON workspaces (app, slug);
CREATE INDEX IF NOT EXISTS workspaces_tenant_idx ON workspaces (tenant_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  -- owner / admin / staff plus any role the app defines (manager, cashier, accountant...).
  role text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE IF NOT EXISTS workspace_branding (
  workspace_id text NOT NULL PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  display_name text,
  logo_key text,
  logo_dark_key text,
  accent_color text,
  updated_at text NOT NULL
);

-- Per-workspace overrides of the plan's limits (support grants, negotiated deals). The plan
-- itself lives in the app's createPlatform({ plans }) config. limit_value -1 means unlimited.
CREATE TABLE IF NOT EXISTS workspace_entitlements (
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  key text NOT NULL,
  limit_value integer NOT NULL,
  source text NOT NULL DEFAULT 'override' CHECK (source IN ('plan', 'override')),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS workspace_usage (
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  key text NOT NULL,
  -- "2026-10" for monthly counters, "total" for lifetime ones.
  period text NOT NULL,
  used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, key, period)
);
