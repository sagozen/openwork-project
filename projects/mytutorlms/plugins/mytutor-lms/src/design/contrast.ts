// WCAG contrast for the oklch() colours the design tokens use. Shared by the
// token tests, the site settings guardrail and the theme's accent override.

const OKLCH =
  /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*[\d.]+%?\s*)?\)$/;

/** Light-scheme surfaces an accent must stand out against (tokens.css). */
export const LIGHT_BACKGROUNDS = [
  "oklch(0.975 0.009 85)",
  "oklch(0.995 0.003 85)",
];
export const LIGHT_ON_ACCENT = "oklch(0.985 0.006 85)";

export function luminance(color: string): number | null {
  const match = OKLCH.exec(color.trim());
  if (!match) return null;
  const lightness = Number(match[1]) / (match[2] ? 100 : 1);
  const chroma = Number(match[3]);
  const hue = (Number(match[4]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const red = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(first: string, second: string): number {
  const one = luminance(first);
  const two = luminance(second);
  if (one === null || two === null) return 0;
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

/**
 * True when a creator's accent keeps buttons and links readable in the light
 * scheme: 4.5:1 against the page and card backgrounds and for button text.
 */
export function isReadableAccent(color: string): boolean {
  return (
    LIGHT_BACKGROUNDS.every((bg) => contrastRatio(color, bg) >= 4.5) &&
    contrastRatio(LIGHT_ON_ACCENT, color) >= 4.5
  );
}
