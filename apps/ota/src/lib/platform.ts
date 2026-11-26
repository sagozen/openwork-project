import { createPlatform } from "@templatedesign/platform/config";
import { deleteWorkspaceObjects, workspaceMediaPrefix } from "../storage/media.js";

/** Ota's row in the shared platform. Imported by the worker, the middleware and the tests. */
export const platform = createPlatform({
  brand: {
    name: "Ota",
    appOrigin: "https://ota-multiplatform.zhst.app",
    emailFrom: "Ota <no-reply@ota-multiplatform-sender.zhst.app>",
    supportEmail: "support@ota.zhst.app",
  },
  appId: "ota",
  plans: {
    free: {
      name: "Free",
      entitlements: {
        apps: 2,
        "bundle.maxMb": 100,
        "retention.days": 30,
        "releases.perMonth": 50,
        "s3.byo": false,
        "brand.logo": true,
      },
    },
    pro: {
      name: "Pro",
      priceCredits: 500,
      periodDays: 30,
      entitlements: {
        apps: 20,
        "bundle.maxMb": 1024,
        "retention.days": 365,
        "releases.perMonth": -1,
        "s3.byo": true,
        "brand.logo": true,
      },
    },
  },
  // Top-level pages of this app that a workspace slug must never shadow.
  reservedSlugs: ["privacy", "terms"],
  packs: [
    { id: "credits-500", name: { en: "500 credits", vi: "500 credit" }, priceCents: 500, credits: 500, featured: true },
    { id: "credits-2500", name: { en: "2,500 credits", vi: "2.500 credit" }, priceCents: 2000, credits: 2500 },
  ],
  guestPolicy: {
    dailyCredits: 0,
    exceedingMessage: () => "Sign in to continue.",
    exhaustedMessage: () => "Sign in to continue.",
    signupPath: "/auth/sign-in",
  },
  copy: {
    welcomeBody: {
      en: ["Your Ota account is ready."],
      vi: ["Tài khoản Ota của bạn đã sẵn sàng."],
    },
    dataNoun: { en: "your Ota data", vi: "dữ liệu Ota của bạn" },
  },
  locales: ["en", "vi"],
  scopes: { available: ["ota:read", "ota:write"], default: ["ota:read"] },
  apiKeyPrefix: "ota",
  deletion: {
    purgeProductData: async (db, tenantId) => {
      // Stored bundles first, while the rows that name them still exist.
      // Loaded on demand: the runtime module needs the Workers runtime, which unit tests do not have.
      const { runtimeEnv } = await import("./runtime");
      const bucket = runtimeEnv().MEDIA;
      const owned = await db.all<{ id: string }>("SELECT id FROM workspaces WHERE app = 'ota' AND tenant_id = ?", [
        tenantId,
      ]);
      if (bucket) for (const { id } of owned) await deleteWorkspaceObjects(bucket, workspaceMediaPrefix(id));
      // Deleting the workspace rows would cascade; these explicit deletes keep the purge correct if a
      // workspace is kept but its product data must go.
      for (const table of ["ota_current", "ota_releases", "ota_tokens", "ota_settings", "ota_audit", "ota_apps"]) {
        await db.run(
          `DELETE FROM ${table} WHERE workspace_id IN (SELECT id FROM workspaces WHERE app = 'ota' AND tenant_id = ?)`, // unscoped-ok: account deletion spans the tenant's workspaces
          [tenantId],
        );
      }
    },
  },
});
