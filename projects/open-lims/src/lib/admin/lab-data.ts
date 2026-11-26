/* Dữ liệu mock cho S-09 (bàn giao vào lab) và S-14 (bảng công việc lab). */
import type { Tone } from "./records-data";
import type { StatItem } from "@/components/lims/common";
import type { HandoverLogEntry } from "@/features/request/types";
import type { HandoverCounterpart } from "@/features/reception/types";

/* ── S-09 ─────────────────────────────────────────────── */

export type HandoverStep = "giao" | "nhan";

export const HANDOVER_STEPS: { key: HandoverStep; label: string }[] = [
  { key: "giao", label: "Một cửa bàn giao" },
  { key: "nhan", label: "Lab xác nhận nhận" },
];

export type ScanState = "pending" | "scanned" | "error";

export interface HandoverItem {
  code: string;
  kind: string;
  state: ScanState;
  audit: string;
}

export const SCAN_STATE_TEXT: Record<ScanState, { label: string; tone: Tone }> = {
  pending: { label: "Chờ quét", tone: "info" },
  scanned: { label: "Đã ghi nhận", tone: "success" },
  error: { label: "Sai bước", tone: "danger" },
};

export const HANDOVER_PARENT = "26100012";

/** Mỗi mẫu minh hoạ có mã riêng, không ghép mã hồ sơ hay mã mẫu con. */
export function initialHandoverItems(): HandoverItem[] {
  return Array.from({ length: HANDOVER_DECLARED_QUANTITY }, (_, index) => ({
    code: String(Number(HANDOVER_PARENT) + index),
    kind: "Mã mẫu",
    state: "pending" as ScanState,
    audit: "-",
  }));
}

/** Chỉ tiêu của các mẫu trong hồ sơ minh hoạ. */
export const HANDOVER_PARAMETERS = [
  { code: "VO", name: "Vàng O" },
  { code: "CD", name: "Cadimi" },
];

/** Số mẫu khai báo trong hồ sơ minh hoạ. */
export const HANDOVER_DECLARED_QUANTITY = 4;

/** Người đối ứng của một lượt bàn giao, dựng sẵn cho bản minh hoạ (bản thật đọc từ
 *  `GET /handovers/counterparts` theo chi nhánh của người đang thao tác). */
export const HANDOVER_COUNTERPARTS: HandoverCounterpart[] = [
  { id: "u-lab-1", fullName: "Phạm Văn Đức", jobTitle: "Kiểm nghiệm viên" },
  { id: "u-lab-2", fullName: "Vũ Thị Hạnh", jobTitle: "Trưởng nhóm lab" },
  { id: "u-onestop-1", fullName: "Ngô Thị Kim Chi", jobTitle: "Chuyên viên một cửa" },
];

/* Nhật ký giao - nhận dựng sẵn cho bản minh hoạ: màn Bàn giao hứa "hệ thống ghi người giao,
   người nhận, thời điểm", nên bản demo cũng phải đọc lại được đúng như bản chạy thật. Kiểu dữ
   liệu lấy thẳng của API để hai bản dùng chung một thành phần hiển thị. */
export const HANDOVER_LOG: HandoverLogEntry[] = [
  {
    handoverId: "hv-2",
    step: { code: "RECEIVE", name: "Lab nhận mẫu" },
    scannedCodes: ["26100012", "26100013", "26100014", "26100015"],
    scanMethod: { code: "QR", name: "Quét QR" },
    performedBy: { id: "u-lab-1", fullName: "Phạm Văn Đức" },
    counterpart: { id: "u-onestop-1", fullName: "Ngô Thị Kim Chi" },
    performedAt: "2026-08-02T08:12:00+07:00",
  },
  {
    handoverId: "hv-1",
    step: { code: "DELIVER", name: "Một cửa giao mẫu" },
    scannedCodes: ["26100012", "26100013", "26100014", "26100015"],
    scanMethod: { code: "QR", name: "Quét QR" },
    performedBy: { id: "u-onestop-1", fullName: "Ngô Thị Kim Chi" },
    counterpart: { id: "u-lab-1", fullName: "Phạm Văn Đức" },
    note: "Thùng lạnh 2-8 °C, nhật ký nhiệt độ kèm theo.",
    performedAt: "2026-08-02T07:58:00+07:00",
  },
];

export const HANDOVER_STATS: StatItem[] = [
  { label: "Lô chờ bàn giao", value: 2, hint: "Một cửa đã in tem mẫu", tone: "info" },
  { label: "Tem task chờ in", value: 8, hint: "Mỗi mẫu con × chỉ tiêu", tone: "brand" },
  { label: "Bàn giao hôm nay", value: 9, hint: "Đủ chữ ký hai bên", tone: "success" },
  { label: "Quét sai bước", value: 1, hint: "Cần quét lại đúng thứ tự", tone: "warning" },
];

export const HANDOVER_COPY: Record<
  HandoverStep,
  {
    scanTitle: string;
    scanHint: string;
    listTitle: string;
    cta: string;
    hint: string;
    audit: string;
  }
