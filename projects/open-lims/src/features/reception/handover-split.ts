/**
 * Analysis tasks are created only by {@code POST /samples/{code}/split} (FR-RCV-015).
 * DELIVER/RECEIVE do not mint them. After lab RECEIVE the handover screen must offer that split
 * — driving from {@code nextStep: SPLIT} so a reload still works, not from in-memory «đã nhận».
 */

const POST_RECEIVE_STEPS = new Set(["SPLIT", "SPLIT_VIAL", "DONE"]);
const SPLIT_DONE_STEPS = new Set(["SPLIT_VIAL", "DONE"]);

export function handoverLabReceived(input: {
  nextStepCode?: string;
  receivedThisSession?: boolean;
}): boolean {
  if (input.receivedThisSession) return true;
  return Boolean(input.nextStepCode && POST_RECEIVE_STEPS.has(input.nextStepCode));
}

export function handoverAlreadySplit(input: {
  subSampleCount?: number;
  sampleStatus?: string;
  nextStepCode?: string;
}): boolean {
  if ((input.subSampleCount ?? 0) > 0) return true;
  if (input.sampleStatus === "SPLIT") return true;
  return Boolean(input.nextStepCode && SPLIT_DONE_STEPS.has(input.nextStepCode));
}

/** Lab may split on this screen: RECEIVE is done, vials do not exist yet, and they hold split. */
export function handoverShouldOfferSplit(input: {
  canSplit: boolean;
  parentSampleCode?: string;
  nextStepCode?: string;
  receivedThisSession?: boolean;
  sampleStatus?: string;
  subSampleCount?: number;
}): boolean {
  if (!input.canSplit || !input.parentSampleCode?.trim()) return false;
  if (handoverAlreadySplit(input)) return false;
  return handoverLabReceived(input);
}

/** Default child count is the quantity chốt at reception so a matching split needs no reason. */
export function defaultHandoverSplitCount(
  actualQuantity?: number,
  declaredQuantity?: number,
): number | undefined {
  if (isPositiveInt(actualQuantity)) return actualQuantity;
  if (isPositiveInt(declaredQuantity)) return declaredQuantity;
  return undefined;
}

export function handoverSplitNeedsReason(count: number, actualQuantity?: number): boolean {
  return actualQuantity !== undefined && count !== actualQuantity;
}

function isPositiveInt(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
