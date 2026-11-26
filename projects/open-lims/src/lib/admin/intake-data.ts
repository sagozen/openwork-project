/* Dữ liệu mock cho S-07/S-08 - Tiếp nhận mẫu & chia mã con (D19, D20). */
import type { Tone } from "./records-data";

export interface TestParam {
  code: string;
  name: string;
}

export interface TransitRecord {
  id: string;
  product: string;
  customer: string;
  qty: number;
  container: string;
  arrivedAt: string;
  handover: string;
  state: string;
  /** Mã trạng thái theo từ vựng máy chủ - để bộ lọc trạng thái lọc được như bản thật. */
  stateCode: string;
  tone: Tone;
  tests: TestParam[];
}

export const TRANSIT_RECORDS: TransitRecord[] = [
  {
    id: "26100012",
    product: "Sầu riêng · 5 quả",
    customer: "Cty TNHH XNK Nông sản An Phát",
    qty: 5,
    container: "TCLU 123456-7 · seal SL-889",
    arrivedAt: "02/08/2026 10:12",
    handover: "Phạm Bảo Ngọc · Một cửa CN1 → Nguyễn Thị Hà · Phòng Hoá lý",
    state: "Đang vận chuyển",
    stateCode: "IN_TRANSIT",
    tone: "info",
    tests: [
      { code: "VO", name: "Vàng O" },
      { code: "CD", name: "Cadimi" },
    ],
  },
  {
    id: "26100013",
    product: "Mít · 3 quả",
    customer: "Cty CP Thực phẩm Bình Minh",
    qty: 3,
    container: "MSKU 771023-3 · seal SL-902",
    arrivedAt: "02/08/2026 11:40",
    handover: "Phạm Bảo Ngọc · Một cửa CN1 → Nguyễn Thị Hà · Phòng Hoá lý",
    state: "Chờ đối soát",
    stateCode: "AWAITING_CHECK",
    tone: "warning",
    tests: [{ code: "CD", name: "Cadimi" }],
  },
];

export interface ChecklistItem {
  key: string;
  name: string;
  rule: string;
  declared: string;
  actual: string;
}

export function checklistFor(r: TransitRecord): ChecklistItem[] {
  return [
    {
      key: "qty",
      name: "Số lượng mẫu thực nhận",
      rule: "Đối chiếu BM03 · lệch phải ghi lý do",
      declared: `${r.qty} quả`,
      actual: `${r.qty} quả`,
    },
    {
      key: "seal",
      name: "Số seal container",
      rule: "Trùng khai báo BM01 và ảnh hiện trường",
      declared: r.container.split("seal ")[1] ?? "-",
      actual: r.container.split("seal ")[1] ?? "-",
    },
    {
      key: "label",
      name: "Tem niêm phong mẫu",
      rule: "Còn nguyên vẹn, mã tem đọc được",
      declared: `${r.qty} tem`,
      actual: `${r.qty} tem`,
    },
    {
      key: "temp",
      name: "Nhiệt độ bảo quản khi nhận",
      rule: "2 – 8 °C với mẫu tươi",
      declared: "2 – 8 °C",
      actual: "5,4 °C",
    },
    {
      key: "bm02",
      name: "Biên bản BM02 có chữ ký hai bên",
      rule: "Bắt buộc trước khi tiếp nhận",
      declared: "Đã ký",
      actual: "Đã ký · 02/08 09:41",
    },
    {
      key: "bm03",
      name: "Phiếu BM03 tiêu chí lấy mẫu",
      rule: "Đủ 3 tiêu chí đạt",
      declared: "3/3 đạt",
      actual: "3/3 đạt",
    },
    {
      key: "pay",
      name: "Trạng thái thanh toán",
      rule: "Đã thu hoặc có xác nhận công nợ",
      declared: "Đã thanh toán",
      actual: "Đã thanh toán",
    },
  ];
}

export interface CodeNode {
  mark: string;
  code: string;
  kind: string;
}

export function subCode(parentId: string, i: number): string {
  return `${parentId}${String(i).padStart(2, "0")}`;
}

/* Cây mã theo mockup: mẫu cha · dải mã con · dải task theo từng chỉ tiêu. */
export function buildCodeTree(
  parentId: string,
  subCount: number,
  tests: TestParam[] = [],
): CodeNode[] {
  const nodes: CodeNode[] = [{ mark: "●", code: parentId, kind: "mẫu cha · một cửa in tem" }];
  if (subCount <= 0) {
    nodes.push({
      mark: "└",
      code: "chưa chia mã con",
      kind: "lab nhập số mẫu con thực chia",
    });
    return nodes;
  }
  const first = subCode(parentId, 1);
  const last = subCode(parentId, subCount);
  nodes.push({
    mark: tests.length ? "├" : "└",
    code: `${first} … ${last}`,
    kind: `${subCount} mẫu con · lab in tem`,
  });
  tests.forEach((t, i) => {
    nodes.push({
      mark: i === tests.length - 1 ? "└" : "├",
      code: `${first}${t.code} … ${last}${t.code}`,
      kind: `${subCount} task ${t.name} · lab in tem`,
    });
  });
  return nodes;
}

export type LabelState = "queued" | "printed" | "failed";

export interface LabelJob {
  code: string;
  kind: string;
  state: LabelState;
}

export const LABEL_STATE_TEXT: Record<LabelState, { label: string; tone: Tone }> = {
  queued: { label: "Chờ in", tone: "info" },
  printed: { label: "Đã in", tone: "success" },
  failed: { label: "In lỗi", tone: "danger" },
};

export interface ChangeField {
  field: string;
  oldValue: string;
  newValue: string;
}

export interface ChangeRequest {
  id: string;
  title: string;
  who: string;
  reason: string;
  fields: ChangeField[];
}

export const CHANGE_REQUESTS: ChangeRequest[] = [
  {
    id: "CR-0091",
    title: "Đề nghị sửa thông tin hiện trường · 26100012",
    who: "Đặng Hoài Nam · Nhân viên lấy mẫu · 02/08 09:26",
    reason:
      "Biển số xe trên chứng từ khác thực tế đầu kéo tại bãi; số seal in mờ, đã chụp lại ảnh cận cảnh.",
    fields: [
      { field: "Biển số xe", oldValue: "51C-284.17", newValue: "51C-284.71" },
      { field: "Số seal", oldValue: "0092481", newValue: "0092841" },
    ],
  },
];

export const INTAKE_STATS: { label: string; value: number; hint: string; tone: Tone }[] = [
  { label: "Đang vận chuyển", value: 3, hint: "Chờ tiếp nhận tại một cửa", tone: "info" },
  { label: "Chờ đối soát", value: 1, hint: "Thiếu hạng mục checklist", tone: "warning" },
  { label: "Đã tiếp nhận hôm nay", value: 7, hint: "Đã sinh mã cha", tone: "success" },
  { label: "Chờ bàn giao vào lab", value: 2, hint: "Đã tiếp nhận, chờ chuyển lab", tone: "brand" },
];
