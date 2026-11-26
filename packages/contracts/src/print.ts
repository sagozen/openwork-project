/**
 * The print profile. A print template is an uploaded, print-ready PDF plus fields in
 * millimetres. The source PDF stays untouched; the renderer overlays text and images.
 */

export const PRINT_PROFILE = "print-pdf-v1" as const;

export type PrintFieldType = "text" | "image";
export type PrintFit = "shrink" | "wrap" | "fail";

export interface PrintField {
  name: string;
  type: PrintFieldType;
  /** Millimetres from the top-left corner of the page. */
  position: { x: number; y: number };
  width: number;
  height: number;
  content?: string;
  fontName?: string;
  fontSize?: number;
  fontColor?: string;
  alignment?: "left" | "center" | "right";
  verticalAlignment?: "top" | "middle" | "bottom";
  lineHeight?: number;
  /** R2 key for a fixed image; order images use source.imageAssets instead. */
  asset?: string;
  td?: {
    field?: string;
    fit?: PrintFit;
    maxLength?: number;
    required?: boolean;
    /** Hex colour painted over the field box before text (hides a {{token}}). */
    cover?: string;
  };
}

export interface PdfPreflightReport {
  pdfx: boolean;
  color: "cmyk" | "rgb" | "mixed" | "unknown";
  fontsEmbedded: boolean;
  bytes: number;
  pageCount?: number;
}

export interface PrintCover {
  /** R2 key of the full-wrap cover PDF. The spine is part of this file. */
  asset: string;
  /** One array per cover page; normally one page for a full wrap. */
  schemas: PrintField[][];
  pageCount: number;
  widthMm: number;
  heightMm: number;
  /** Spine width the cover file was designed for, in millimetres. */
  spineMm?: number;
  /** Pre-cropped parts for a dynamic spine. */
  parts?: {
    back: string;
    spine: string;
    front: string;
  };
  trimWidthMm?: number;
  trimHeightMm?: number;
  bleedMm?: number;
  /** Paper thickness per sheet, in millimetres. */
  paperCaliperMm?: number;
}

export type PrintPart = "interior" | "cover";

export interface PrintTemplate {
  profile: typeof PRINT_PROFILE;
  source: {
    /** R2 key of the uploaded print-ready PDF. */
    asset: string;
    /** field name -> R2 key of a customer image, injected per order. */
    imageAssets?: Record<string, string>;
    /** One array per PDF page; the designer pads this to the source page count. */
    schemas: PrintField[][];
  };
  td: {
    inputSchema: Record<string, unknown>;
    sampleData?: Record<string, unknown>;
  };
  /** Optional full-wrap cover, edited and rendered as its own file. */
  cover?: PrintCover;
}

export interface PrintTemplateMeta {
  id: string;
  title: string;
  pageCount: number;
  pageWidthMm: number;
  pageHeightMm: number;
  coverPageCount?: number | null;
  coverWidthMm?: number | null;
  coverHeightMm?: number | null;
  coverSpineMm?: number | null;
  preflight?: { interior: PdfPreflightReport; cover?: PdfPreflightReport };
  revision: number;
  defaultVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrintOrder {
  id: string;
  externalId: string;
  part: PrintPart;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  templateId: string;
  templateVersion: number;
  jobId: string;
  pages: number | null;
  spineMm: number | null;
  preflight: Array<{ code: string; message: string; severity: string }> | null;
  credits: { reserved: number; charged: number; released: number };
  downloadUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
  error: { code: string; detail: string } | null;
}

export function isPrintTemplate(value: unknown): value is PrintTemplate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PrintTemplate>;
  return (
    candidate.profile === PRINT_PROFILE &&
    Boolean(candidate.source) &&
    typeof candidate.source?.asset === "string" &&
    Array.isArray(candidate.source?.schemas)
  );
}

export function printFields(template: PrintTemplate): PrintField[] {
  return [...template.source.schemas.flat(), ...(template.cover?.schemas.flat() ?? [])];
}

export function printPartFields(template: PrintTemplate, part: PrintPart): PrintField[] {
  return (part === "cover" ? template.cover?.schemas.flat() : template.source.schemas.flat()) ?? [];
}

/** Derive a JSON schema from the field names. Every text field is a string; images are asset ids. */
export function printInputSchema(template: PrintTemplate): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const field of printFields(template)) {
    const key = field.td?.field ?? field.name;
    if (!key) continue;
    properties[key] = {
      type: "string",
      ...(field.td?.maxLength ? { maxLength: field.td.maxLength } : {}),
      ...(field.type === "image" ? { description: "Print asset id" } : {}),
    };
    if (field.td?.required) required.add(key);
  }
  return { type: "object", properties, required: [...required] };
}
