/* Dữ liệu mẫu màn "Hồ sơ kiểm nghiệm" (S-hoso / S-chitiet) - chuyển thể từ
   prototype design-handoff/DLP LIMS.dc.html. */

export type Tone = "info" | "success" | "warning" | "danger" | "brand" | "important";

export interface RecordRow {
  /** Mã lượt. Hồ sơ còn DRAFT chưa được cấp mã (BR-003) nên dùng id kỹ thuật làm khoá dòng. */
  id: string;
  /** Chỉ có ở hồ sơ DRAFT: mở lại ở màn tạo yêu cầu thay vì màn chi tiết. */
  draftId?: string;
  customer: string;
  product: string;
  /** Hồ sơ nhiều mẫu (CR-20260831-001): tooltip cho cột Sản phẩm khi `product` đã rút gọn dạng
   *  "Thanh long +2". Vắng mặt khi hồ sơ chỉ có một mẫu - không có gì để giải thích thêm. */
  productTooltip?: string;
  criteria: string;
  statusTone: Tone;
  status: string;
  payTone: Tone;
  pay: string;
  due: string;
  tags: string[];
  handler: string;
  branch: string;
  createdAt: string;
}

/** Nhãn hiển thị của dòng: mã lượt, hoặc "Nháp" khi hồ sơ chưa được cấp mã. */
export function recordLabel(r: RecordRow): string {
  return r.draftId ? "Nháp" : r.id;
}

/** Phiếu đang trễ tiến độ hoặc trễ thanh toán - dùng cho điều kiện lọc và nhóm việc quá hạn. */
export function isOverdue(r: RecordRow): boolean {
  return r.statusTone === "danger" || r.status.includes("Quá hạn") || r.pay.includes("Quá hạn");
}

/** Hồ sơ đã có file trung gian: nhãn "Thiếu file" do hệ thống gắn khi còn thiếu. */
export function hasFile(r: RecordRow): boolean {
  return !r.tags.includes("Thiếu file");
}

export const RECORD_STATS: { label: string; value: number; hint: string; tone: Tone }[] = [
  { label: "Chờ phân công lấy mẫu", value: 6, hint: "2 lượt quá giờ hẹn", tone: "warning" },
  { label: "Mẫu chưa về PTN", value: 9, hint: "Đã sinh mã lượt", tone: "info" },
  { label: "Chờ phê duyệt phiếu", value: 4, hint: "Chờ trung bình 3,2 giờ", tone: "brand" },
  { label: "Quá hạn thanh toán", value: 1, hint: "Đã khoá chuyển lab", tone: "danger" },
];

export const RECORD_VIEWS: { id: string; name: string; group: string; count: number }[] = [
  { id: "all", name: "Tất cả phiếu", group: "Chế độ xem hệ thống", count: 6 },
  { id: "today", name: "Phiếu của tôi hôm nay", group: "Chế độ xem hệ thống", count: 4 },
  { id: "cadimi", name: "Cadimi đang xử lý", group: "Chế độ xem được chia sẻ", count: 5 },
  { id: "nofile", name: "Hồ sơ thiếu file trung gian", group: "Chế độ xem được chia sẻ", count: 3 },
  { id: "late", name: "Phiếu quá hạn", group: "Chế độ xem của tôi", count: 2 },
];

