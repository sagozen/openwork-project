import { describe, expect, test } from "bun:test";
import { handoverLotItems, isHandoverWholeLotScan } from "../src/features/reception/handover-scan";

describe("isHandoverWholeLotScan", () => {
  const lot = {
    requestCode: "26100022",
    parentSampleCode: "2610002201",
    scanCodes: ["2610002201", "26100022"],
  };

  test("accepts the generated parent tem", () => {
    expect(isHandoverWholeLotScan("2610002201", lot)).toBe(true);
  });

  test("accepts the request code once the lot is identified as the generated parent", () => {
    expect(isHandoverWholeLotScan("26100022", lot)).toBe(true);
  });

  test("does not infer a parent label from a request-code suffix", () => {
    expect(isHandoverWholeLotScan("2610002201", { requestCode: "26100022" })).toBe(false);
  });

  test("rejects a code that does not belong to the lot", () => {
    expect(isHandoverWholeLotScan("2610002101", lot)).toBe(false);
  });
});

describe("handoverLotItems", () => {
  test("lists the sample code for scan-only handover", () => {
    expect(handoverLotItems({ parentSampleCode: "2610002201", subSamples: [] })).toEqual([
      { code: "2610002201", kind: "Mã mẫu" },
    ]);
  });

  test("keeps the sample code when historical sub-sample labels exist", () => {
    expect(
      handoverLotItems({
        parentSampleCode: "2610002201",
        subSamples: [{ code: "261000220101", index: 1 }],
      }),
    ).toEqual([{ code: "2610002201", kind: "Mã mẫu" }]);
  });
});
