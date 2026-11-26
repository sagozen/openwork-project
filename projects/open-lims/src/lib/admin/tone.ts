import type { Tone } from "@/lib/api";

export function toneToColor(
  tone: Tone | string,
): "success" | "warning" | "danger" | "brand" | "informative" | "important" {
  if (tone === "success") return "success";
  if (tone === "warning") return "warning";
  if (tone === "danger") return "danger";
  if (tone === "brand") return "brand";
  if (tone === "important") return "important";
  return "informative";
}
