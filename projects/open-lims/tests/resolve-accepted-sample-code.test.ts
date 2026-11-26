import { describe, expect, test } from "bun:test";
import { resolveAcceptedSampleCode } from "../src/features/reception/resolve-accepted-sample-code";

describe("resolveAcceptedSampleCode", () => {
  test("returns no code before the route has loaded a request or mutation result", () => {
    expect(resolveAcceptedSampleCode(undefined, undefined)).toBeUndefined();
  });

  test("returns the accepted parent code for the selected request", () => {
    expect(
      resolveAcceptedSampleCode(
        {
          requestCode: "26100022",
          sample: {
            code: "2610002201",
            level: "PARENT",
            status: { code: "RECEIVED", name: "Đã tiếp nhận", tone: "success" },
          },
          subSamples: [],
          analysisTasks: [],
        },
        "26100022",
      ),
    ).toBe("2610002201");
  });

  test("ignores a mutation result left over from another selected request", () => {
    expect(
      resolveAcceptedSampleCode(
        {
          requestCode: "26100021",
          sample: {
            code: "2610002101",
            level: "PARENT",
            status: { code: "RECEIVED", name: "Đã tiếp nhận", tone: "success" },
          },
          subSamples: [],
          analysisTasks: [],
        },
        "26100022",
      ),
    ).toBeUndefined();
  });
});
