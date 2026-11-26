import type { RequestedSample } from "@/features/request/types";

/** Keep an explicit selection; otherwise open a matching, unreceived sample first. */
export function selectReceptionSample(
  samples: RequestedSample[],
  chosenCode: string,
  status?: string,
): RequestedSample | undefined {
  const chosen = samples.find((sample) => sample.code && sample.code === chosenCode);
  if (chosen) return chosen;
  const sampleStatus =
    status === "AWAITING_CHECK" || status === "NOT_ARRIVED" ? "IN_TRANSIT" : status;
  if (sampleStatus) {
    const matching = samples.find((sample) => sample.code && sample.status?.code === sampleStatus);
    if (matching) return matching;
  }
  return (
    samples.find((sample) => sample.code && sample.status?.code === "IN_TRANSIT") ??
    samples.find((sample) => sample.code)
  );
}
