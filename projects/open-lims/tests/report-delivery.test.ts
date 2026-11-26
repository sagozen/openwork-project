import { describe, expect, test } from "bun:test";
import {
  selectDeliveryReport,
  selectDeliverySample,
} from "../src/features/report/select-delivery-report";
import type { ReportVersion } from "../src/features/report/types";
import type { RequestedSample } from "../src/features/request/types";

const approved: RequestedSample = {
  code: "26100002",
  status: { code: "HANDED_OVER", name: "Đã bàn giao lab", tone: "info" },
};
const pending: RequestedSample = {
  code: "26100001",
  status: { code: "IN_TRANSIT", name: "Đang vận chuyển", tone: "info" },
};
const report = (
  id: string,
  sampleCode: string,
  version: number,
  current = true,
): ReportVersion => ({
  id,
  sampleCode,
  version,
  current,
  reportCode: `KQ-${sampleCode}`,
  status: { code: "PENDING_SIGNATURE", name: "Chờ ký", tone: "warning" },
  templateVersion: "1",
  legalProfileVersion: "1",
  hasSignedScan: false,
});

describe("delivery sample context", () => {
  test("keeps explicit sample context and never substitutes an unknown deep link", () => {
    expect(selectDeliverySample([pending, approved], pending.code!)?.code).toBe(pending.code);
    expect(selectDeliverySample([pending, approved], "foreign")).toBeUndefined();
    expect(selectDeliverySample([{ product: "Draft" }], "")).toBeUndefined();
  });
  test("current is per sample, not per request", () => {
    const sibling = report("sibling", pending.code!, 4);
    const own = report("own", approved.code!, 1);
    expect(selectDeliveryReport([sibling, own], approved.code, undefined)?.id).toBe("own");
    expect(selectDeliveryReport([sibling], approved.code, undefined)).toBeUndefined();
    expect(selectDeliveryReport([sibling, own], undefined, undefined)).toBeUndefined();
  });
  test("selects historical versions only within the selected family", () => {
    const old = report("old", approved.code!, 1, false);
    const current = report("current", approved.code!, 2);
    const sibling = report("sibling", pending.code!, 3);
    expect(selectDeliveryReport([sibling, old, current], approved.code, "old")?.id).toBe("old");
    expect(selectDeliveryReport([sibling, old, current], approved.code, "sibling")?.id).toBe(
      "current",
    );
    expect(
      selectDeliveryReport(
        [current, old].map((item) => ({ ...item, current: false })),
        approved.code,
        undefined,
      )?.id,
    ).toBe("current");
  });
  test("keeps historic dossier PDFs separate from every sample family", () => {
    const legacy = { ...report("legacy", "", 1), sampleCode: undefined };
    const own = report("own", approved.code!, 2);
    expect(selectDeliveryReport([legacy, own], null, undefined)?.id).toBe("legacy");
    expect(selectDeliveryReport([legacy], approved.code, undefined)).toBeUndefined();
    expect(selectDeliveryReport([legacy, own], undefined, undefined)).toBeUndefined();
  });
});
