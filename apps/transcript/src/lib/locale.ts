import type { Locale } from "@templatedesign/platform/types";

/** Page locale comes from the `td_locale` cookie set by the header switcher. */
export function pageLocale(cookies: { get(name: string): { value: string } | undefined }): Locale {
  return cookies.get("td_locale")?.value === "vi" ? "vi" : "en";
}
