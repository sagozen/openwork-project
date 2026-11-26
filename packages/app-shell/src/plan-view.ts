import { type PlanDefinition, platformConfig } from "@templatedesign/platform/config";

export interface PlanRow {
  id: string;
  name: string;
  priceCredits: number | null;
  periodDays: number;
  features: Array<{ key: string; label: string; value: string }>;
}

/** `orders.perMonth` -> `Orders per month`; dotted keys read as a sentence. */
export function featureLabel(key: string): string {
  const spaced = key
    .replace(/\.perMonth$/, " per month")
    .replace(/[._]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function featureValue(value: number | boolean): string {
  if (value === true) return "Included";
  if (value === false || value === 0) return "Not included";
  if (value === -1) return "Unlimited";
  return value.toLocaleString("en-US");
}

/** The configured plans, free first, in a shape the pricing and billing pages can render directly. */
export function planRows(): PlanRow[] {
  const plans = platformConfig().plans ?? {};
  const toRow = ([id, plan]: [string, PlanDefinition]): PlanRow => ({
    id,
    name: plan.name,
    priceCredits: plan.priceCredits ?? null,
    periodDays: plan.periodDays ?? 30,
    features: Object.entries(plan.entitlements).map(([key, value]) => ({
      key,
      label: featureLabel(key),
      value: featureValue(value),
    })),
  });
  return Object.entries(plans)
    .sort(([a], [b]) => (a === "free" ? -1 : b === "free" ? 1 : a.localeCompare(b)))
    .map(toRow);
}
