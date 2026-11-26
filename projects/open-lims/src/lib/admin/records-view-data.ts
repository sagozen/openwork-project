/* Cấu hình cột, nhãn, chế độ xem cho màn Hồ sơ kiểm nghiệm (S-10).
   Chuyển thể từ prototype design-handoff/DLP LIMS.dc.html. */

import { isOverdue, type RecordRow, type Tone } from "./records-data";

export type ColType = "link" | "text" | "status" | "badge" | "tags";

export interface RecordColumn {
  key: string;
  label: string;
  w: number;
  type: ColType;
  locked?: boolean;
  pii?: boolean;
}

export const RECORD_COLUMNS: RecordColumn[] = [
  { key: "id", label: "Mã lượt", w: 130, type: "link", locked: true },
  { key: "tags", label: "Nhãn", w: 210, type: "tags" },
  { key: "status", label: "Trạng thái", w: 180, type: "status" },
  { key: "customer", label: "Khách hàng", w: 230, type: "text", pii: true },
  { key: "product", label: "Sản phẩm", w: 130, type: "text" },
  { key: "criteria", label: "Chỉ tiêu", w: 110, type: "text" },
  { key: "pay", label: "Thanh toán", w: 160, type: "badge" },
  { key: "due", label: "Hạn trả", w: 120, type: "text" },
  { key: "handler", label: "Người xử lý", w: 160, type: "text" },
  { key: "branch", label: "Chi nhánh", w: 160, type: "text" },
  { key: "createdAt", label: "Tạo lúc", w: 150, type: "text" },
];

export interface TagDef {
  name: string;
  group: string;
  color: Tone;
  count: number;
  scope: string;
  /**
   * Mã nhãn máy chủ dùng trong `?tag=`. Vắng mặt ở bản minh hoạ, nơi không có máy chủ nào để
   * hỏi và chính tên nhãn đóng vai định danh - nên chỗ nào cần khoá thì đọc `code ?? name`.
   *
   * Tách mã khỏi tên vì đổi tên hiển thị không được làm hỏng một bộ lọc ai đó đã lưu lại.
   */
  code?: string;
}

export const RECORD_TAGS: TagDef[] = [
  { name: "Thiếu file", group: "Cần chú ý", color: "danger", count: 17, scope: "Hệ thống" },
  {
    name: "Kết quả bất thường",
    group: "Cần chú ý",
    color: "danger",
    count: 6,
    scope: "Hệ thống",
  },
  { name: "Cần xác minh", group: "Cần chú ý", color: "danger", count: 9, scope: "Phòng Hoá lý" },
  { name: "Gấp", group: "Mức ưu tiên", color: "warning", count: 12, scope: "Hệ thống" },
  { name: "Ưu tiên cao", group: "Mức ưu tiên", color: "warning", count: 21, scope: "Hệ thống" },
  { name: "Cadimi", group: "Chỉ tiêu", color: "brand", count: 128, scope: "Hệ thống" },
  { name: "Vàng O", group: "Chỉ tiêu", color: "brand", count: 114, scope: "Hệ thống" },
  { name: "Kim loại nặng", group: "Chỉ tiêu", color: "brand", count: 64, scope: "Hệ thống" },
  { name: "Sầu riêng", group: "Loại mẫu", color: "info", count: 96, scope: "Hệ thống" },
  { name: "Mít", group: "Loại mẫu", color: "info", count: 42, scope: "Hệ thống" },
  { name: "Xuất khẩu", group: "Mục đích", color: "info", count: 73, scope: "Hệ thống" },
  { name: "Kiểm tra định kỳ", group: "Mục đích", color: "info", count: 31, scope: "Hệ thống" },
  { name: "Chờ tôi xử lý", group: "Nhóm công việc", color: "info", count: 8, scope: "Cá nhân" },
  { name: "Theo dõi", group: "Nhóm công việc", color: "info", count: 5, scope: "Cá nhân" },
];

export const TAG_GROUP_ORDER = [
  "Cần chú ý",
  "Mức ưu tiên",
  "Chỉ tiêu",
  "Loại mẫu",
  "Mục đích",
  "Nhóm công việc",
];

export function tagColor(name: string): Tone {
  return RECORD_TAGS.find((t) => t.name === name)?.color ?? "info";
}

/** Danh mục nhãn dựng từ chính các dòng đang có - dùng khi nhãn đến từ máy chủ,
 *  nơi chưa có API danh mục nhãn nên số đếm chỉ tính trên dữ liệu đã tải. */
export const VIEW_GROUPS = [
  "Chế độ xem hệ thống",
  "Chế độ xem được chia sẻ",
  "Chế độ xem của tôi",
] as const;

export type CondField = "progress" | "file" | "customer" | "product";
export type Condition = { field: CondField; op: string; val: string };

