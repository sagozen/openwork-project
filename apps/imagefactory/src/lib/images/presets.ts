import { billedMegapixels } from "./pricing";

/**
 * Size presets. Each one stays just under a whole megapixel boundary because the provider bills
 * every started megapixel: 992 x 992 is billed as 1 MP where 1024 x 1024 would be billed as 2 MP.
 * All sides are multiples of 8.
 */
export interface Preset {
  id: PresetId;
  label: string;
  width: number;
  height: number;
  use: string;
}

export type PresetId = "pin" | "pin_hd" | "square" | "blog_hero" | "cover_6x9";

export const PRESETS: Record<PresetId, Preset> = {
  pin: { id: "pin", label: "Pinterest pin", width: 816, height: 1224, use: "Standard 2:3 Pinterest pin" },
  pin_hd: { id: "pin_hd", label: "Pinterest pin (HD)", width: 1152, height: 1728, use: "Higher quality 2:3 pin" },
  square: { id: "square", label: "Square", width: 992, height: 992, use: "Instagram, social posts, thumbnails" },
  blog_hero: {
    id: "blog_hero",
    label: "Blog hero",
    width: 1280,
    height: 720,
    use: "16:9 blog featured image and social preview",
  },
  cover_6x9: {
    id: "cover_6x9",
    label: "Book cover 6x9",
    width: 1024,
    height: 1536,
    use: "KDP cover concept, 2:3. Not print-ready.",
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && value in PRESETS;
}

export interface ResolvedSize {
  width: number;
  height: number;
  preset?: PresetId;
}

/** A preset wins over explicit dimensions; neither means the pin default. */
export function resolveSize(input: { preset?: string; width?: number; height?: number }): ResolvedSize {
  if (input.preset !== undefined) {
    if (!isPresetId(input.preset)) throw new Error(`Unknown preset "${input.preset}".`);
    const preset = PRESETS[input.preset];
    return { width: preset.width, height: preset.height, preset: preset.id };
  }
  if (input.width !== undefined && input.height !== undefined) return { width: input.width, height: input.height };
  return { width: PRESETS.pin.width, height: PRESETS.pin.height, preset: "pin" };
}

export function describePreset(preset: Preset, creditsPerMp: number) {
  return {
    id: preset.id,
    label: preset.label,
    width: preset.width,
    height: preset.height,
    use: preset.use,
    megapixels_billed: billedMegapixels(preset.width, preset.height),
    credits_per_image: billedMegapixels(preset.width, preset.height) * creditsPerMp,
  };
}