export const MOCK_RECORDS: RecordRow[] = [
  {
    id: "26100012",
    customer: "Cty TNHH XNK Nông sản An Phát",
    product: "Sầu riêng",
    criteria: "VO + CD",
    statusTone: "info",
    status: "Chưa về PTN",
    payTone: "warning",
    pay: "Chờ xác nhận",
    due: "Còn 3 ngày",
    tags: ["Chờ tôi xử lý", "Cadimi"],
    handler: "Lê Thị Hồng Vân",
    branch: "CN1 - Đắk Lắk",
    createdAt: "28/07/2026 09:12",
  },
  {
    id: "26100011",
    customer: "Cty CP Thực phẩm Bình Minh",
    product: "Mít",
    criteria: "CD",
    statusTone: "success",
    status: "Đang thử nghiệm",
    payTone: "success",
    pay: "Đã thanh toán",
    due: "-",
    tags: ["Cadimi"],
    handler: "Phạm Văn Đức",
    branch: "CN1 - Đắk Lắk",
    createdAt: "27/07/2026 14:05",
  },
  {
    id: "26100010",
    customer: "HTX Nông nghiệp Tân Lộc",
    product: "Sầu riêng",
    criteria: "VO",
    statusTone: "info",
    status: "Chờ phê duyệt",
    payTone: "success",
    pay: "Đã thanh toán",
    due: "-",
    tags: ["Chờ tôi xử lý"],
    handler: "Trần Minh Khôi",
    branch: "CN2 - Tiền Giang",
    createdAt: "27/07/2026 08:40",
  },
  {
    id: "26100009",
    customer: "Cty TNHH Trái cây Phương Nam",
    product: "Sầu riêng",
    criteria: "VO + CD",
    statusTone: "danger",
    status: "Quá hạn TT · khoá lab",
    payTone: "danger",
    pay: "Quá hạn 7 ngày",
    due: "Hết hạn giữ",
    tags: ["Ưu tiên cao", "Thiếu file"],
    handler: "Lê Thị Hồng Vân",
    branch: "CN2 - Tiền Giang",
    createdAt: "24/07/2026 16:20",
  },
  {
    id: "26100008",
    customer: "Cty CP XNK Đồng Tháp",
    product: "Xoài",
    criteria: "CD",
    statusTone: "warning",
    status: "Chờ phân công",
    payTone: "warning",
    pay: "Chờ xác nhận",
    due: "Còn 5 ngày",
    tags: ["Chờ tôi xử lý"],
    handler: "-",
    branch: "CN3 - Đồng Tháp",
    createdAt: "23/07/2026 10:02",
  },
  {
    id: "26100007",
    customer: "Cty TNHH Vinh Phát",
    product: "Thanh long",
    criteria: "VO",
    statusTone: "success",
    status: "Đang thử nghiệm",
    payTone: "success",
    pay: "Đã thanh toán",
    due: "-",
    tags: [],
    handler: "Phạm Văn Đức",
    branch: "CN1 - Đắk Lắk",
    createdAt: "22/07/2026 09:30",
  },
];

export const RECORD_TAG_GROUPS: { group: string; tags: string[] }[] = [
  { group: "Cần chú ý", tags: ["Chờ tôi xử lý", "Thiếu file"] },
  { group: "Mức ưu tiên", tags: ["Ưu tiên cao"] },
  { group: "Chỉ tiêu", tags: ["Cadimi", "Vàng O"] },
];

/* ---------- Chi tiết hồ sơ ---------- */

export const RECORD_FIELDS: { k: string; v: string; pii?: boolean }[] = [
  { k: "Khách hàng", v: "Cty TNHH XNK Nông sản An Phát", pii: true },
  { k: "Người đại diện", v: "Ngô Thị Kim Chi · 0918 442 117", pii: true },
  { k: "Sản phẩm", v: "Sầu riêng" },
  { k: "Mã số vùng trồng", v: "VN-DL-0417" },
  { k: "Mã cơ sở đóng gói", v: "VN-PH-0092" },
  { k: "Số container", v: "ABCD1234567" },
  { k: "Biển số / rơ-moóc", v: "51C-543.21 · 51R-001.02" },
  { k: "Số seal", v: "SL-889" },
  { k: "Chỉ tiêu", v: "Vàng O · Cadimi" },
  { k: "Địa điểm lấy mẫu", v: "Kho X, KCN Quang Minh" },
  { k: "Hạn trả kết quả", v: "04/08/2026" },
  { k: "Hình thức trả", v: "Email" },
];

