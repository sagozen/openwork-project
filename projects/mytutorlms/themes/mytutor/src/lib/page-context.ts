import type { PublicSite } from "@mytutor/plugin-mytutor-lms/model";
import { chooseLocale, LOCALE_COOKIE, type UiLocale } from "../i18n";
import { LEGACY_COOKIE, STUDENT_COOKIE } from "./bridge";
import { pluginCall } from "./lms";

export interface PageContext {
  site: PublicSite | null;
  locale: UiLocale;
  /** Which student session this browser holds, if any. */
  session: "account" | "invitation" | null;
}

type AstroLike = {
  request: Request;
  url: URL;
  locals: App.Locals;
  cookies: {
    get(name: string): { value: string } | undefined;
    has(name: string): boolean;
  };
};

// The page and its layout both ask; the site settings are read once a request.
const cache = new WeakMap<Request, Promise<PageContext>>();

export function pageContext(astro: AstroLike): Promise<PageContext> {
  let context = cache.get(astro.request);
  if (!context) {
    context = (async () => {
      const result = await pluginCall<PublicSite>(
        astro.locals,
        astro.url,
        "site",
      );
      const site = result.ok ? result.data : null;
      return {
        site,
        locale: chooseLocale(site, astro.cookies.get(LOCALE_COOKIE)?.value),
        session: astro.cookies.has(STUDENT_COOKIE)
          ? "account"
          : astro.cookies.has(LEGACY_COOKIE)
            ? "invitation"
            : null,
      };
    })();
    cache.set(astro.request, context);
  }
  return context;
}
