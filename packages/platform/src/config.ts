import type { Db } from "./db";
import type { Locale, PlatformEnv } from "./types";

/**
 * Everything a product decides for itself. The platform owns behaviour (auth, wallet,
 * checkout, admin, webhooks, retention); the product owns names, prices, quotas, copy and
 * the handful of hooks that reach into its own tables.
 *
 * `createPlatform(config)` is called once per app module (`src/lib/platform.ts`) and every
 * platform module reads the configured values through `platformConfig()`.
 */
export interface CreditPack {
  id: string;
  name: Record<Locale, string>;
  priceCents: number;
  credits: number;
  featured?: boolean;
}

export interface BrandConfig {
  /** Shown in email headers, page titles and provider metadata. */
  name: string;
  /** Absolute origin, e.g. `https://templatedesign.zhst.app`. */
  appOrigin: string;
  /** RFC 5322 sender used when `EMAIL_FROM` is not set. */
  emailFrom: string;
  supportEmail?: string;
  /** Optional Reply-To on every transactional email. */
  emailReplyTo?: string;
  /** Paths the shared emails link to. Defaults match the shared app shell. */
  developersPath?: string;
  settingsPath?: string;
  /** Where the top-up UI lives, used in `insufficient_credits` errors. Default `/app/credits`. */
  topupPath?: string;
  /** Where a finished checkout returns; `{payment}` is replaced by the payment id. */
  checkoutReturnPath?: string;
  /** Where a cancelled checkout returns. */
  checkoutCancelPath?: string;
  /** Admin route whose wording appears in operator emails. */
  reconciliationPath?: string;
}

export interface GuestPolicy {
  /** Units a guest may consume per day, per browser id. */
  dailyCredits: number;
  /** Shown when one request needs more than a guest may have in a day. */
  exceedingMessage(locale: Locale, input: { needed: number; allowed: number }): string;
  /** Shown when today's guest allowance is spent. */
  exhaustedMessage(locale: Locale, input: { allowed: number; freeMonthlyCredits: number }): string;
  signupPath: string;
}

export interface ProductCopy {
  /** Paragraphs used by the welcome email, in order. */
  welcomeBody: Record<Locale, string[]>;
  /** Noun list used by the deletion emails, e.g. "templates, assets and outputs". */
  dataNoun: Record<Locale, string>;
}

export interface ApiScopeConfig {
  available: string[];
  default: string[];
}

export interface AdminSettingSpec {
  key: string;
  kind: "number" | "boolean" | "string" | "json";
  /** Maximum for `kind: "number"`. */
  max?: number;
  /** Maximum length for `kind: "string"`. */
  maxLength?: number;
}

/** One row of the product's own job table, shown on the admin account page. */
export interface AccountJobRow {
  id: string;
  /** Product label, e.g. the template id or the source kind. */
  label: string;
  status: string;
  chargedCredits: number;
  createdAt: string;
  resourceId: string | null;
  /** Product-specific size: pages for templatedesign, minutes for transcripts. */
  units: number | null;
}

export interface ProductMetrics {
  jobs24h: number;
  failures24h: number;
  queued: number;
  running: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  queueAgeMs: number | null;
  failureByCode: Array<{ code: string; count: number }>;
  failureByLabel: Array<{ label: string; count: number }>;
}

export interface AdminHooks {
  /** Product job rows for the admin account lookup. Omit when the product has no jobs. */
  loadAccountJobs?(db: Db, tenantId: string): Promise<AccountJobRow[]>;
  /** Product job metrics for `/admin`. Omit to report zeros. */
  loadProductMetrics?(db: Db): Promise<ProductMetrics>;
  /** Product keys accepted by the generic settings editor, in addition to the shared ones. */
  extraSettings?: AdminSettingSpec[];
}

export interface DeletionHooks {
  /**
   * Delete product rows for a tenant before the shared rows are purged. Runs inside the
   * deletion batch's transaction boundary expectations: it must be idempotent.
   */
  purgeProductData?(db: Db, tenantId: string): Promise<void>;
}

/** What a product reports about its own usage in one window; shown on the admin page and emailed. */
export interface CrmProductUsage {
  /** Short phrase for the email subject, for example "12 tài liệu". */
  headline: string;
  /** Operator-language report lines, one sentence each. */
  lines: string[];
  /** Cards for the admin Customers page. */
  cards: Array<{ value: string; label: string }>;
}

