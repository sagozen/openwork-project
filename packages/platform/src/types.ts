/** Cloudflare Email Service `send_email` binding (Workers). */
export interface CloudflareEmailBinding {
  send(message: {
    from: string;
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<unknown>;
}

/**
 * Bindings every product on the platform needs. A product extends this with its own
 * bindings and secrets (for example `EXPORTS` in templatedesign or `TRANSCRIPT_MEDIA`
 * in TranscriptAnything) and passes the extension to the platform helpers, which only
 * ever read the fields declared here.
 */
export interface PlatformEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  EMAIL_FROM?: string;
  EMAIL_PROVIDER?: "console" | "resend" | "postmark" | "cloudflare";
  EMAIL?: CloudflareEmailBinding;
  EMAIL_DEBUG?: string;
  RESEND_API_KEY?: string;
  POSTMARK_TOKEN?: string;
  INTERNAL_SWEEP_SECRET?: string;
  TURNSTILE_SECRET?: string;
  PAYMENTS_PROVIDER?: "paddle" | "stripe";
  PADDLE_API_KEY?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRODUCT_ID?: string;
  PADDLE_ENVIRONMENT?: "sandbox" | "production";
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ADMIN_EMAILS?: string;
  /** Owner-only mode: comma-separated addresses that may sign in. Unset keeps sign-in open. */
  OWNER_EMAILS?: string;
  /** Enables passcode sign-in for this one email only. Unset means magic link and Google only. */
  REVIEWER_EMAIL?: string;
  /** Comma-separated inboxes for buy, purchase and usage emails. Falls back to `ADMIN_EMAILS`. */
  SALES_ALERT_EMAIL?: string;
  WARRIORPLUS_IPN_KEY?: string;
  WARRIORPLUS_IPN_KEY_NEXT?: string;
  WARRIORPLUS_API_KEY?: string;
  EMAIL_REPLY_TO?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image?: string | null;
}

export interface AuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  /** When the session was created, i.e. the last full sign-in. Set by Better Auth at runtime. */
  createdAt?: Date | string;
}

export interface Profile {
  userId: string;
  tenantId: string;
  displayName: string;
  uiLanguage: "en" | "vi";
  docLanguage: "en" | "vi";
  defaultRetentionSeconds: number;
  numberLocale: string;
  dateLocale: string;
  lowBalanceEmail: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RequestContext<E extends PlatformEnv = PlatformEnv> {
  user: AuthUser;
  tenantId: string;
  profile: Profile;
  csrfToken: string;
  env: E;
  request: Request;
}

export type Locale = "en" | "vi";
