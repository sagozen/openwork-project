/**
 * Renderer contracts for the KDP book profiles. `PROFILE` in the package root stays
 * certificate-only, so existing callers cannot accidentally accept a book envelope.
 */

export const BOOK_PROFILE = "book-v1" as const;
export const BOOK_COVER_PROFILE = "book-cover-v1" as const;

export type BookProfile = typeof BOOK_PROFILE | typeof BOOK_COVER_PROFILE;
export type BookTrim = "6x9" | "8.5x11" | "Letter" | "A4";
export type BookPaper = "white" | "cream";
export type BookAlign = "left" | "center" | "right" | "justify";

export interface BookTypography {
  family?: string;
  /** Reading text size in points. The renderer enforces a 7 pt floor. */
  bodyPt: number;
  headingPt: number;
}

export interface BookCell {
  svg?: string;
  text?: string;
}

export type BookBlock =
  | { type: "heading"; level?: number; text: string; align?: BookAlign; keepWithNext?: boolean; fontSize?: number }
  | { type: "paragraph"; text: string; align?: BookAlign; keepWithNext?: boolean; fontSize?: number }
  | { type: "list"; items: string[]; columns?: number; keepWithNext?: boolean; fontSize?: number }
  | {
      type: "svg";
      /** Sanitized SVG markup. Scripts, images and external URLs are rejected by the renderer. */
      svg: string;
      /** Width in inches, or "fill". */
      width?: number | "fill";
      align?: BookAlign;
      keepWithNext?: boolean;
    }
  | { type: "image"; asset: string; width?: number | "fill"; align?: BookAlign }
  | { type: "grid"; cells: BookCell[][]; columns?: number; border?: boolean }
  /** Vertical space in inches. */
  | { type: "spacer"; gap?: number }
  | { type: "pagebreak" }
  | { type: "blankPage" };

export interface BookSection {
  id?: string;
  numbering?: "none" | "roman" | "arabic";
  /** The section must begin on a recto; the renderer inserts the blank verso if needed. */
  startOnRight?: boolean;
  /** The page the contents page printed. A mismatch fails with `layout.section_start_mismatch`. */
  expectedStartPage?: number;
  blocks: BookBlock[];
}

export interface BookEnvelope {
  profile: typeof BOOK_PROFILE;
  trim: BookTrim;
  /** Letter and A4 only: no mirrored gutter and a 0.5 in margin, for Etsy printables. */
  printable?: boolean;
  paper?: BookPaper;
  bleed?: false;
  /** Expected final page count; a mismatch fails with `layout.page_count_mismatch`. */
  pageCount: number;
  typography: BookTypography;
  sections: BookSection[];
}

export interface BookCoverEnvelope {
  profile: typeof BOOK_COVER_PROFILE;
  trim: BookTrim;
  paper?: BookPaper;
  /** Interior page count. Drives the spine width and the 79-page spine-text rule. */
  pageCount: number;
  typography: BookTypography;
  front: BookBlock[];
  back: BookBlock[];
  spine: BookBlock[];
}

export type BookEnvelopeAny = BookEnvelope | BookCoverEnvelope;

export function isBookEnvelope(value: { profile?: string }): value is BookEnvelopeAny {
  return value.profile === BOOK_PROFILE || value.profile === BOOK_COVER_PROFILE;
}

/** Spine width in inches, matching the renderer's KDP table. */
export function spineInches(pages: number, paper: BookPaper = "white"): number {
  const factor = paper === "cream" ? 0.0025 : 0.002252;
  return pages * factor;
}

/** Full wrap width and height in inches, with 0.125 in bleed on the outside edges. */
export function coverSizeInches(
  trimWidthIn: number,
  trimHeightIn: number,
  pages: number,
  paper: BookPaper = "white",
): { width: number; height: number; spine: number } {
  const spine = spineInches(pages, paper);
  return { width: 0.125 + trimWidthIn + spine + trimWidthIn + 0.125, height: trimHeightIn + 0.25, spine };
}

/** KDP refuses spine text below 79 pages. */
export function spineTextAllowed(pages: number): boolean {
  return pages >= 79;
}