/**
 * Opts a product into the mini CRM (customer journey, buy and purchase emails, 6-hour usage
 * email). The product must also ship the `crm_events` and `crm_notices` tables.
 */
export interface CrmHooks {
  /**
   * SELECT of (tenant_id, user_id, step, source_id, detail, occurred_at) with one row per tenant:
   * its first successful job, step `first_success`, source_id `''`, `detail` a JSON object.
   */
  firstSuccessSql: string;
  /** Product usage inside `[fromMs, toMs)`. Counts only: never input, output or document content. */
  usage(db: Db, fromMs: number, toMs: number): Promise<CrmProductUsage>;
}

export interface WebhookHooks {
  /** Events a product may subscribe to. Defaults to templatedesign's job events. */
  events: string[];
}

/**
 * One plan of an app's free/paid ladder. `entitlements` maps a key to its limit: a number, `-1`
 * for unlimited, or a boolean for an on/off feature. A key a plan omits is not granted.
 */
export interface PlanDefinition {
  name: string;
  /** Credits charged from the owner's wallet for one period of this plan. Omit for plans that are not for sale. */
  priceCredits?: number;
  /** Length of one paid period in days. Defaults to 30. */
  periodDays?: number;
  entitlements: Record<string, number | boolean>;
}

/** One WarriorPlus product, mapped from its `wso_…` item number to a product code. */
export interface WarriorPlusProduct {
  code: string;
  kind: "one_time" | "recurring";
  /** Another product code this one needs to grant anything. Add-ons require `fe`. */
  requires?: string;
  /** REST product id (`product_…`) when it differs from the IPN `wso_…` id. */
  restId?: string;
}

export interface WarriorPlusPurchase {
  id: string;
  app: string;
  sale: string;
  itemNumber: string;
  productCode: string;
  kind: "one_time" | "recurring" | "comp";
  buyerEmail: string;
  tenantId: string | null;
  workspaceId: string | null;
  status: string;
  amountCents: number | null;
  source: "ipn" | "reconcile" | "comp";
  verifiedAt: string | null;
}

export interface WarriorPlusConfig {
  /** This app's id in the `workspaces` and `wp_*` tables. */
  app: string;
  /** IPN item number (`wso_…`) to product. A product may also be found by its `code`. */
  products: Record<string, WarriorPlusProduct>;
  /** Product code to the entitlement keys it grants. Numbers: `-1` is unlimited. */
  entitlements: Record<string, Record<string, number | boolean>>;
  /** Runs after REST verification. Credit grants belong here, never at ingest. */
  onVerified?(db: Db, purchase: WarriorPlusPurchase): Promise<void>;
  /** One verified, in-sequence recurring payment. */
  onPaymentCompleted?(db: Db, purchase: WarriorPlusPurchase, paymentNum: number): Promise<void>;
  /** A verified recurring payment was refunded. */
  onPaymentRefunded?(db: Db, purchase: WarriorPlusPurchase, paymentNum: number): Promise<void>;
  /** A subscription payment failed. The app owns the wording and any deduplication. */
  onPaymentFailed?(env: PlatformEnv, db: Db, purchase: WarriorPlusPurchase): Promise<void>;
  /** Copy for the first "your purchase is ready" email. The app owns the wording. */
  welcome?: {
    subject: string;
    heading: string;
    lines: string[];
    actionUrl?: string;
    actionLabel?: string;
  };
}

/**
 * Opts an app into the OAuth authorization server for its MCP endpoint (Better Auth's `mcp`
 * plugin). The app must also list the `oauth` migration module and mount the routes from
 * `@templatedesign/platform/agents`. Omitted means no OAuth endpoints and no extra tables.
 */
export interface McpConfig {
  /** Path of the protected MCP endpoint on the app origin, e.g. `/mcp`. It is the OAuth resource. */
  resourcePath: string;
  /** Scopes a client may request, e.g. `["images:read", "images:write", "offline_access"]`. `offline_access` allows refresh tokens. */
  scopes: string[];
  /** Scopes a registered client gets when it registers without any. Defaults to every scope except `offline_access`. */
  defaultScopes?: string[];
  /** App page that signs the user in and shows the consent screen, e.g. `/connect/authorize`. */
  consentPath: string;
}