> = {
  giao: {
    scanTitle: "Quét tem để bàn giao",
    scanHint: "Quét đúng mã mẫu cần bàn giao. Mỗi lượt ghi nhận một mẫu.",
    listTitle: "Mẫu trong lượt bàn giao",
    cta: "Xác nhận bàn giao",
    hint: "Hệ thống ghi người giao - người nhận - thời điểm, không cho sửa thủ công.",
    audit: "Phiên bàn giao",
  },
  nhan: {
    scanTitle: "Lab quét xác nhận nhận mẫu",
    scanHint: "Quét đúng mã mẫu để nhận vào lab. Mỗi lượt ghi nhận một mẫu.",
    listTitle: "Mẫu cần nhận vào lab",
    cta: "Xác nhận đã nhận",
    hint: "Nhận mẫu vào lab để bắt đầu phân tích các chỉ tiêu của mẫu.",
    audit: "Phiên xác nhận",
  },
};

/* ── S-14 ─────────────────────────────────────────────── */

export const LAB_STATS: StatItem[] = [
  { label: "Task chờ phân công", value: 6, hint: "Chưa có người phụ trách", tone: "warning" },
  { label: "Đang phân tích", value: 11, hint: "Trong hạn", tone: "brand" },
  { label: "Chờ nhập kết quả", value: 4, hint: "Đã có dữ liệu thô", tone: "info" },
  { label: "Đã gửi kiểm tra", value: 5, hint: "Task đang khoá", tone: "success" },
];

export interface LabParent {
  id: string;
  product: string;
  at: string;
  state: string;
  tone: Tone;
}

export const LAB_PARENTS: LabParent[] = [
  {
    id: "26100012",
    product: "Sầu riêng",
    at: "02/08/2026 10:35",
    state: "Đã chia 5 mã con",
    tone: "success",
  },
  {
    id: "26100013",
    product: "Mít",
    at: "02/08/2026 12:02",
    state: "Chờ chia mã con",
    tone: "warning",
  },
];

export type TaskState = "unassigned" | "assigned" | "running" | "entering" | "done" | "returned";

export const TASK_STATE_TEXT: Record<TaskState, { label: string; tone: Tone }> = {
  unassigned: { label: "Chờ phân công", tone: "warning" },
  assigned: { label: "Đã nhận task", tone: "warning" },
  running: { label: "Đang phân tích", tone: "info" },
  entering: { label: "Chờ nhập kết quả", tone: "info" },
  done: { label: "Đã gửi kiểm tra", tone: "success" },
  returned: { label: "Bị trả lại", tone: "danger" },
};

export interface LabTask {
  code: string;
  param: string;
  part: string;
  matrix: string;
  owner: string;
  state: TaskState;
}

export const LAB_TASKS: LabTask[] = [
  {
    code: "2610001201VO",
    param: "Vàng O",
    part: "Thịt quả",
    matrix: "Quả tươi",
    owner: "-",
    state: "unassigned",
  },
  {
    code: "2610001201CD",
    param: "Cadimi",
    part: "Vỏ",
    matrix: "Quả tươi",
    owner: "Nguyễn Thị Hà",
    state: "assigned",
  },
  {
    code: "2610001202VO",
    param: "Vàng O",
    part: "Thịt quả",
    matrix: "Quả tươi",
    owner: "Lê Minh Quân",
    state: "running",
  },
  {
    code: "2610001202CD",
    param: "Cadimi",
    part: "Toàn quả",
    matrix: "Quả tươi",
    owner: "Trần Thu Trang",
    state: "entering",
  },
  {
    code: "2610001301CD",
    param: "Cadimi",
    part: "Thịt quả",
    matrix: "Quả tươi",
    owner: "Nguyễn Thị Hà",
    state: "done",
  },
];

export const TASK_FILTERS: { key: string; label: string }[] = [
  { key: "unassigned", label: "Chưa phân công" },
  { key: "mine", label: "Của tôi" },
  { key: "all", label: "Toàn bộ lab" },
];

export const LAB_SCOPE_NOTE =
  "Toàn bộ task và mẫu cha thuộc Phòng Hoá lý. Mỗi task chỉ có một người phụ trách; mọi lần gán, tự nhận hoặc đổi người đều được ghi vào nhật ký.";

/* Nhân sự lab nhận analysis task - dùng cho drawer phân công (S-14, D21). */
export interface AnalystOption {
  id: string;
  name: string;
  load: string;
  state: string;
  tone: Tone;
  available: boolean;
}

export const LAB_ANALYSTS: AnalystOption[] = [
  {
    id: "ha",
    name: "Nguyễn Thị Hà",
    load: "Phòng Hoá lý · 3 task đang chạy",
    state: "Sẵn sàng",
    tone: "success",
    available: true,
  },
  {
    id: "quan",
    name: "Lê Minh Quân",
    load: "Phòng Hoá lý · 6 task đang chạy",
    state: "Gần đầy tải",
    tone: "warning",
    available: true,
  },
  {
    id: "trang",
    name: "Trần Thu Trang",
    load: "Phòng Hoá lý · nghỉ phép tới 06/08",
    state: "Không khả dụng",
    tone: "danger",
    available: false,
  },
];
