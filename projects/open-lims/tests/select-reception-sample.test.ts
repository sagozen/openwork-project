import { describe, expect, test } from "bun:test";
import { selectReceptionSample } from "../src/features/reception/select-reception-sample";
import type { RequestedSample } from "../src/features/request/types";

const received: RequestedSample = {
  code: "26100001",
  product: "Mẫu đã nhận",
  status: { code: "RECEIVED", name: "Đã tiếp nhận", tone: "success" },
};
const pending: RequestedSample = {
  code: "26100002",
  product: "Mẫu chưa nhận",
  status: { code: "IN_TRANSIT", name: "Đang vận chuyển", tone: "info" },
};

describe("reception sample selection", () => {
  test("opens the pending sibling instead of the first already received sample", () => {
    expect(selectReceptionSample([received, pending], "")?.code).toBe(pending.code);
  });

  test("keeps the explicitly selected sample after its reception decision", () => {
    expect(selectReceptionSample([received, pending], received.code!)?.code).toBe(received.code);
  });

  test("opens a sample matching the queue filter without hiding other samples", () => {
    expect(selectReceptionSample([pending, received], "", "RECEIVED")?.code).toBe(received.code);
    expect(selectReceptionSample([received, pending], "", "AWAITING_CHECK")?.code).toBe(pending.code);
    expect(selectReceptionSample([pending, received], pending.code!, "RECEIVED")?.code).toBe(pending.code);
  });

  test("discards a selection from another dossier and never selects an uncoded draft", () => {
    expect(selectReceptionSample([{ product: "Nháp" }, pending], received.code!)?.code).toBe(pending.code);
    expect(selectReceptionSample([{ product: "Nháp" }], "")).toBeUndefined();
  });
});
