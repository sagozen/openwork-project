import { describe, expect, test } from "bun:test";
import {
  defaultHandoverSplitCount,
  handoverAlreadySplit,
  handoverLabReceived,
  handoverShouldOfferSplit,
  handoverSplitNeedsReason,
} from "../src/features/reception/handover-split";

describe("handoverLabReceived", () => {
  test("is true after this session's RECEIVE confirm, even before context refetches", () => {
    expect(handoverLabReceived({ receivedThisSession: true, nextStepCode: "RECEIVE" })).toBe(true);
  });

  test("is true from durable nextStep after reload", () => {
    expect(handoverLabReceived({ nextStepCode: "SPLIT" })).toBe(true);
    expect(handoverLabReceived({ nextStepCode: "RECEIVE" })).toBe(false);
  });
});

describe("handoverAlreadySplit", () => {
  test("is true once child samples exist", () => {
    expect(handoverAlreadySplit({ subSampleCount: 2, nextStepCode: "SPLIT" })).toBe(true);
  });

  test("is false after RECEIVE before split", () => {
    expect(
      handoverAlreadySplit({
        subSampleCount: 0,
        nextStepCode: "SPLIT",
        sampleStatus: "HANDED_OVER",
      }),
    ).toBe(false);
  });
});

describe("handoverShouldOfferSplit", () => {
  const ready = {
    canSplit: true,
    parentSampleCode: "2610002201",
    nextStepCode: "SPLIT",
    sampleStatus: "HANDED_OVER",
    subSampleCount: 0,
  };

  test("offers split after lab RECEIVE when no child samples exist yet", () => {
    expect(handoverShouldOfferSplit(ready)).toBe(true);
  });

  test("still offers split after a reload (no in-memory confirm)", () => {
    expect(handoverShouldOfferSplit({ ...ready, receivedThisSession: false })).toBe(true);
  });

  test("does not wait for this-session confirm when nextStep is already SPLIT", () => {
    expect(
      handoverShouldOfferSplit({ ...ready, receivedThisSession: false, nextStepCode: "SPLIT" }),
    ).toBe(true);
  });

  test("hides the form once vials exist so the screen can print task labels", () => {
    expect(
      handoverShouldOfferSplit({ ...ready, subSampleCount: 1, nextStepCode: "SPLIT_VIAL" }),
    ).toBe(false);
  });

  test("offers split in the gap after this-session RECEIVE before nextStep refetches", () => {
    expect(
      handoverShouldOfferSplit({
        ...ready,
        nextStepCode: "RECEIVE",
        receivedThisSession: true,
      }),
    ).toBe(true);
  });

  test("does not offer split before RECEIVE", () => {
    expect(
      handoverShouldOfferSplit({
        ...ready,
        nextStepCode: "RECEIVE",
        sampleStatus: "RECEIVED",
        receivedThisSession: false,
      }),
    ).toBe(false);
  });

  test("does not offer split without the split permission", () => {
    expect(handoverShouldOfferSplit({ ...ready, canSplit: false })).toBe(false);
  });
});

describe("defaultHandoverSplitCount", () => {
  test("prefers the quantity chốt at reception", () => {
    expect(defaultHandoverSplitCount(3, 5)).toBe(3);
  });

  test("falls back to declared quantity when actual is missing", () => {
    expect(defaultHandoverSplitCount(undefined, 2)).toBe(2);
  });
});

describe("handoverSplitNeedsReason", () => {
  test("requires a reason only when the count disagrees with the chốt quantity", () => {
    expect(handoverSplitNeedsReason(3, 3)).toBe(false);
    expect(handoverSplitNeedsReason(4, 3)).toBe(true);
    expect(handoverSplitNeedsReason(1, undefined)).toBe(false);
  });
});
