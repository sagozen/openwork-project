import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, routeHash, type Route } from "../src/admin/routes.js";

test("workspace routes round-trip through the URL hash", () => {
  const routes: Route[] = [
    { view: "home" },
    { view: "courses" },
    { view: "students" },
    { view: "grading" },
    { view: "team" },
    { view: "site" },
    { view: "editor", id: "new" },
    { view: "editor", id: "course-1" },
    { view: "roster", id: "course-1" },
    { view: "assignments", id: "course-1" },
    { view: "media", id: "course-1" },
  ];
  for (const route of routes)
    assert.deepEqual(parseRoute(routeHash(route)), route);
  assert.deepEqual(parseRoute(""), { view: "home" });
  assert.deepEqual(parseRoute("#/courses/new/students"), { view: "home" });
  assert.deepEqual(parseRoute("#/courses/../x"), { view: "home" });
  assert.deepEqual(parseRoute("#/unknown"), { view: "home" });
});

test("cron job names pass EmDash's task name rule", async () => {
  const { DISPATCH_JOB, EXPIRY_JOB } = await import("../src/context.js");
  for (const name of [DISPATCH_JOB, EXPIRY_JOB])
    assert.match(name, /^[A-Za-z][A-Za-z0-9_-]*$/);
});

test("a stored accent below the contrast target still loads; saving one is refused", async () => {
  const { MemoryCollection } = await import("./support/memory-collection.js");
  const { SiteService, defaultSite, saveSiteSchema } = await import(
    "../src/services/site.js"
  );
  const sites = new MemoryCollection();
  const legacy = {
    ...defaultSite("legacy"),
    accentColor: "oklch(0.7 0.15 155)",
  };
  await sites.put("site", { schemaVersion: 1, settings: legacy, updatedAt: 1 });
  const service = new SiteService(sites, "legacy");
  assert.equal((await service.get()).settings.accentColor, legacy.accentColor);
  assert.equal(
    saveSiteSchema.safeParse({ revision: null, value: legacy }).success,
    false,
  );
  assert.equal(
    saveSiteSchema.safeParse({ revision: null, value: defaultSite("legacy") })
      .success,
    true,
  );
});
