import type { RequestedSample } from "../request/types";
import type { ReportVersion } from "./types";

/** A deep link is authoritative: never silently switch an unknown sample to a sibling. */
export function selectDeliverySample(
  samples: RequestedSample[],
  sampleCode: string,
): RequestedSample | undefined {
  if (sampleCode) return samples.find((sample) => sample.code === sampleCode);
  return samples.find((sample) => sample.code);
}

/** `current` is per sample; aggregate request reports may have several current versions. */
export function selectDeliveryReport(
  reports: ReportVersion[],
  sampleCode: string | null | undefined,
  reportId: string | undefined,
): ReportVersion | undefined {
  if (sampleCode === undefined || sampleCode === "") return undefined;
  const family = reports.filter((report) =>
    sampleCode === null ? !report.sampleCode : report.sampleCode === sampleCode,
  );
  return (
    family.find((report) => report.id === reportId) ??
    family.find((report) => report.current) ??
    family.reduce<ReportVersion | undefined>(
      (latest, report) => (!latest || report.version > latest.version ? report : latest),
      undefined,
    )
  );
}
