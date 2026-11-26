/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

import type { AuthSession, AuthUser, Profile } from "@templatedesign/platform/types";

declare global {
  namespace App {
    interface Locals {
      user?: AuthUser;
      session?: AuthSession;
      tenantId?: string;
      profile?: Profile;
      csrfToken?: string;
      locale: "en" | "vi";
      /** Signed in, but the address is not on the owner list. `user` is left unset. */
      nonOwner?: boolean;
    }
  }
}
