import { createPlatform } from "@templatedesign/platform/config";

/** MyArtifacts' row in the shared platform. Imported by the worker, the middleware and the tests. */
export const platform = createPlatform({
  brand: {
    name: "MyArtifacts",
    appOrigin: "https://myartifacts.zhst.app",
    emailFrom: "MyArtifacts <no-reply@myartifacts.zhst.app>",
    supportEmail: "support@myartifacts.zhst.app",
    developersPath: "/account",
    settingsPath: "/account",
    topupPath: "/account",
    reconciliationPath: "/admin/",
  },
  packs: [],
  // A closed guest policy: there is no anonymous use and nothing to buy.
  guestPolicy: {
    dailyCredits: 0,
    exceedingMessage: () => "Sign in to continue.",
    exhaustedMessage: () => "Sign in to continue.",
    signupPath: "/sign-in",
  },
  copy: {
    welcomeBody: {
      en: ["Add MyArtifacts to Claude or ChatGPT as a connector to store and share files."],
      vi: ["Thêm MyArtifacts vào Claude hoặc ChatGPT dưới dạng connector để lưu và chia sẻ tệp."],
    },
    dataNoun: { en: "your files and share links", vi: "tệp và liên kết chia sẻ của bạn" },
  },
  locales: ["en"],
  scopes: { available: ["artifacts:read", "artifacts:write"], default: ["artifacts:read", "artifacts:write"] },
  apiKeyPrefix: "ma",
  mcp: {
    resourcePath: "/mcp",
    scopes: ["artifacts:read", "artifacts:write", "offline_access"],
    consentPath: "/connect/authorize",
  },
  admin: {
    extraSettings: [
      { key: "uploads.enabled", kind: "boolean" },
      { key: "uploads.max_inline_bytes", kind: "number", max: 4 * 1024 * 1024 },
      { key: "uploads.max_import_bytes", kind: "number", max: 500 * 1024 * 1024 },
    ],
  },
});
