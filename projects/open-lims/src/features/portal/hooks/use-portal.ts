import { useQuery } from "@tanstack/react-query";
import { createQueryKeys } from "@/lib/api";
import { portalApi } from "../api";
import type { PublicReportLookupOptions } from "../types";

export const portalKeys = createQueryKeys("public-reports");

export function usePublicReport(
  reportCode: string,
  options: PublicReportLookupOptions = {},
  enabled = true,
) {
  return useQuery({
    queryKey: portalKeys.detail(`${reportCode}:${options.language ?? "vi"}`),
    queryFn: () => portalApi.lookup(reportCode, options),
    enabled: enabled && Boolean(reportCode),
  });
}
