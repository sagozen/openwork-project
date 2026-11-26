import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP, magicLink } from "better-auth/plugins";
import { agentAuthExtension, agentOAuthSettings } from "./agent-oauth";
import { platformConfig } from "./config";
import { d1Db } from "./db";
import { sendTransactionalEmail } from "./emails/send";
import { isOwnerEmail, ownerEmails } from "./owner";
import { isReviewerSignIn, reviewerEmail } from "./reviewer";
import { ensureTenant, requireProfile } from "./tenancy";
import type { AuthSession, AuthUser, Locale, PlatformEnv, Profile } from "./types";

const OTP_MINUTES = 10;

function localeFromCookie(cookie: string | null | undefined): Locale {
  return /(?:^|;\s*)td_locale=vi(?:;|$)/.test(cookie ?? "") ? "vi" : "en";
}

/**
 * Better Auth on Workers + D1. Sessions live in D1 (no KV secondary storage), the
 * magic link is single-use and expires in 15 minutes (apps with `signIn: "otp"` get a six-digit code instead), and Google is the primary
 * sign-in path when credentials are configured.
 */
export function createAuth(env: PlatformEnv) {
  const origin = env.APP_ORIGIN || env.BETTER_AUTH_URL || "http://localhost:4321";
  const secure = origin.startsWith("https://");
  const socialProviders =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : undefined;

  const otp = platformConfig().signIn === "otp";
  const reviewer = reviewerEmail(env);
  const owners = ownerEmails(env);
  // The OAuth server for an MCP endpoint exists only for apps that configure `mcp`.
  const mcpConfig = platformConfig().mcp;
  const agent = mcpConfig ? agentAuthExtension(env, agentOAuthSettings(env, mcpConfig)) : null;
  const before =
    reviewer || agent || owners
      ? createAuthMiddleware(async (ctx) => {
          // Owner-only apps never send a sign-in link to an address that could not use it.
          if (owners && (ctx.path === "/sign-in/magic-link" || ctx.path === "/email-otp/send-verification-otp") &&
            !isOwnerEmail(ctx.body?.email, owners)) {
            throw new APIError("FORBIDDEN", { message: "This address is not allowed to sign in." });
          }
          // Passcode sign-in exists only for the one configured reviewer account: sign-up is off and
          // this hook rejects every other email, so no buyer can ever acquire a password login.
          if (reviewer && ctx.path === "/sign-in/email" && !isReviewerSignIn(ctx.body?.email, reviewer)) {
            throw new APIError("FORBIDDEN", { message: "Password sign-in is not available for this account." });
          }
          if (agent) return agent.before(ctx);
        })
      : undefined;

  return betterAuth({
    appName: platformConfig().brand.name,
    baseURL: env.BETTER_AUTH_URL || origin,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [origin],
    socialProviders,
    ...(reviewer
      ? { emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, autoSignIn: false } }
      : {}),
    ...(before ? { hooks: { before } } : {}),
    ...(agent ? { disabledPaths: agent.disabledPaths } : {}),
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: secure,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
      },
      database: { validateSchema: true },
    },
    databaseHooks: {
      user: {
        create: {
          // Covers Google sign-in, where the address is only known after the provider answers.
          before: async (user) => {
            if (owners && !isOwnerEmail(user.email, owners)) {
              throw new APIError("FORBIDDEN", { message: "This address is not allowed to sign in." });
            }
          },
          after: async (user) => {
            const db = d1Db(env.DB);
            await ensureTenant(db, { id: user.id, email: user.email, name: user.name });
            try {
              await platformConfig().onUserCreated?.(db, {
                id: user.id,
                email: user.email,
                name: user.name,
              });
            } catch (error) {
              // A purchase claim must never block sign-in; the lazy `/app` claim repairs it.
              console.error(
                JSON.stringify({
                  evt: "on_user_created_failed",
                  error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
                }),
              );
            }
          },
        },
      },
    },
    plugins: [
      otp
        ? emailOTP({
            otpLength: 6,
            expiresIn: OTP_MINUTES * 60,
            allowedAttempts: 5,
            storeOTP: "hashed",
            rateLimit: { window: 60, max: 5 },
            sendVerificationOTP: async ({ email, otp: code, type }, ctx) => {
              // Only the sign-in flow is exposed; other types would mail codes this app never uses.
              if (type !== "sign-in") return;
              await sendTransactionalEmail(env, d1Db(env.DB), {
                to: email,
                locale: localeFromCookie(ctx?.headers?.get("cookie")),
                template: "sign_in_code",
                data: { code, expiresMinutes: OTP_MINUTES },
              });
            },
          })
        : magicLink({
            expiresIn: 15 * 60,
            storeToken: "hashed",
            rateLimit: { window: 60, max: 5 },
            sendMagicLink: async ({ email, url }, ctx) => {
              await sendTransactionalEmail(env, d1Db(env.DB), {
                to: email,
                locale: localeFromCookie(ctx?.headers?.get("cookie")),
                template: "magic_link",
                data: { url, expiresMinutes: 15 },
              });
            },
          }),
      ...(agent ? agent.plugins : []),
    ],
  });
}

export type TemplateDesignAuth = ReturnType<typeof createAuth>;

export interface SessionContext {
  user: AuthUser;
  session: AuthSession;
  tenantId: string;
  profile: Profile;
}

export async function getSessionContext(
  auth: TemplateDesignAuth,
  env: PlatformEnv,
  request: Request,
): Promise<SessionContext | null> {
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result?.user || !result.session) return null;
  const user = result.user as unknown as AuthUser;
  const session = result.session as unknown as AuthSession;
  const profile = await requireProfile(d1Db(env.DB), { id: user.id, email: user.email, name: user.name });
  return { user, session, tenantId: profile.tenantId, profile };
}

/** Cookie attributes are asserted in tests so a deployment cannot silently weaken them. */
export function authCookiePolicy(env: PlatformEnv): {
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
} {
  const origin = env.APP_ORIGIN || env.BETTER_AUTH_URL || "http://localhost:4321";
  return { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https://"), path: "/" };
}
