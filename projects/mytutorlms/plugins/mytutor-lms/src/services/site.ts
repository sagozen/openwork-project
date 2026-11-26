import { z } from "zod";
import type { PublicSite, SiteSettings } from "../model.js";
import { DomainError, link, readRecord, text } from "../validation.js";
import { isReadableAccent } from "../design/contrast.js";
import type { DomainCollection } from "./shared.js";

const localeSchema = z.enum(["vi", "en", "es"]);
const emailOrEmpty = z.union([z.literal(""), z.email().max(254)]);
export const siteSettingsSchema = z
  .strictObject({
    siteId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    accentColor: z.string().regex(/^oklch\([0-9. %/]+\)$/),
    locales: z.array(localeSchema).min(1).max(3),
    defaultLocale: localeSchema,
    supportEmail: emailOrEmpty,
    legal: z.strictObject({ termsUrl: link, privacyUrl: link }),
    emailFrom: z.strictObject({
      name: text(120),
      address: emailOrEmpty,
      replyTo: emailOrEmpty,
    }),
    selfSignup: z.boolean(),
    instructorsMayGrant: z.boolean(),
    passkeysEnabled: z.boolean(),
    dailySignInEmailCap: z.number().int().min(1).max(100_000),
    features: z.record(
      z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/),
      z.boolean(),
    ),
  })
  .refine((site) => site.locales.includes(site.defaultLocale), {
    path: ["defaultLocale"],
    message: "The default language must be one of the site languages.",
  })
  .refine((site) => new Set(site.locales).size === site.locales.length, {
    path: ["locales"],
  });
const storedSiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  settings: siteSettingsSchema,
  updatedAt: z.number().int().min(0),
});
// Contrast is checked when settings are saved, never when they are read, so
// a site saved before the check existed keeps working (the theme falls back
// to the default accent for it).
export const saveSiteSchema = z.strictObject({
  revision: z.string().min(1).max(512).nullable(),
  value: siteSettingsSchema.refine(
    (site) => isReadableAccent(site.accentColor),
    {
      path: ["accentColor"],
      message:
        "Choose a darker accent. Buttons and links need 4.5:1 contrast against the page.",
    },
  ),
});

const SITE_KEY = "site";
/** Defaults used until the owner saves settings; VI first per owner decision 2. */
export function defaultSite(siteId: string): SiteSettings {
  return {
    siteId,
    accentColor: "oklch(0.38 0.07 155)",
    locales: ["vi", "en"],
    defaultLocale: "vi",
    supportEmail: "",
    legal: { termsUrl: "", privacyUrl: "" },
    emailFrom: { name: "", address: "", replyTo: "" },
    selfSignup: true,
    instructorsMayGrant: false,
    // Passkeys stay off until the WebAuthn gate (V2) passes on real devices.
    passkeysEnabled: false,
    dailySignInEmailCap: 500,
    features: {},
  };
}
/** Stable site slug from the canonical host, used until the owner saves settings. */
export function siteIdFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const slug = host.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return (slug || "site").slice(0, 63);
  } catch {
    return "site";
  }
}

export class SiteService {
  constructor(
    private readonly sites: DomainCollection,
    private readonly fallbackSiteId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<{ settings: SiteSettings; revision: string | null }> {
    const record = await this.sites.getVersioned(SITE_KEY);
    if (!record)
      return { settings: defaultSite(this.fallbackSiteId), revision: null };
    return {
      settings: readRecord(storedSiteSchema, record.value).settings,
      revision: record.revision,
    };
  }

  async save(input: z.infer<typeof saveSiteSchema>) {
    const current = await this.get();
    if (current.revision !== input.revision)
      throw new DomainError(
        "CONFLICT",
        "Site settings changed. Reload before saving.",
      );
    // The site ID names backups and deploy config; it never changes once saved.
    if (current.revision && input.value.siteId !== current.settings.siteId)
      throw new DomainError("VALIDATION", "The site ID cannot be changed.");
    const saved = await this.sites.compareAndSet(SITE_KEY, input.revision, {
      schemaVersion: 1,
      settings: input.value,
      updatedAt: this.now(),
    });
    if (!saved.applied)
      throw new DomainError(
        "CONFLICT",
        "Site settings changed. Reload before saving.",
      );
    return {
      before: current.settings,
      settings: input.value,
      revision: saved.revision,
    };
  }

  /** Unknown feature names are off. */
  async isFeatureEnabled(name: string): Promise<boolean> {
    return (await this.get()).settings.features[name] === true;
  }

  async publicSite(info: { name: string; url: string }): Promise<PublicSite> {
    const { settings } = await this.get();
    return {
      name: info.name,
      url: info.url,
      accentColor: settings.accentColor,
      locales: settings.locales,
      defaultLocale: settings.defaultLocale,
      supportEmail: settings.supportEmail,
      legal: settings.legal,
      selfSignup: settings.selfSignup,
      passkeysEnabled: settings.passkeysEnabled,
    };
  }
}
