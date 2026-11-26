import { createPlatform, type WarriorPlusConfig } from "../src/config";
import type { Db } from "../src/db";
import { id, nowIso } from "../src/db";
import type { PlatformEnv } from "../src/types";
import { handleWarriorPlusIpn } from "../src/warriorplus/ipn";
import { createTestDb, type TestDb } from "./support/db";

export const IPN_KEY = "ipn_test_secret";

export const WARRIORPLUS: WarriorPlusConfig = {
  app: "puzzle",
  products: {
    wso_fe: { code: "fe", kind: "one_time" },
    wso_bump: { code: "bump", kind: "one_time", requires: "fe" },
    wso_oto1: { code: "oto1", kind: "one_time", requires: "fe", restId: "product_oto1" },
    wso_oto1_ds: { code: "oto1_ds", kind: "one_time", requires: "fe" },
    wso_oto2: { code: "oto2", kind: "one_time", requires: "fe" },
    wso_oto3: { code: "oto3", kind: "one_time", requires: "fe" },
    wso_club: { code: "club", kind: "recurring", requires: "fe" },
  },
  entitlements: {
    fe: { "books.perMonth": 10, "packs.decades.core": true, "wordlists.custom": true, seats: 1 },
    bump: { "packs.holiday": true },
    oto1: {
      "books.perMonth": -1,
      "packs.decades.pro": true,
      "puzzles.pro": true,
      "ai.themes.perDay": 20,
      "cover.builder": true,
    },
    oto1_ds: { "books.perMonth": -1, "packs.decades.pro": true, "puzzles.pro": true },
    oto2: {
      "etsy.export": true,
      "personalize.enabled": true,
      "keepsake.pages": true,
      "personalize.rowsPerBatch": 100,
      "credits.bridge": 1000,
    },
    oto3: { seats: 5, whitelabel: true, "commercial.license": true, "dfy.books": true },
    club: { "club.drops": true, "club.creditsMonthly": 500 },
  },
  welcome: {
    subject: "Your LargePrint Puzzle Studio access",
    heading: "You're in",
    lines: ["Sign in with this email address to start your first book."],
    actionUrl: "https://largeprint.zhst.app/signin",
    actionLabel: "Sign in",
  },
};

export function platformConfigForWarriorPlus(config = WARRIORPLUS): WarriorPlusConfig {
  createPlatform({
    brand: {
      name: "LargePrint Puzzle Studio",
      appOrigin: "https://largeprint.zhst.app",
      emailFrom: "LargePrint <no-reply@largeprint.zhst.app>",
      supportEmail: "support@example.com",
    },
    packs: [],
    guestPolicy: {
      dailyCredits: 1,
      exceedingMessage: () => "",
      exhaustedMessage: () => "",
      signupPath: "/signin",
    },
    copy: { welcomeBody: { en: [], vi: [] }, dataNoun: { en: "books", vi: "sách" } },
    locales: ["en"],
    scopes: { available: [], default: [] },
    plans: { free: { name: "Free", entitlements: {} } },
    maxFreeWorkspacesPerUser: 1,
    warriorplus: config,
  });
  return config;
}

export function testEnv(overrides: Partial<PlatformEnv> = {}): PlatformEnv {
  return {
    DB: {} as never,
    BETTER_AUTH_SECRET: "test",
    BETTER_AUTH_URL: "https://largeprint.zhst.app",
    APP_ORIGIN: "https://largeprint.zhst.app",
    EMAIL_PROVIDER: "console",
    ADMIN_EMAILS: "",
    WARRIORPLUS_IPN_KEY: IPN_KEY,
    ...overrides,
  };
}

export function testDb(): TestDb {
  const shim = createTestDb({ modules: ["workspaces", "warriorplus"] });
  shim.raw.exec("ALTER TABLE workspaces ADD COLUMN licensed INTEGER NOT NULL DEFAULT 0");
  return shim;
}

export async function insertUser(db: Db, options: { id?: string; email: string; verified?: boolean }): Promise<string> {
  const userId = options.id ?? id("usr");
  const timestamp = nowIso();
  await db.run(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, "Buyer", options.email.toLowerCase(), options.verified === false ? 0 : 1, timestamp, timestamp],
  );
  return userId;
}

export function salePayload(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    IPN_ID: id("ipn"),
    WP_ACTION: "sale",
    IPN_RCPT_TYPE: "vend",
    WP_SALE: id("sale"),
    WP_SALEID: "12345",
    WP_SALE_TYPE: "single",
    WP_ITEM_NAME: "LargePrint Puzzle Studio",
    WP_ITEM_NUMBER: "wso_fe",
    WP_SALE_AMOUNT: "17.00",
    WP_SALE_CURRENCY: "USD",
    WP_PAYMENT_STATUS: "COMPLETED",
    WP_BUYER_EMAIL: "buyer@example.com",
    WP_PII_OBFUSCATED: "0",
    WP_SECURITYKEY: IPN_KEY,
    ...overrides,
  };
}

export async function runIpn(
  db: Db,
  payload: Record<string, string>,
  env: PlatformEnv = testEnv(),
  config: WarriorPlusConfig = WARRIORPLUS,
): Promise<{ response: Response; processed: Promise<unknown>[] }> {
  const body = new URLSearchParams(payload);
  const request = new Request("https://largeprint.zhst.app/api/warriorplus/ipn", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const processed: Promise<unknown>[] = [];
  const response = await handleWarriorPlusIpn(
    request,
    env,
    { waitUntil: (promise) => processed.push(promise) },
    config,
    db,
  );
  await Promise.all(processed);
  return { response, processed };
}

export async function purchase(db: Db, sale: string, item = "wso_fe"): Promise<Record<string, unknown> | null> {
  return db.first<Record<string, unknown>>(
    "SELECT * FROM wp_purchases WHERE app = ? AND sale = ? AND item_number = ?",
    ["puzzle", sale, item],
  );
}

export async function entitlements(db: Db): Promise<Record<string, number>> {
  const workspace = await db.first<{ id: string }>(
    "SELECT id FROM workspaces WHERE app = 'puzzle' AND licensed = 1 LIMIT 1",
  );
  if (!workspace) return {};
  const rows = await db.all<{ key: string; limit_value: number }>(
    "SELECT key, limit_value FROM workspace_entitlements WHERE workspace_id = ?",
    [workspace.id],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.limit_value]));
}

export async function licensedWorkspaces(db: Db): Promise<number> {
  const row = await db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM workspaces WHERE app = 'puzzle' AND licensed = 1",
  );
  return row?.count ?? 0;
}
