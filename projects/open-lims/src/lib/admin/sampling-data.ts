/* S-05 · Lấy mẫu hiện trường (ứng dụng mobile) - BM02 + BM03.
   Dữ liệu trích trực tiếp từ mockup design-handoff/DLP LIMS.dc.html (UF-05). */

export interface FieldTurn {
  code: string;
  title: string;
  place: string;
  customer?: string;
  time: string;
  state: string;
  tone: "warning" | "info";
  actionable: boolean;
}

export const FIELD_TURNS: FieldTurn[] = [
  {
    code: "26100012",
    title: "Sầu riêng · Vàng O + Cadimi",
    place: "Kho X, KCN Quang Minh",
    customer: "Cty TNHH XNK Nông sản An Phát",
    time: "hẹn 08:00",
    state: "Đã phân công",
    tone: "warning",
    actionable: true,
  },
  {
    code: "26100013",
    title: "Mít · Cadimi",
    place: "Bãi container Tân Cảng",
    time: "hẹn 14:00",
    state: "Chờ duyệt thay đổi",
    tone: "info",
    actionable: false,
  },
];

/* Bảy trường đối soát BM01 - đúng danh sách của bản nối API (`ReconciliationField`), kể cả hai
   trường tuỳ chọn hồ sơ có thể không khai (số rơ-moóc, số seal). */
export type ReconField =
  | "productName"
  | "growingAreaCode"
  | "packingHouseCode"
  | "vehiclePlate"
  | "containerNo"
  | "trailerNo"
  | "sealNo";

export interface ReconRow {
  field: ReconField;
  label: string;
  /** Giá trị khách khai trên BM01; `null` là hồ sơ không khai trường đó. */
  declared: string | null;
  /** Giá trị thực tế tại hiện trường, dựng sẵn để người xem demo không phải gõ lại cả bảy ô. */
  actual: string;
}

export const RECON_ROWS: ReconRow[] = [
  { field: "productName", label: "Tên sản phẩm", declared: "Sầu riêng", actual: "Sầu riêng" },
  {
    field: "growingAreaCode",
    label: "Mã vùng trồng",
    declared: "VN-DL-0417",
    actual: "VN-DL-0417",
  },
  {
    field: "packingHouseCode",
    label: "Mã cơ sở đóng gói",
    declared: "VN-PH-0092",
    actual: "VN-PH-0092",
  },
  { field: "vehiclePlate", label: "Biển số xe", declared: "51C-123.45", actual: "51C-543.21" },
  { field: "containerNo", label: "Số container", declared: "ABCD1234567", actual: "ABCD1234567" },
  { field: "trailerNo", label: "Số rơ-moóc", declared: null, actual: "51R-001.02" },
  { field: "sealNo", label: "Số seal", declared: "SL-889", actual: "SL-889" },
];

/** Số lượng khách khai dự kiến trên BM01, in kèm ô nhập số lượng thực lấy. */
export const BM01_EXPECTED_QUANTITY = 5;

/* Hàng chờ của quản lý một cửa: đề nghị sửa do người lấy mẫu gửi lên, duyệt/từ chối theo TỪNG
   trường chứ không phải cả đề nghị. */
export interface ChangeRequestField {
  field: ReconField;
  label: string;
  oldValue: string;
  newValue: string;
}

export interface FieldChangeRequestDemo {
  id: string;
  assignmentCode: string;
  requestedBy: string;
  requestedAt: string;
  reason: string;
  fields: ChangeRequestField[];
}

export const FIELD_CHANGE_REQUESTS: FieldChangeRequestDemo[] = [
  {
    id: "cr-1",
    assignmentCode: "26100013",
    requestedBy: "Lê Minh D",
    requestedAt: "02/08/2026 09:12",
    reason: "Khách đổi xe tải sáng nay, container giữ nguyên.",
    fields: [
      {
        field: "vehiclePlate",
        label: "Biển số xe",
        oldValue: "51C-777.10",
        newValue: "51C-902.44",
      },
      { field: "sealNo", label: "Số seal", oldValue: "SL-877", newValue: "SL-901" },
    ],
  },
];

export const BM03_CRIT = [
  {
    label: "Mẫu lấy đại diện cho lô",
    note: "Theo TCVN 9017:2011 · lấy ở ba vị trí khác nhau",
  },
  {
    label: "Niêm phong tại chỗ",
    note: "Số seal khớp khai báo, dán trước mặt đại diện khách hàng",
  },
  {
    label: "Bảo quản 2–8 °C tới khi giao lab",
    note: "Thùng lạnh có nhật ký nhiệt độ",
  },
];

