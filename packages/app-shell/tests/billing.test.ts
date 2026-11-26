import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPlatform, resetPlatformConfig } from "@templatedesign/platform/config";
import appShell from "../src/integration";
import { featureLabel, featureValue, planRows } from "../src/plan-view";

test("every injected route points at a file that exists and no pattern is injected twice", () => {
  const injected: Array<{ pattern: string; entrypoint: URL }> = [];
  const integration = appShell();
  const setup = integration.hooks["astro:config:setup"] as unknown as (options: {
    injectRoute: (route: { pattern: string; entrypoint: URL }) => void;
  }) => void;
  setup({ injectRoute: (route) => injected.push(route) });

  assert.ok(injected.length >= 14);
  for (const route of injected)
    assert.ok(existsSync(fileURLToPath(route.entrypoint)), `${route.pattern} -> ${route.entrypoint}`);
  const unique = new Set(injected.map((route) => route.pattern));
  assert.equal(unique.size, injected.length, "duplicate route pattern");
  for (const required of [
    "/onboarding",
    "/pricing",
    "/app/credits",
    "/[ws]/admin/billing",
    "/api/v1/payment-webhooks/[provider]",
  ]) {
    assert.ok(unique.has(required), required);
  }
});

test("plans render free first with readable limits", () => {
  createPlatform({
    brand: { name: "T", appOrigin: "https://t.example", emailFrom: "T <t@t.example>" },
    packs: [],
    guestPolicy: { dailyCredits: 0, exceedingMessage: () => "", exhaustedMessage: () => "", signupPath: "/" },
    copy: { welcomeBody: { en: [""], vi: [""] }, dataNoun: { en: "x", vi: "x" } },
    locales: ["en", "vi"],
    scopes: { available: [], default: [] },
    plans: {
      pro: { name: "Pro", priceCredits: 500, entitlements: { "orders.perMonth": -1, sepay: true } },
      free: { name: "Free", entitlements: { "orders.perMonth": 200, sepay: false, branches: 1 } },
    },
  });
  try {
    const rows = planRows();
    assert.deepEqual(
      rows.map((row) => row.id),
      ["free", "pro"],
    );
    assert.equal(rows[1].priceCredits, 500);
    assert.equal(rows[1].periodDays, 30);
    assert.deepEqual(
      rows[0].features.map((feature) => [feature.label, feature.value]),
      [
        ["Orders per month", "200"],
        ["Sepay", "Not included"],
        ["Branches", "1"],
      ],
    );
    assert.equal(rows[1].features[0].value, "Unlimited");
    assert.equal(featureLabel("bundle.maxMb"), "Bundle max Mb");
    assert.equal(featureValue(true), "Included");
  } finally {
    resetPlatformConfig();
  }
});
