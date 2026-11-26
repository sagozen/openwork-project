import { createApiClient } from "@/lib/api";
import type { PublicPdfDisposition, PublicReportLookup, PublicReportLookupOptions } from "../types";

// Deliberately anonymous: this client has no token provider and every request
// explicitly disables authentication so no Authorization header can be emitted.
const anonymousApi = createApiClient();
const publicReportPath = (reportCode: string) =>
  `/public/reports/${encodeURIComponent(reportCode)}`;

function lookupOptions(options: PublicReportLookupOptions) {
  const headers = new Headers();
  if (options.language) headers.set("Accept-Language", options.language);
  if (options.turnstileToken) headers.set("X-Turnstile-Token", options.turnstileToken);
  return { authenticated: false as const, headers };
}

export const portalApi = {
  lookup: (reportCode: string, options: PublicReportLookupOptions = {}) => {
    const query = options.language ? `?lang=${options.language}` : "";
    return anonymousApi.get<PublicReportLookup>(
      `/public/lookup/${encodeURIComponent(reportCode)}${query}`,
      lookupOptions(options),
    );
  },
  pdf: (
    reportCode: string,
    disposition: PublicPdfDisposition,
    options: PublicReportLookupOptions = {},
  ) =>
    anonymousApi.getBlob(
      `${publicReportPath(reportCode)}/pdf?disposition=${disposition}`,
      lookupOptions(options),
    ),
};
