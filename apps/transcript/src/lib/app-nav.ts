import type { Locale } from "@templatedesign/platform/types";

/**
 * Product navigation for the signed-in shell. Labels are product copy, not design-system
 * keys: `packages/ui` ships templatedesign's wording and must not grow transcript strings.
 */
export function appNav(locale: Locale) {
  const vi = locale === "vi";
  return [
    { key: "dashboard", label: vi ? "Tổng quan" : "Dashboard", href: "/app", icon: "layout" as const },
    { key: "transcripts", label: vi ? "Bản ghi" : "Transcriptions", href: "/app/jobs", icon: "list" as const },
    { key: "credits", label: vi ? "Credit" : "Credits", href: "/app/credits", icon: "credit-card" as const },
    { key: "developers", label: vi ? "API" : "Developers", href: "/app/developers", icon: "key" as const },
    { key: "settings", label: vi ? "Cài đặt" : "Settings", href: "/app/settings", icon: "settings" as const },
  ];
}