export interface ViewDef {
  id: string;
  name: string;
  group: string;
  count: number;
  tags: string[];
  conds: Condition[];
  /**
   * Phần bố cục kèm theo, chỉ có ở chế độ xem lưu trên máy chủ. Chế độ xem dựng sẵn của hệ thống
   * chỉ đặt bộ lọc và cố ý KHÔNG đụng tới cột: chọn "Phiếu quá hạn" mà bị xáo lại thứ tự cột thì
   * không ai muốn.
   */
  layout?: {
    order: string[];
    hidden: string[];
    pinned: string[];
    density: "comfortable" | "compact";
    tagMode: "any" | "all" | "none";
  };
  /** Của người khác chia sẻ: hiện ra được, nhưng không đổi tên hay xoá được. */
  ownedByMe?: boolean;
}

export const RECORD_VIEW_DEFS: ViewDef[] = [
  { id: "all", name: "Tất cả phiếu", group: "Chế độ xem hệ thống", count: 8, tags: [], conds: [] },
  {
    id: "today",
    name: "Phiếu của tôi hôm nay",
    group: "Chế độ xem hệ thống",
    count: 4,
    tags: ["Chờ tôi xử lý"],
    conds: [],
  },
  {
    id: "cadimi",
    name: "Cadimi đang xử lý",
    group: "Chế độ xem được chia sẻ",
    count: 5,
    tags: ["Cadimi"],
    conds: [],
  },
  {
    id: "nofile",
    name: "Hồ sơ thiếu file trung gian",
    group: "Chế độ xem được chia sẻ",
    count: 3,
    tags: ["Thiếu file"],
    conds: [],
  },
  {
    id: "late",
    name: "Phiếu quá hạn",
    group: "Chế độ xem của tôi",
    count: 2,
    tags: [],
    conds: [{ field: "progress", op: "is", val: "" }],
  },
];

export const COND_FIELDS: { value: CondField; label: string }[] = [
  { value: "progress", label: "Tiến độ" },
  { value: "file", label: "File trung gian" },
  { value: "customer", label: "Khách hàng" },
  { value: "product", label: "Sản phẩm" },
];

export function opsFor(field: CondField): { value: string; label: string }[] {
  if (field === "progress")
    return [
      { value: "is", label: "là quá hạn" },
      { value: "not", label: "không quá hạn" },
    ];
  if (field === "file")
    return [
      { value: "has", label: "đã có" },
      { value: "none", label: "chưa có" },
    ];
  return [
    { value: "contains", label: "chứa" },
    { value: "eq", label: "bằng" },
  ];
}

export function condLabel(c: Condition): string {
  const f = COND_FIELDS.find((x) => x.value === c.field)?.label ?? c.field;
  const o = opsFor(c.field).find((x) => x.value === c.op)?.label ?? c.op;
  return `${f} ${o}${c.val ? ` “${c.val}”` : ""}`;
}

/* ---------- Phương án B: worklist + hàng chờ ---------- */

export const MY_WORK_TAG = "Chờ tôi xử lý";
export const WORKLIST_FILTERS = ["Tất cả", "Của tôi", "Quá hạn"];

export interface WorklistItem {
  row: RecordRow;
  icon: string;
  title: string;
  sub: string;
  tone: Tone;
  state: string;
  due: string;
  cta: string;
  bucket: string;
}

/** Chữ viết tắt của trạng thái, dùng làm huy hiệu tròn đầu dòng việc. */
function initials(text: string): string {
  const words = text.split(/[\s·]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** Dựng danh sách việc cần làm từ chính các dòng hồ sơ đang hiển thị, để bản mock và bản
 *  chạy thật cùng một nguồn dữ liệu thay vì một danh sách cứng. */
export function toWorklistItems(rows: RecordRow[], canPii: boolean): WorklistItem[] {
  return rows.map((row) => ({
    row,
    icon: initials(row.status),
    title: [row.id, row.product, canPii ? row.customer : null].filter(Boolean).join(" · "),
    sub: [row.status, row.branch].filter(Boolean).join(" · "),
    tone: row.statusTone,
    state: row.pay,
    due: row.due,
    cta: row.draftId ? "Tiếp tục" : "Mở phiếu",
    bucket: isOverdue(row) ? "Quá hạn" : row.tags.includes(MY_WORK_TAG) ? "Của tôi" : "Khác",
  }));
}

export const RECORD_NOTIFS: { text: string; time: string }[] = [
  { text: "Hồ sơ 26100012 chưa có chứng từ thanh toán", time: "10 phút trước" },
  { text: "Phiếu kết quả 26100010 chờ giám đốc ký", time: "1 giờ trước" },
  { text: "Lô mẫu 26100011 đã về PTN Hoá lý", time: "Hôm nay 08:20" },
];

export const RECORD_QUEUE: { name: string; state: string; tone: Tone; hint: string }[] = [
  { name: "AI phân loại nhãn 12 phiếu", state: "Đang xử lý", tone: "info", hint: "8/12" },
  { name: "Xuất Excel danh sách hồ sơ", state: "Hoàn tất", tone: "success", hint: "vừa xong" },
  { name: "Ký số lô phiếu tháng 7", state: "Hoàn tất một phần", tone: "warning", hint: "2 lỗi" },
];

/* ---------- Phương án C: bảng theo trạng thái ---------- */

export const BOARD_COLUMNS = [
  "Chờ phân công",
  "Chưa về PTN",
  "Đang thử nghiệm",
  "Chờ phê duyệt",
  "Quá hạn TT · khoá lab",
];