export const RECORD_TIMELINE: { what: string; who: string }[] = [
  { what: "Tạo hồ sơ và sinh mã lượt 26100012", who: "Ngô Thị Kim Chi · 28/07/2026 09:12" },
  { what: "Phân công lấy mẫu cho Lê Thị Hồng Vân", who: "Điều phối một cửa · 28/07/2026 10:04" },
  { what: "Hoàn tất lấy mẫu · BM02 ký hai bên", who: "Lê Thị Hồng Vân · 29/07/2026 15:38" },
  { what: "Nhắc thanh toán lần 1", who: "Hệ thống · 30/07/2026 08:00" },
];

export const RECORD_SAMPLING_ASSIGN: { k: string; v: string }[] = [
  { k: "Nhân viên lấy mẫu", v: "Lê Thị Hồng Vân" },
  { k: "Thời gian dự kiến", v: "29/07/2026 · 14:00" },
  { k: "Địa điểm", v: "Kho X, KCN Quang Minh" },
  { k: "Ghi chú điều phối", v: "Liên hệ bảo vệ cổng 2 trước 30 phút" },
  { k: "Người phân công", v: "Điều phối một cửa" },
];

export const RECORD_SAMPLING_SIGN: { k: string; v: string }[] = [
  { k: "Ngày lấy mẫu", v: "29/07/2026" },
  { k: "Giờ bắt đầu / hoàn tất", v: "14:05 → 15:38" },
  { k: "Người lấy mẫu", v: "Lê Thị Hồng Vân" },
  { k: "Đại diện khách hàng", v: "Ngô Thị Kim Chi" },
  { k: "Hình thức ký", v: "Ký canvas trên thiết bị" },
];

export const RECORD_FIELD_CHECK: {
  field: string;
  declared: string;
  actual: string;
  match: boolean;
}[] = [
  { field: "Mã số vùng trồng", declared: "VN-DL-0417", actual: "VN-DL-0417", match: true },
  { field: "Mã cơ sở đóng gói", declared: "VN-PH-0092", actual: "VN-PH-0092", match: true },
  { field: "Số container", declared: "ABCD1234567", actual: "ABCD1234567", match: true },
  { field: "Biển số xe", declared: "51C-543.21", actual: "51C-534.21", match: false },
  { field: "Số rơ-moóc", declared: "51R-001.02", actual: "51R-001.02", match: true },
  { field: "Số seal", declared: "SL-889", actual: "SL-889", match: true },
  { field: "Tên sản phẩm", declared: "Sầu riêng", actual: "Sầu riêng", match: true },
];

/* Kết luận đối soát hiện trường (BR-021 · BR-022). */
export const RECORD_CHECK_CONCLUSION: { state: string; tone: Tone; by: string } = {
  state: "Có sai lệch đã xử lý",
  tone: "warning",
  by: "Kết luận bởi Lê Thị Hồng Vân · 29/07/2026 15:12 · đã gửi đề nghị sửa cho một cửa",
};

export const RECORD_FIX_NOTE = "Nhóm B · sửa qua quy trình yêu cầu sửa hồ sơ";

export const RECORD_FIELD_FIX: {
  field: string;
  from: string;
  to: string;
  reason: string;
  proof: string;
  status: string;
  by: string;
  tone: Tone;
}[] = [
  {
    field: "Biển số xe",
    from: "51C-543.21",
    to: "51C-534.21",
    reason: "Biển số trên chứng từ khác đầu kéo thực tế tại bãi",
    proof: "IMG_2043.jpg · ảnh chụp đầu kéo tại hiện trường",
    status: "Đã duyệt",
    by: "Điều phối một cửa · 29/07 15:40",
    tone: "success",
  },
  {
    field: "Khối lượng mẫu",
    from: "1,5 kg",
    to: "2,0 kg",
    reason: "Lấy thêm mẫu lưu theo SOP",
    proof: "BM03-tem-niem-phong.jpg · biên bản hiện trường",
    status: "Chờ duyệt",
    by: "Lê Thị Hồng Vân · 29/07 15:44",
    tone: "warning",
  },
];

