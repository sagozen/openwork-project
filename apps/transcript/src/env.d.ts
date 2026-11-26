/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

import type { AuthSession, AuthUser, Profile } from "@templatedesign/platform/types";
import type { Env } from "./lib/types";

declare global {
  namespace App {
    interface Locals {
      runtime: {
        env: Env;
        cf?: unknown;
        ctx: ExecutionContext;
      };
      user?: AuthUser;
      session?: AuthSession;
      tenantId?: string;
      profile?: Profile;
      csrfToken?: string;
      locale: "en" | "vi";
      /** Browser-scoped identity for free jobs and rate limits. */
      guestId: string;
      /** Set when the visitor arrived through `/{https://…}`. */
      presetSource?: string;
    }
  }
}
