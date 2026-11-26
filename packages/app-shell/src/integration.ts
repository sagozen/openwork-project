import type { AstroIntegration } from "astro";

const page = (file: string) => new URL(`./pages/${file}`, import.meta.url);

/**
 * Injects the routes every workspace app shares, so each app only writes domain pages:
 *
 *   /onboarding                        create a workspace (slug + name)
 *   /<slug>/admin/settings/branding    name, accent colour and logo
 *   /<slug>/admin/members              invite staff and set their role
 *   /brand/<workspace>/<hash>.<ext>    uploaded logos
 *   /pricing                           public plan comparison
 *   /<slug>/admin/billing              plan, usage, upgrade with credits, downgrade
 *   /app/credits                       credit packs (hosted checkout) and payment return
 *   /api/v1/payment-webhooks/<provider> signed Paddle / Stripe webhooks
 *   plus the JSON endpoints those pages call
 *
 * An app that ships its own page for one of these patterns lists it in `skip`, so the shell never
 * injects it. Relying on route priority alone is not enough: the shell's page can win over the app's.
 */
export default function appShell(options: { skip?: string[] } = {}): AstroIntegration {
  const skip = new Set(options.skip ?? []);
  return {
    name: "@templatedesign/app-shell",
    hooks: {
      "astro:config:setup": ({ injectRoute: inject }) => {
        const injectRoute: typeof inject = (route) => {
          if (!skip.has(route.pattern)) inject(route);
        };
        injectRoute({ pattern: "/onboarding", entrypoint: page("onboarding.astro") });
        injectRoute({ pattern: "/[ws]/admin/settings/branding", entrypoint: page("branding.astro") });
        injectRoute({ pattern: "/[ws]/admin/members", entrypoint: page("members.astro") });
        injectRoute({ pattern: "/api/shell/workspaces", entrypoint: page("api/workspaces.ts") });
        injectRoute({ pattern: "/[ws]/admin/api/branding", entrypoint: page("api/branding.ts") });
        injectRoute({ pattern: "/[ws]/admin/api/members", entrypoint: page("api/members.ts") });
        injectRoute({ pattern: "/brand/[...path]", entrypoint: page("brand/serve.ts") });
        injectRoute({ pattern: "/[ws]/admin/billing", entrypoint: page("billing.astro") });
        injectRoute({ pattern: "/[ws]/admin/api/billing", entrypoint: page("api/billing.ts") });
        injectRoute({ pattern: "/pricing", entrypoint: page("pricing.astro") });
        injectRoute({ pattern: "/app/credits", entrypoint: page("credits.astro") });
        injectRoute({ pattern: "/app/credits/return", entrypoint: page("credits.astro") });
        injectRoute({ pattern: "/api/shell/checkout", entrypoint: page("api/checkout.ts") });
        injectRoute({ pattern: "/api/v1/payment-webhooks/[provider]", entrypoint: page("api/payment-webhook.ts") });
      },
    },
  };
}