/* 4 · BM02 phần I - khối nhận diện lô hàng. */
export const RECORD_BM02_HEAD: { k: string; v: string; pii?: boolean }[] = [
  { k: "Tên khách hàng", v: "Cty TNHH XNK Nông sản An Phát", pii: true },
  { k: "Địa chỉ khách hàng", v: "Lô C4, KCN Quang Minh, Hà Nội", pii: true },
  { k: "Người đại diện", v: "Ngô Thị Kim Chi · 0918 442 117", pii: true },
  { k: "Mã lượt lấy mẫu", v: "26100012" },
  { k: "Địa điểm lấy mẫu", v: "Kho X, KCN Quang Minh" },
  { k: "Phương pháp lấy mẫu", v: "TCVN 9017:2011" },
  { k: "Số seal niêm phong", v: "SL-889" },
];

/* Lần gửi bản nháp phiếu cho khách (tab Phiếu). */
export const RECORD_DRAFT_SENDS: { who: string; to: string; at: string }[] = [
  {
    who: "Ngô Thị Kim Chi · Một cửa CN1",
    to: "kimchi@anphat-agri.vn (bản nháp có watermark)",
    at: "31/07/2026 16:20",
  },
  {
    who: "Trần Minh Khôi · Trưởng nhóm hoá lý",
    to: "qa@anphat-agri.vn (bản nháp có watermark)",
    at: "01/08/2026 09:05",
  },
];

export const RECORD_DRAFT_NOTE =
  "Bản nháp luôn đóng dấu watermark, không có mã tra cứu và không tính là phát hành.";

export const RECORD_TASK_PROGRESS = "4/6 analysis task đã có kết quả · 2 task đang phân tích";

export const RECORD_SAMPLE_ROWS: {
  name: string;
  zone: string;
  pack: string;
  container: string;
  plate: string;
  trailer: string;
  method: string;
  weight: string;
  criteria: string;
}[] = [
  {
    name: "SR-01",
    zone: "VN-DL-0417",
    pack: "VN-PH-0092",
    container: "ABCD1234567",
    plate: "51C-534.21",
    trailer: "51R-001.02",
    method: "Ngẫu nhiên phân tầng",
    weight: "2,0 kg",
    criteria: "Vàng O",
  },
  {
    name: "SR-02",
    zone: "VN-DL-0417",
    pack: "VN-PH-0092",
    container: "ABCD1234567",
    plate: "51C-534.21",
    trailer: "51R-001.02",
    method: "Ngẫu nhiên phân tầng",
    weight: "2,0 kg",
    criteria: "Cadimi",
  },
  {
    name: "SR-03 (mẫu lưu)",
    zone: "VN-DL-0417",
    pack: "VN-PH-0092",
    container: "ABCD1234567",
    plate: "51C-534.21",
    trailer: "51R-001.02",
    method: "Ngẫu nhiên phân tầng",
    weight: "1,5 kg",
    criteria: "Lưu mẫu",
  },
];

export const RECORD_SEAL_CHECK: { k: string; v: string }[] = [
  { k: "Tem không rách / bong", v: "Đạt" },
  { k: "Đủ chữ ký hai bên", v: "Đạt" },
  { k: "Khớp thông tin BM02", v: "Đạt" },
];

export const RECORD_FILES: { name: string; meta: string }[] = [
  { name: "IMG_2043-hien-truong.jpg", meta: "2,4 MB · 29/07/2026 14:22" },
  { name: "BM03-tem-niem-phong.jpg", meta: "1,8 MB · 29/07/2026 15:31" },
  { name: "BM02-26100012-ky.pdf", meta: "640 KB · 29/07/2026 15:38" },
];