export interface PlatformConfig {
  brand: BrandConfig;
  packs: CreditPack[];
  guestPolicy: GuestPolicy;
  copy: ProductCopy;
  locales: Locale[];
  scopes: ApiScopeConfig;
  /** API key prefix; keys read `<prefix>_live_…`. Defaults to `td`. */
  apiKeyPrefix?: string;
  admin?: AdminHooks;
  deletion?: DeletionHooks;
  crm?: CrmHooks;
  webhooks?: WebhookHooks;
  /** This app's id in the `workspaces` table, for example `restaurant`. Set by apps that opt in. */
  appId?: string;
  /** Workspace plans by id. `free` is the plan every new workspace starts on. */
  plans?: Record<string, PlanDefinition>;
  /** Slugs workspaces may not take, added to the platform's own reserved list. */
  reservedSlugs?: string[];
  /** Free workspaces one user may own per app. Defaults to 3. */
  maxFreeWorkspacesPerUser?: number;
  /** Optional WarriorPlus purchases module. Apps without it never receive its tables. */
  warriorplus?: WarriorPlusConfig;
  /** Optional OAuth module for an MCP endpoint. Apps without it never receive its tables or endpoints. */
  mcp?: McpConfig;
  /**
   * How email sign-in works. `magic-link` (default) mails a single-use link; `otp` mails a six-digit
   * code the person types back on the sign-in page, which survives mail apps that open links in a
   * different browser than the installed PWA.
   */
  signIn?: "magic-link" | "otp";
  /** Runs after a new user's tenant is created. A failure never blocks sign-in. */
  onUserCreated?(db: Db, user: { id: string; email: string; name?: string }): Promise<void>;
}

export const EMPTY_PRODUCT_METRICS: ProductMetrics = {
  jobs24h: 0,
  failures24h: 0,
  queued: 0,
  running: 0,
  avgDurationMs: null,
  p95DurationMs: null,
  queueAgeMs: null,
  failureByCode: [],
  failureByLabel: [],
};

/**
 * Defaults keep the platform usable in tests and in a half-scaffolded app; every product
 * calls `createPlatform()` with its real values before serving traffic.
 */
export const DEFAULT_CONFIG: PlatformConfig = {
  brand: {
    name: "Platform",
    appOrigin: "http://localhost:4321",
    emailFrom: "Platform <no-reply@localhost>",
    developersPath: "/app/developers",
    settingsPath: "/app/settings",
    topupPath: "/app/credits",
    checkoutReturnPath: "/app/credits/return?payment={payment}",
    checkoutCancelPath: "/app/credits?checkout=cancelled",
    reconciliationPath: "/admin/reconciliation/",
  },
  packs: [],
  guestPolicy: {
    dailyCredits: 3,
    exceedingMessage: (_locale, input) => `Guest files are limited to ${input.allowed} per day.`,
    exhaustedMessage: (_locale, input) =>
      `Guest quota is used up for today. Sign in for ${input.freeMonthlyCredits} free credits a month.`,
    signupPath: "/auth/sign-in",
  },
  copy: {
    welcomeBody: {
      en: ["Your account is ready."],
      vi: ["Tài khoản của bạn đã sẵn sàng."],
    },
    dataNoun: { en: "your data", vi: "dữ liệu của bạn" },
  },
  locales: ["en", "vi"],
  scopes: { available: ["jobs:write", "jobs:read", "usage:read"], default: ["jobs:write", "jobs:read"] },
  apiKeyPrefix: "td",
};

let current: PlatformConfig = DEFAULT_CONFIG;

export function createPlatform(config: PlatformConfig): PlatformConfig {
  current = {
    ...DEFAULT_CONFIG,
    ...config,
    brand: { ...DEFAULT_CONFIG.brand, ...config.brand },
    admin: config.admin,
    deletion: config.deletion,
    plans: config.plans,
    warriorplus: config.warriorplus,
    mcp: config.mcp,
    onUserCreated: config.onUserCreated,
  };
  return current;
}

export function platformConfig(): PlatformConfig {
  return current;
}

/** Test helper: restore the defaults between cases. */
export function resetPlatformConfig(): void {
  current = DEFAULT_CONFIG;
}

export function packById(packId: string): CreditPack | null {
  return current.packs.find((pack) => pack.id === packId) ?? null;
}

export function brandUrl(path = "/"): string {
  return `${current.brand.appOrigin.replace(/\/$/, "")}${path}`;
}

/** Bindings the platform reads. Products pass their own `PlatformEnv` extension. */
export type PlatformBindings = PlatformEnv;
