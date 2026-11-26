import type { PluginContext, RouteContext } from "emdash";
import { services } from "../../src/context.js";
import type { Result } from "../../src/model.js";
import { adminRoutes } from "../../src/routes/admin.js";
import { studentRoutes } from "../../src/routes/student.js";
import type { EmDashUser } from "../../src/services/staff.js";
import { MemoryCollection } from "./memory-collection.js";

type Handler = (ctx: RouteContext) => Promise<unknown>;
const SITE = "https://studio.example";

/**
 * Runs the plugin's real route handlers against in-memory storage: the
 * EmDash pieces they touch (storage, kv, settings, site, email) and nothing
 * else. Collections are created on first use, like EmDash provisions them.
 */
export function routeHarness() {
  const collections = new Map<string, MemoryCollection>();
  const storage = new Proxy({} as Record<string, MemoryCollection>, {
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      let collection = collections.get(name);
      if (!collection) {
        collection = new MemoryCollection();
        collections.set(name, collection);
      }
      return collection;
    },
  });
  const kvRows = new Map<string, { revision: string; value: unknown }>();
  let kvRevision = 0;
  const kv = {
    getVersioned: async (key: string) => kvRows.get(key) ?? null,
    compareAndSet: async (
      key: string,
      revision: string | null,
      value: unknown,
    ) => {
      if ((kvRows.get(key)?.revision ?? null) !== revision)
        return { applied: false };
      const next = `k${++kvRevision}`;
      kvRows.set(key, { revision: next, value });
      return { applied: true, revision: next };
    },
  };
  const sent: { to: string; subject?: string; text: string }[] = [];
  const base = {
    storage,
    kv,
    settings: { get: async () => null },
    site: { url: SITE, name: "Studio" },
    url: (path: string) => new URL(path, SITE).href,
    email: {
      send: async (message: { to: string; text: string }) => {
        sent.push(message);
      },
    },
  };
  // The subset above is all the routes use; the casts stand in for the host.
  const context = (extra: Record<string, unknown> = {}) =>
    ({ ...base, ...extra }) as unknown as RouteContext & PluginContext;

  async function call(
    routes: Record<string, unknown>,
    name: string,
    input: unknown,
    options: { user?: EmDashUser; headers?: Record<string, string> } = {},
  ): Promise<Result<unknown>> {
    const route = routes[name] as { handler: Handler } | undefined;
    if (!route) throw new Error(`No route ${name}`);
    const request = new Request(
      `${SITE}/_emdash/api/plugins/mytutor-lms/${name}`,
      { method: "POST", headers: options.headers ?? {} },
    );
    return (await route.handler(
      context({
        input,
        user: options.user,
        request,
        requestMeta: { ip: null },
      }),
    )) as Result<unknown>;
  }

  return {
    collections,
    sent,
    services: () => services(context()),
    admin: (name: string, input: unknown, user: EmDashUser) =>
      call(adminRoutes, name, input, { user }),
    student: (name: string, input: unknown, token?: string) =>
      call(studentRoutes, name, input, {
        headers: token ? { "x-mytutor-student": token } : {},
      }),
    catalog: () => call(studentRoutes, "catalog", undefined),
    /** Signs a student in by emailed code and returns the session token. */
    signIn: async (email: string) => {
      const svc = await services(context());
      const origin = {
        binding: "b".repeat(64),
        clientHash: "",
        userAgent: "test",
      };
      await svc.accounts.start({ email, locale: "vi" }, origin, svc.siteRules);
      const code = /(\d{6})/.exec(sent.at(-1)!.text)![1]!;
      const signed = await svc.accounts.verifyCode(
        { email, code },
        origin,
        "vi",
      );
      return { token: signed.sessionToken, studentId: signed.student.id };
    },
  };
}
