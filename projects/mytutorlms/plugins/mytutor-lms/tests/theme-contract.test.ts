import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The theme ships in the same repository; these contract tests skip when the
// plugin is vendored on its own (for example into a hosting platform).
const themeSrc = new URL("../../../themes/mytutor/src/", import.meta.url);
const skip =
  !existsSync(themeSrc) && "theme source is not alongside the plugin";
const load = (path: string) => import(new URL(path, themeSrc).href);
const json = (path: string) =>
  JSON.parse(readFileSync(new URL(path, themeSrc), "utf8")) as Record<
    string,
    string
  >;

test(
  "the Vietnamese and English catalogs have the same keys and placeholders",
  { skip },
  () => {
    const en = json("i18n/en.json");
    const vi = json("i18n/vi.json");
    assert.deepEqual(Object.keys(vi).sort(), Object.keys(en).sort());
    const holes = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, text] of Object.entries(en))
      assert.deepEqual(holes(vi[key]!), holes(text), key);
  },
);

test("every catalog key used by the theme exists", { skip }, () => {
  const en = json("i18n/en.json");
  const root = themeSrc.pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|astro)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  const used = new Set<string>();
  for (const file of files)
    for (const match of readFileSync(file, "utf8").matchAll(
      /\bt\(\s*["'`]([a-zA-Z]+\.[\w.]+)["'`]/g,
    ))
      used.add(match[1]!);
  assert.ok(used.size > 100);
  for (const key of used) assert.ok(key in en, `missing key ${key}`);
});

test(
  "translations fill placeholders and choose the site language",
  { skip },
  async () => {
    const { translator, chooseLocale } = await load("i18n/index.ts");
    const t = translator("vi");
    assert.equal(
      t("dashboard.progress", { done: 2, total: 5 }),
      "Đã học xong 2/5 bài học",
    );
    assert.equal(translator("en")("classroom.minutes", { count: 1 }), "1 min");
    const site = {
      locales: ["vi", "en"] as const,
      defaultLocale: "vi" as const,
    };
    assert.equal(
      chooseLocale({ ...site, locales: [...site.locales] }, undefined),
      "vi",
    );
    assert.equal(
      chooseLocale({ ...site, locales: [...site.locales] }, "en"),
      "en",
    );
    assert.equal(
      chooseLocale({ locales: ["vi"], defaultLocale: "vi" }, "en"),
      "vi",
    );
    assert.equal(
      chooseLocale({ locales: ["es"], defaultLocale: "es" }, undefined),
      "en",
    );
  },
);

test("UX events carry identifiers only", { skip }, async () => {
  const { validEnvelope } = await load("lib/analytics-events.ts");
  const event = {
    event: "lesson_completed",
    locale: "vi",
    device: "phone",
    route: "/learn/course-1",
    ts: 1,
    sessionId: "a".repeat(32),
    props: { courseId: "course-1", lessonId: "lesson-2" },
  };
  assert.ok(validEnvelope(event));
  assert.equal(validEnvelope({ ...event, event: "page_spy" }), null);
  assert.equal(
    validEnvelope({ ...event, props: { email: "a@example.com" } }),
    null,
  );
  assert.equal(
    validEnvelope({ ...event, props: { courseId: "two words here" } }),
    null,
  );
  assert.equal(
    validEnvelope({
      ...event,
      event: "sign_in_failed",
      props: { method: "email_code", reason: "a@example.com" },
    }),
    null,
  );
  assert.equal(validEnvelope({ ...event, route: "/learn?email=x" }), null);
});