export const BM03_ROWS = [
  { code: "NL-2026-0012.1", ct: "Vàng O", unit: "quả", qty: 5 },
  { code: "NL-2026-0012.2", ct: "Cadimi", unit: "quả", qty: 4 },
  { code: "NL-2026-0012.3", ct: "Mẫu lưu", unit: "quả", qty: 3 },
];

export const BM03_GEO = "Ảnh gắn toạ độ 21.0287, 105.8542 · 02/08/2026 08:41";

export const BM02_SUMMARY = [
  "Sầu riêng · VN-DL-0417 · VN-PH-0092",
  "Container ABCD1234567 · 51C-543.21",
  "TCVN 9017:2011 · 5 quả · Vàng O + Cadimi",
];

export interface SyncItem {
  name: string;
  meta: string;
  wifiOnly?: boolean;
}

export const SYNC_QUEUE: SyncItem[] = [
  { name: "BM02 · biên bản lấy mẫu", meta: "08:44 · 42 KB" },
  { name: "BM03 · ba tiêu chí + lượng mẫu", meta: "08:41 · 8 KB" },
  { name: "7 ảnh hiện trường", meta: "08:12–08:44 · 18,4 MB", wifiOnly: true },
  { name: "Đề nghị sửa biển số xe", meta: "08:22 · 2 KB" },
];

export const FIELD_PUSH = {
  title: "Bạn được phân công lượt 26100012",
  body: "Kho X, KCN Quang Minh · hẹn 08:00 · Sầu riêng",
};

/* Màn đầu S-05 - danh sách phiếu kiểm nghiệm được giao (lọc theo nhãn). */
export interface MobileTag {
  name: string;
  color: "brand" | "warning" | "danger" | "success" | "informative";
  count: number;
}

export const MOBILE_TAGS: MobileTag[] = [
  { name: "Sầu riêng", color: "success", count: 3 },
  { name: "Xuất khẩu TQ", color: "brand", count: 2 },
  { name: "Gấp", color: "danger", count: 1 },
  { name: "Vàng O", color: "warning", count: 2 },
  { name: "Cadimi", color: "informative", count: 2 },
];

export interface MobileRecord {
  id: string;
  han: string;
  sp: string;
  kh: string;
  state: string;
  tone: "info" | "warning" | "success";
  tags: string[];
}

export const MOBILE_RECORDS: MobileRecord[] = [
  {
    id: "2610001201",
    han: "Hẹn 08:00 · 02/08",
    sp: "Sầu riêng tươi · 5 quả · Vàng O + Cadimi",
    kh: "Cty TNHH XNK Nông sản An Phát",
    state: "Chờ lấy mẫu",
    tone: "warning",
    tags: ["Sầu riêng", "Xuất khẩu TQ", "Gấp"],
  },
  {
    id: "2610001202",
    han: "Hẹn 10:30 · 02/08",
    sp: "Thanh long ruột đỏ · 4 quả · Cadimi",
    kh: "Cty CP Nông sản Bình Minh",
    state: "Đã phân công",
    tone: "info",
    tags: ["Xuất khẩu TQ", "Cadimi"],
  },
  {
    id: "2610001195",
    han: "Đã xong · 01/08",
    sp: "Sầu riêng đông lạnh · 6 quả · Vàng O",
    kh: "Cty TNHH Thực phẩm Tân Việt",
    state: "Đã gửi BM02",
    tone: "success",
    tags: ["Sầu riêng", "Vàng O"],
  },
];

/* S-05 · Phân công lấy mẫu (UC-08, D02) - danh sách nhân viên trong phạm vi CN1. */
export interface SamplerOption {
  id: string;
  name: string;
  load: string;
  state: string;
  tone: "success" | "warning" | "danger";
  available: boolean;
}

export const BM01_PLACE = "Kho X, KCN Quang Minh";

export const SAMPLERS: SamplerOption[] = [
  {
    id: "c",
    name: "Nguyễn Văn C",
    load: "2 lượt hôm nay · KCN Quang Minh",
    state: "Sẵn sàng",
    tone: "success",
    available: true,
  },
  {
    id: "d",
    name: "Lê Minh D",
    load: "4 lượt hôm nay · Tân Cảng",
    state: "Gần đầy lịch",
    tone: "warning",
    available: true,
  },
  {
    id: "e",
    name: "Võ Thị F",
    load: "Nghỉ phép đến 04/08",
    state: "Không khả dụng",
    tone: "danger",
    available: false,
  },
];
