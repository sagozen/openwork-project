export interface PaletteColor {
  name: string;
  hex: string;
}

/** The parts of a brand kit that go into a prompt. */
export interface BrandStyle {
  name: string;
  stylePrompt: string;
  negativePrompt: string | null;
  palette: PaletteColor[];
  typography: string | null;
}

export interface ComposeInput {
  brand?: BrandStyle | null;
  /** What the caller asked for, in their own words. */
  prompt: string;
  /** Exact on-image text. Kept short; quoted so the model copies it. */
  text?: string;
  /** Extra direction for one variation in a series. */
  variation?: string;
}

export interface Composed {
  prompt: string;
  negativePrompt?: string;
}

const sentence = (value: string) => {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** Quotes in the exact text would end the quoted span early. */
const quoteSafe = (value: string) => value.replace(/"/g, "'").trim();

function brandParts(brand: BrandStyle | null | undefined): string[] {
  if (!brand) return [];
  const parts: string[] = [];
  if (brand.stylePrompt.trim()) parts.push(`Style: ${sentence(brand.stylePrompt)}`);
  if (brand.palette.length > 0) {
    parts.push(`Colour palette: ${brand.palette.map((color) => `${color.name} ${color.hex}`).join(", ")}.`);
  }
  if (brand.typography?.trim()) parts.push(`Typography: ${sentence(brand.typography)}`);
  return parts;
}

function textPart(text: string | undefined): string {
  const clean = text ? quoteSafe(text) : "";
  return clean ? `Text on image, exactly: "${clean}".` : "No text.";
}

/** Text to image: the request, the brand style, the palette, the type direction and the text rule. */
export function composeGenerate(input: ComposeInput): Composed {
  const parts = [sentence(input.prompt), ...brandParts(input.brand)];
  if (input.variation?.trim()) parts.push(`Variation: ${sentence(input.variation)}`);
  parts.push(textPart(input.text));
  return {
    prompt: parts.join(" "),
    negativePrompt: input.brand?.negativePrompt?.trim() || undefined,
  };
}

export interface ComposeEditInput extends ComposeInput {
  /** Images the caller supplied, in order. They come first in the reference list. */
  givenCount: number;
  /** Brand reference images appended after the supplied ones. */
  brandReferenceCount: number;
}

const range = (from: number, count: number) =>
  count === 1 ? `image ${from}` : `images ${from} to ${from + count - 1}`;

/**
 * Reference-based edit. Images are named by position: the ones the caller supplied first, then the
 * brand's reference images, which carry the style.
 */
export function composeEdit(input: ComposeEditInput): Composed {
  const lead =
    input.brandReferenceCount > 0
      ? `Using ${range(input.givenCount + 1, input.brandReferenceCount)} as the brand style reference${
          input.givenCount > 0 ? ` and ${range(1, input.givenCount)} as the subject` : ""
        }, `
      : input.givenCount > 0
        ? `Using ${range(1, input.givenCount)} as the reference, `
        : "";
  const instruction = input.prompt.trim();
  const body = lead + (lead ? instruction.charAt(0).toLowerCase() + instruction.slice(1) : instruction);
  const parts = [sentence(body), ...brandParts(input.brand)];
  if (input.variation?.trim()) parts.push(`Variation: ${sentence(input.variation)}`);
  if (input.text?.trim()) parts.push(textPart(input.text));
  return {
    prompt: parts.join(" "),
    negativePrompt: input.brand?.negativePrompt?.trim() || undefined,
  };
}
