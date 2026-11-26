import { defineMiddleware } from "astro:middleware";
import { platformConfig } from "@templatedesign/platform/config";
import { d1Db } from "@templatedesign/platform/db";
import { runtimeEnv } from "@templatedesign/platform/runtime";
import type { SlugCache } from "@templatedesign/platform/workspaces";
import { withSecurityHeaders } from "./security";
import { loadWorkspaceRequest } from "./workspace-context";

export interface ShellMiddlewareOptions {
  /** Defaults to `platformConfig().appId`. */
  app?: string;
  /** Name of the KV binding used to cache slug lookups. Defaults to `SESSION`. */
  cacheBinding?: string;
}

function kvCache(kv: KVNamespace | undefined): SlugCache | undefined {
  return kv
    ? {
        get: (key) => kv.get(key),
        put: (key, value, options) => kv.put(key, value, options),
        delete: (key) => kv.delete(key),
      }
    : undefined;
}

/**
 * Resolves the `[ws]` path segment into `locals.workspace`, `locals.brand` and `locals.member`,
 * answers 404 for an unknown slug, 403 for a locked workspace or a non-member on `/admin`, sends
 * anonymous visitors on `/admin` to sign in, and puts the security headers on every response.
 * Compose it after the app's own session middleware with `sequence(appMiddleware, shell)` so
 * `locals.user` is already set.
 */
export function createShellMiddleware(options: ShellMiddlewareOptions = {}) {
  return defineMiddleware(async (context, next) => {
    const app = options.app ?? platformConfig().appId;
    if (!app) throw new Error("createShellMiddleware needs an app id: pass { app } or set appId in createPlatform");

    const env = runtimeEnv() as unknown as { DB: D1Database } & Record<string, unknown>;
    const path = context.url.pathname;

    if (path === "/onboarding" && !context.locals.user) {
      return context.redirect(`/auth/sign-in?next=${encodeURIComponent(path)}`);
    }

    const result = await loadWorkspaceRequest({
      db: d1Db(env.DB),
      app,
      pathname: path,
      userId: context.locals.user?.id,
      cache: kvCache(env[options.cacheBinding ?? "SESSION"] as KVNamespace | undefined),
    });

    switch (result.kind) {
      case "none":
        break;
      case "not-found":
        return withSecurityHeaders(new Response("Not found", { status: 404 }));
      case "locked":
        return withSecurityHeaders(new Response("This workspace is locked.", { status: 403 }));
      case "forbidden":
        return withSecurityHeaders(new Response("You do not have access to this workspace.", { status: 403 }));
      case "sign-in-required":
        return context.redirect(`/auth/sign-in?next=${encodeURIComponent(`${path}${context.url.search}`)}`);
      case "ok":
        context.locals.workspace = result.workspace;
        context.locals.brand = result.brand;
        context.locals.member = result.member;
        break;
    }
    return withSecurityHeaders(await next());
  });
}
