import type { Locale, PublicSite } from "@mytutor/plugin-mytutor-lms/model";
import en from "./en.json";
import vi from "./vi.json";

// Student interface strings. Course content is the creator's own and is never
// translated here. Spanish arrives with phase 03; until then an "es" site or
// visitor sees English.
export type UiLocale = "vi" | "en";
export type MessageKey = keyof typeof en;
const CATALOGS: Record<UiLocale, Record<MessageKey, string>> = { en, vi };
export const UI_LOCALES = Object.keys(CATALOGS) as UiLocale[];
export const LOCALE_COOKIE = "mytutor_locale";
export const LOCALE_NAMES: Record<UiLocale, string> = {
  vi: "Tiếng Việt",
  en: "English",
};

export const isUiLocale = (value: unknown): value is UiLocale =>
  typeof value === "string" && Object.hasOwn(CATALOGS, value);

export type Translate = (
  key: MessageKey,
  values?: Record<string, string | number>,
) => string;

/**
 * Returns `t(key, values)`. `{name}` placeholders are filled from `values`;
 * a key with `.one` and `.other` forms picks one by `values.count`.
 */
export function translator(locale: UiLocale): Translate {
  const catalog = CATALOGS[locale] ?? CATALOGS.en;
  return (key, values = {}) => {
    let message: string = catalog[key] ?? CATALOGS.en[key] ?? key;
    if (typeof values.count === "number") {
      const rule = new Intl.PluralRules(locale).select(values.count);
      const form = `${key}.${rule === "one" ? "one" : "other"}` as MessageKey;
      message = catalog[form] ?? message;
    }
    return message.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in values ? String(values[name]) : match,
    );
  };
}

/** The interface locale: the visitor's choice, else the site default. */
export function chooseLocale(
  site: Pick<PublicSite, "locales" | "defaultLocale"> | null,
  requested: string | undefined,
): UiLocale {
  const enabled = (site?.locales ?? ["vi", "en"]).filter(isUiLocale);
  if (isUiLocale(requested) && enabled.includes(requested)) return requested;
  const fallback: Locale = site?.defaultLocale ?? "vi";
  return isUiLocale(fallback) ? fallback : "en";
}
