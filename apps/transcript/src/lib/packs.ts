import type { CreditPack as PlatformCreditPack } from "@templatedesign/platform/config";

export interface CreditPack extends PlatformCreditPack {
  id: "starter" | "builder" | "scale";
}

/**
 * The platform pack prices, kept identical to templatedesign so one price list exists for
 * both products. At 3 credits per minute that is $0.030 / $0.021 / $0.019 per minute
 * (phase 6 of the plan). Credits are the unit of account everywhere; minutes are derived.
 */
export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", name: { en: "Starter", vi: "Starter" }, priceCents: 1000, credits: 1000 },
  { id: "builder", name: { en: "Builder", vi: "Builder" }, priceCents: 2000, credits: 2800, featured: true },
  { id: "scale", name: { en: "Scale", vi: "Scale" }, priceCents: 5000, credits: 8000 },
];

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function perMinuteCents(pack: CreditPack, creditsPerMinute: number): number {
  return (pack.priceCents / pack.credits) * creditsPerMinute;
}

export function packSummary(locale: "en" | "vi", creditsPerMinute: number) {
  return CREDIT_PACKS.map((pack) => ({
    ...pack,
    name: pack.name[locale],
    price: formatUsd(pack.priceCents),
    minutes: Math.floor(pack.credits / creditsPerMinute),
    perMinute: `$${(perMinuteCents(pack, creditsPerMinute) / 100).toFixed(3)}`,
  }));
}
