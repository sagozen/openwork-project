/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

import type { AuthSession, AuthUser, Profile } from "@templatedesign/platform/types";
import type { ShellLocals } from "./types";

// Compiled on its own, the package needs a Locals shape. Apps declare their own (extending
// ShellLocals), so this file is never part of an app's program.
declare global {
  namespace App {
    interface Locals extends ShellLocals {
      user?: AuthUser;
      session?: AuthSession;
      tenantId?: string;
      profile?: Profile;
      csrfToken?: string;
    }
  }
}