export const RECORD_TASKS: {
  code: string;
  criteria: string;
  part: string;
  owner: string;
  status: string;
  tone: Tone;
  updated: string;
  result: string;
  child?: boolean;
}[] = [
  {
    code: "26100012-M1",
    criteria: "Vàng O",
    part: "Thịt quả",
    owner: "Phạm Văn Đức",
    status: "Đang phân tích",
    tone: "warning",
    updated: "31/07/2026 09:12",
    result: "-",
  },
  {
    code: "26100012-M1-VO",
    criteria: "Vàng O (LC-MS/MS)",
    part: "Thịt quả",
    owner: "Phạm Văn Đức",
    status: "Đang phân tích",
    tone: "warning",
    updated: "31/07/2026 09:12",
    result: "-",
    child: true,
  },
  {
    code: "26100012-M2",
    criteria: "Cadimi",
    part: "Vỏ + thịt quả",
    owner: "Nguyễn Thị Lam",
    status: "Đã có kết quả cuối",
    tone: "success",
    updated: "30/07/2026 16:40",
    result: "0,021 mg/kg",
  },
  {
    code: "26100012-M2-CD",
    criteria: "Cadimi (ICP-MS)",
    part: "Vỏ + thịt quả",
    owner: "Nguyễn Thị Lam",
    status: "Đã có kết quả cuối",
    tone: "success",
    updated: "30/07/2026 16:40",
    result: "0,021 mg/kg",
    child: true,
  },
  {
    code: "26100012-M3",
    criteria: "Lưu mẫu",
    part: "Thịt quả",
    owner: "-",
    status: "Chưa phân công",
    tone: "info",
    updated: "29/07/2026 15:38",
    result: "-",
  },
];

export const RECORD_CERTIFICATES: {
  no: string;
  version: string;
  status: string;
  tone: Tone;
  created: string;
  approver: string;
  lookup: string;
  checksum: string;
}[] = [
  {
    no: "KQ26000045",
    version: "v2",
    status: "Chờ phê duyệt",
    tone: "warning",
    created: "31/07/2026 10:02",
    approver: "Chờ 3 lãnh đạo ký",
    lookup: "26100012-KQ2",
    checksum: "9f3c…a71b",
  },
  {
    no: "KQ26000045",
    version: "v1",
    status: "Đã được thay thế",
    tone: "info",
    created: "30/07/2026 17:20",
    approver: "Trần Minh Khôi",
    lookup: "26100012-KQ1",
    checksum: "1ad0…55e9",
  },
];

export const RECORD_AUDIT: { at: string; what: string; delta: string; who: string }[] = [
  {
    at: "31/07/2026 10:02",
    what: "Tạo phiên bản phiếu v2",
    delta: "v1 → v2",
    who: "Phạm Văn Đức",
  },
  {
    at: "30/07/2026 11:15",
    what: "Sửa email nhận kết quả",
    delta: "an.nguyen@example.com → results@example.com",
    who: "Ngô Thị Kim Chi",
  },
  {
    at: "29/07/2026 16:05",
    what: "Duyệt đề nghị sửa biển số",
    delta: "51C-543.21 → 51C-534.21",
    who: "Điều phối một cửa",
  },
  {
    at: "29/07/2026 15:38",
    what: "Hoàn tất lấy mẫu · BM02 ký hai bên",
    delta: "Chờ lấy mẫu → Chưa về PTN",
    who: "Lê Thị Hồng Vân",
  },
  {
    at: "28/07/2026 09:12",
    what: "Tạo hồ sơ và sinh mã lượt",
    delta: "- → 26100012",
    who: "Ngô Thị Kim Chi",
  },
];

export const RECORD_ACCESS_LOG: { who: string; at: string }[] = [
  { who: "Trần Minh Khôi · xem thông tin khách hàng", at: "31/07/2026 08:44" },
  { who: "Ngô Thị Kim Chi · xuất dữ liệu hồ sơ", at: "30/07/2026 09:01" },
];

export const PII_MASK = "- ẩn theo phân quyền -";
