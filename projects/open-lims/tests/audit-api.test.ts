import { describe, expect, test } from "bun:test";
import { auditApi } from "../src/features/audit/api/audit-api";
import { flattenAuditPages } from "../src/features/audit/hooks/use-audit";
import { actionLabel, targetLabel, KNOWN_ACTIONS } from "../src/features/audit/ui/audit-labels";
import type { ApiClient } from "../src/lib/api";
import type { AuditEventPage } from "../src/features/audit/types";

const EMPTY_PAGE: AuditEventPage = { items: [], pageSize: 50 };

/** Ghi lại đúng đường dẫn client dựng ra — đây là thứ hợp đồng nói, không phải kiểu TypeScript. */
function recordingClient() {
  const paths: string[] = [];
  const client = {
    baseUrl: "https://example.test/api/v1",
    get: async <T>(path: string) => {
      paths.push(path);
      return EMPTY_PAGE as T;
    },
  } as unknown as ApiClient;
  return { client, paths };
}

describe("audit api", () => {
  test("tra cứu không bộ lọc không gửi tham số thừa", async () => {
    const { client, paths } = recordingClient();
    await auditApi.search(client);
    expect(paths[0]).toBe("/audit-events");
  });

  test("chỉ gửi tham số có giá trị", async () => {
    const { client, paths } = recordingClient();
    await auditApi.search(client, {
      actorUserId: "42",
      action: "report.release",
      targetType: "",
      targetId: undefined,
      pageSize: 50,
    });
    expect(paths[0]).toBe("/audit-events?actorUserId=42&action=report.release&pageSize=50");
  });

  test("con trỏ đi thành cặp beforeOccurredAt + beforeId", async () => {
    const { client, paths } = recordingClient();
    await auditApi.search(client, {
      beforeOccurredAt: "2026-08-29T06:45:00Z",
      beforeId: "9182",
    });
    expect(paths[0]).toContain("beforeOccurredAt=2026-08-29T06%3A45%3A00Z");
    expect(paths[0]).toContain("beforeId=9182");
  });

  test("lịch sử hồ sơ mã hoá mã hồ sơ trong đường dẫn", async () => {
    const { client, paths } = recordingClient();
    await auditApi.forRequest(client, "26100010", { pageSize: 50 });
    expect(paths[0]).toBe("/test-requests/26100010/audit-events?pageSize=50");
  });

  test("lịch sử hồ sơ không tham số thì không có dấu hỏi", async () => {
    const { client, paths } = recordingClient();
    await auditApi.forRequest(client, "26100010");
    expect(paths[0]).toBe("/test-requests/26100010/audit-events");
  });
});

describe("flattenAuditPages", () => {
  test("nối các trang theo đúng thứ tự máy chủ trả về", () => {
    const pages: AuditEventPage[] = [
      {
        items: [{ id: "3" }, { id: "2" }] as never,
        pageSize: 2,
        next: { beforeOccurredAt: "x", beforeId: "2" },
      },
      { items: [{ id: "1" }] as never, pageSize: 2 },
    ];
    expect(flattenAuditPages(pages).map((e) => e.id)).toEqual(["3", "2", "1"]);
  });

  test("chưa tải trang nào thì là danh sách rỗng, không phải undefined", () => {
    expect(flattenAuditPages(undefined)).toEqual([]);
  });
});

describe("nhãn nhật ký", () => {
  test("mã chưa có nhãn hiển thị nguyên mã, không đoán", () => {
    // Nhật ký audit là bằng chứng: đọc sai tên một hành động tệ hơn đọc một chuỗi kỹ thuật.
    expect(actionLabel("khong.co.trong.bang")).toBe("khong.co.trong.bang");
    expect(targetLabel("unknown_target")).toBe("unknown_target");
  });

  test("phủ được các hành động của mọi miền nghiệp vụ, không chỉ vài mã minh hoạ", () => {
    expect(actionLabel("lab.result.chooseFinal")).toBe("Chọn kết quả cuối");
    expect(actionLabel("report.replace")).toBe("Thay thế phiếu đã phát hành");
    expect(actionLabel("portal.probe.code-fanout")).toBe("Cổng tra cứu: dò nhiều mã khác nhau");
    expect(targetLabel("sampling_change_request")).toBe("Yêu cầu thay đổi hiện trường");
  });

  test("danh sách gợi ý của ô lọc dựng từ chính bảng nhãn", () => {
    expect(KNOWN_ACTIONS.length).toBeGreaterThan(60);
    expect(KNOWN_ACTIONS.every((item) => actionLabel(item.code) === item.label)).toBe(true);
  });
});
