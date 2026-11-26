import type { StatusValue } from "@/lib/api";

export type PortalLanguage = "vi" | "en" | "zh";
export type PublicReportStatus = "VALID" | "SUPERSEDED" | "NOT_FOUND";
export type PublicPdfDisposition = "inline" | "attachment";

export interface PublicReportLookup {
  reportCode: string;
  status: StatusValue & { code: PublicReportStatus };
  releasedAt?: string;
  supersededAt?: string;
  currentReportCode?: string;
  pdf?: {
    previewUrl: string;
    downloadUrl: string;
  };
  queriedAt: string;
}

export interface PublicReportLookupOptions {
  language?: PortalLanguage;
  turnstileToken?: string;
}
