/* A-09 · Nhật ký audit - dữ liệu dựng sẵn cho bản minh hoạ.
   Chế độ thật đọc `GET /audit-events`; các dòng dưới đây chỉ phục vụ bản minh hoạ không có máy
   chủ. Mã `action` và `targetType` giữ nguyên văn theo từ vựng của backend, còn NHÃN tiếng Việt
   sống ở `features/audit/ui/audit-labels.ts` - một bảng duy nhất cho cả hai chế độ. */

export const ANY = "any";

export interface AuditEvent {
  id: string;
  /** ISO 8601 để lọc theo khoảng thời gian mà không phải phân tích chuỗi hiển thị. */
  occurredAt: string;
  actorUserId: string;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string;
  /** Máy chủ giấu trường này với người không có `request.customer.view`. */
  detail?: string;
}

export const AUDIT_EVENTS: AuditEvent[] = [
  {
    id: "ae-12",
    occurredAt: "2026-08-02T15:40:00+07:00",
    actorUserId: "42",
    actorName: "Trần Minh Khôi",
    action: "report.version.release",
    targetType: "report",
    targetId: "rp-88",
    detail: "KQ26000045 v2 · phát hành cho hồ sơ 26100012",
  },
  {
    id: "ae-11",
    occurredAt: "2026-08-02T14:05:00+07:00",
    actorUserId: "17",
    actorName: "Phạm Văn Đức",
    action: "review.technical.decide",
    targetType: "analysis_task",
    targetId: "at-311",
    detail: "2610001201VO · đạt · nhận xét: kết quả trong ngưỡng",
  },
  {
    id: "ae-10",
    occurredAt: "2026-08-02T11:22:00+07:00",
    actorUserId: "17",
    actorName: "Phạm Văn Đức",
    action: "lab.result.enter",
    targetType: "analysis_task",
    targetId: "at-311",
    detail: "Vàng O · 0,42 mg/kg · thiết bị LC-MS/MS-02",
  },
  {
    id: "ae-9",
    occurredAt: "2026-08-02T08:12:00+07:00",
    actorUserId: "17",
    actorName: "Phạm Văn Đức",
    action: "reception.handover.create",
    targetType: "handover",
    targetId: "hv-2",
    detail: "Lab nhận mẫu 26100012 từ Ngô Thị Kim Chi",
  },
  {
    id: "ae-8",
    occurredAt: "2026-08-02T09:40:00+07:00",
    actorUserId: "23",
    actorName: "Điều phối một cửa",
    action: "sampling.change_request.approve",
    targetType: "sampling_assignment",
    targetId: "sa-77",
    detail: "Biển số xe 51C-123.45 → 51C-543.21 · duyệt 1/2 trường",
  },
  {
    id: "ae-7",
    occurredAt: "2026-08-02T08:44:00+07:00",
    actorUserId: "31",
    actorName: "Lê Thị Hồng Vân",
    action: "sampling.bm02.create",
    targetType: "sampling_assignment",
    targetId: "sa-77",
    detail: "BM02 ký hai bên · đại diện khách: Ngô Thị Kim Chi",
  },
  {
    id: "ae-6",
    occurredAt: "2026-07-31T10:02:00+07:00",
    actorUserId: "23",
    actorName: "Điều phối một cửa",
    action: "sampling.assignment.assign",
    targetType: "sampling_assignment",
    targetId: "sa-77",
    detail: "Giao cho Lê Thị Hồng Vân · 02/08 08:00 · Kho X, KCN Quang Minh",
  },
  {
    id: "ae-5",
    occurredAt: "2026-07-30T16:18:00+07:00",
    actorUserId: "42",
    actorName: "Trần Minh Khôi",
    action: "request.payment.exception.grant",
    targetType: "test_request",
    targetId: "tr-1201",
    detail: "Đối tác trả sau theo hợp đồng khung 2026 · kèm văn bản phê duyệt",
  },
  {
    id: "ae-4",
    occurredAt: "2026-07-30T09:01:00+07:00",
    actorUserId: "11",
    actorName: "Ngô Thị Kim Chi",
    action: "request.payment.confirm",
    targetType: "test_request",
    targetId: "tr-1198",
    detail: "UNC 0071 · 4.200.000 VND",
  },
  {
    id: "ae-3",
    occurredAt: "2026-07-29T14:30:00+07:00",
    actorUserId: "11",
    actorName: "Ngô Thị Kim Chi",
    action: "request.testRequest.patchGroupA",
    targetType: "test_request",
    targetId: "tr-1201",
  },
  {
    id: "ae-2",
    occurredAt: "2026-07-28T09:12:00+07:00",
    actorUserId: "11",
    actorName: "Ngô Thị Kim Chi",
    action: "request.testRequest.create",
    targetType: "test_request",
    targetId: "tr-1201",
    detail: "26100012 · Sầu riêng · Cty TNHH XNK Nông sản An Phát",
  },
  {
    id: "ae-1",
    occurredAt: "2026-07-27T17:45:00+07:00",
    actorUserId: "1",
    actorName: "Nguyễn Quốc Toàn",
    action: "iam.user.role-assignments.replace",
    targetType: "user",
    targetId: "u-31",
    detail: "Lê Thị Hồng Vân · Nhân viên lấy mẫu × CN1",
  },
];

export interface AuditFilters {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  actorUserId: "",
  action: ANY,
  targetType: ANY,
  targetId: "",
  from: "",
  to: "",
};

/** Lọc phía client - bản thật để máy chủ lọc rồi phân trang bằng con trỏ. */
export function filterAuditEvents(events: AuditEvent[], filters: AuditFilters): AuditEvent[] {
  const from = filters.from ? new Date(filters.from).getTime() : undefined;
  const to = filters.to ? new Date(filters.to).getTime() : undefined;
  return events.filter((event) => {
    if (filters.actorUserId.trim() && event.actorUserId !== filters.actorUserId.trim())
      return false;
    if (filters.action !== ANY && event.action !== filters.action) return false;
    if (filters.targetType !== ANY && event.targetType !== filters.targetType) return false;
    if (filters.targetId.trim() && !event.targetId.includes(filters.targetId.trim())) return false;
    const at = new Date(event.occurredAt).getTime();
    if (from !== undefined && at < from) return false;
    if (to !== undefined && at > to) return false;
    return true;
  });
}

/** Lịch sử phân quyền của một người dùng - CHỈ dùng cho bản minh hoạ.
 *  Ở chế độ thật, drawer đọc `GET /audit-events?targetType=user&targetId={id}`. */
export interface UserAuditLine {
  what: string;
  who: string;
}

export const USER_AUDIT_DEMO: UserAuditLine[] = [
  { what: "Gán vai trò «Nhân viên lấy mẫu · CN1»", who: "Quản trị hệ thống · 12/07 09:10" },
  { what: "Kích hoạt tài khoản qua lời mời", who: "Hệ thống · 12/07 08:55" },
];
