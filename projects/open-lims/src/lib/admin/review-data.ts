/* Dữ liệu mock cho S-17 - kiểm tra kỹ thuật (UC-20, D06/D07/D23/D24). */
import type { Tone } from "./records-data";
import type { StatItem } from "@/components/lims/common";

export type ReviewState = "wait" | "ok" | "back";

export interface ReviewRow {
  final: string;
  sub: string;
  at: string;
  value: string;
  note: string;
}

export interface ReviewItem {
  id: string;
  task: string;
  sub: string;
  title: string;
  version: string;
  traceLabel: string;
  rows: ReviewRow[];
  meta: { k: string; v: string }[];
}

export const REVIEW_ITEMS: ReviewItem[] = [
  {
    id: "vo",
    task: "2610001201VO - Vàng O",
    sub: "Mẫu cha 26100012 · SKIN + FLESH · v2",
    title: "2610001201VO - Vàng O (Auramine O)",
    version: "Phiên bản v2 · gửi 03/08 13:40",
    traceLabel: "Một vết truy vết · phiên bản v2 (hiện hành)",
    rows: [
      { final: "Chọn", sub: "2610001201", at: "03/08 09:10", value: "KPH (<LOD)", note: "SKIN" },
      { final: "-", sub: "2610001202", at: "03/08 09:25", value: "KPH (<LOD)", note: "SKIN" },
      { final: "Chọn", sub: "2610001201", at: "03/08 10:05", value: "KPH (<LOD)", note: "FLESH" },
    ],
    meta: [
      { k: "Người thực hiện", v: "Nguyễn Thị Hà" },
      { k: "Phương pháp thử", v: "HD.H.101 (2026) - Ref. BJS 202204" },
      { k: "LOD / LOQ", v: "0,200 / 1,00 µg/kg" },
      { k: "File kỹ thuật", v: "raw-run-0308.pdf" },
    ],
  },
  {
    id: "cd",
    task: "2610001201CD - Cadimi",
    sub: "Mẫu cha 26100012 · WHOLE · v1",
    title: "2610001201CD - Cadimi (Cd)",
    version: "Phiên bản v1 · gửi 03/08 09:05",
    traceLabel: "Một vết truy vết · phiên bản v1 (hiện hành)",
    rows: [
      { final: "Chọn", sub: "2610001201", at: "03/08 08:20", value: "20,0 µg/kg", note: "WHOLE" },
      { final: "-", sub: "2610001203", at: "03/08 08:44", value: "19,4 µg/kg", note: "Chạy lặp" },
    ],
    meta: [
      { k: "Người thực hiện", v: "Nguyễn Thị Hà" },
      { k: "Phương pháp thử", v: "HD.H.01 (2026) - Ref. AOAC 2015.01" },
      { k: "LOD / LOQ", v: "1,50 / 5,00 µg/kg" },
      { k: "File kỹ thuật", v: "raw-run-0308.pdf" },
    ],
  },
];

export const REVIEW_TRACE_HISTORY: {
  v: string;
  who: string;
  why: string;
  tone: Tone;
  state: string;
}[] = [
  {
    v: "Phiên bản v1",
    who: "Nguyễn Thị Hà · gửi 03/08 09:05",
    why: "Trả lại: nhầm đơn vị mg/kg ↔ µg/kg",
    tone: "danger",
    state: "Đã trả lại",
  },
  {
    v: "Phiên bản v2",
    who: "Nguyễn Thị Hà · gửi 03/08 13:40",
    why: "Nhập lại theo đúng đơn vị µg/kg",
    tone: "success",
    state: "Hiện hành",
  },
];

export const TRACE_AUDIT_NOTE =
  "Mỗi lượt mở bảng này được ghi vào nhật ký truy cập dữ liệu nhạy cảm.";

export const TRACE_NOTE_ALLOWED =
  "Bạn có permission «xem lịch sử lưu vết kết quả» - mỗi lượt mở panel lịch sử được ghi audit như truy cập dữ liệu nhạy cảm.";

export const TRACE_NOTE_DENIED =
  "Chỉ hiển thị phiên bản hiện hành. Muốn xem phiên bản cũ, tài khoản cần quyền xem lịch sử kết quả.";

export const REVIEW_DONE_NOTE =
  "Hồ sơ tự chuyển «Chờ phê duyệt» và thông báo cho ba lãnh đạo ký. Nhân viên lab không sửa được kết quả - trả lại sẽ tạo phiên bản mới.";

export function reviewStateLabel(st: ReviewState) {
  return st === "ok" ? "Đã chấp nhận" : st === "back" ? "Đã trả lại" : "Chờ kiểm tra";
}

export function reviewStateTone(st: ReviewState): Tone {
  return st === "ok" ? "success" : st === "back" ? "danger" : "warning";
}

export function reviewStats(states: Record<string, ReviewState>): StatItem[] {
  const values = Object.values(states);
  const wait = values.filter((v) => v === "wait").length;
  const ok = values.filter((v) => v === "ok").length;
  const back = values.filter((v) => v === "back").length;
  return [
    { label: "Chỉ tiêu chờ kiểm tra", value: wait, hint: "Ưu tiên theo hạn TAT", tone: "warning" },
    { label: "Đã chấp nhận", value: ok, hint: "Sẵn sàng chuyển phê duyệt", tone: "success" },
    { label: "Đã trả lại lab", value: back, hint: "Tạo phiên bản kết quả mới", tone: "danger" },
    { label: "Còn lại tới hạn", value: "12 giờ", hint: "Hạn 05/08 17:00", tone: "info" },
  ];
}
