/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

import type { ShellLocals } from "@templatedesign/app-shell/types";
import type { AuthSession, AuthUser, Profile } from "@templatedesign/platform/types";

declare global {
  namespace App {
    interface Locals extends ShellLocals {
      user?: AuthUser;
      session?: AuthSession;
      tenantId?: string;
      profile?: Profile;
      csrfToken?: string;
      locale: "en" | "vi";
    }
  }
}
