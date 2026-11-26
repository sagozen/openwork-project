/* Trung tâm thông báo (mock) - bám theo mockup DLP LIMS. */

export type NotifCat = "job" | "alert" | "system" | "support";

export interface NotifAction {
  label: string;
  appearance?: "primary" | "secondary";
  to?: string;
}

export interface NotifItem {
  id: string;
  cat: NotifCat;
  unread: boolean;
  tone: "info" | "success" | "warning" | "danger";
  state: string;
  time: string;
  title: string;
  sub: string;
  /** Tác vụ đang chạy: hiển thị ProgressBar. */
  pct?: number;
  actions: NotifAction[];
}

export const NOTIF_TABS: { key: "all" | NotifCat | "unread"; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "job", label: "Công việc" },
  { key: "alert", label: "Cảnh báo" },
  { key: "system", label: "Hệ thống" },
  { key: "support", label: "Hỗ trợ" },
  { key: "unread", label: "Chưa đọc" },
];

export const NOTIF_ITEMS: NotifItem[] = [
  {
    id: "J-01",
    cat: "job",
    unread: true,
    tone: "info",
    state: "Đang chạy",
    time: "vừa xong",
    title: "Xuất 128 phiếu kết quả (PDF)",
    sub: "Đã xử lý 82/128 phiếu · ước tính còn 2 phút",
    pct: 0.64,
    actions: [{ label: "Xem tiến độ", to: "/ho-so" }],
  },
  {
    id: "J-02",
    cat: "job",
    unread: true,
    tone: "warning",
    state: "Hoàn tất một phần",
    time: "09:12",
    title: "Nhập kết quả hàng loạt từ máy ICP-MS",
    sub: "126 dòng thành công · 2 dòng lỗi định dạng",
    actions: [
      { label: "Xem 2 phiếu", appearance: "primary", to: "/ho-so" },
      { label: "Tải file lỗi" },
    ],
  },
  {
    id: "AS-01",
    cat: "job",
    unread: false,
    tone: "success",
    state: "Đã gửi tới điện thoại",
    time: "08:55",
    title: "Phân công lấy mẫu 26100012 → Nguyễn Văn Sáu",
    sub: "02/08/2026 08:00 · Kho X, KCN Quang Minh",
    actions: [{ label: "Mở hồ sơ", to: "/ho-so-chi-tiet/26100012" }],
  },
  {
    id: "AL-01",
    cat: "alert",
    unread: true,
    tone: "warning",
    state: "Cảnh báo",
    time: "08:40",
    title: "2 mẫu cha đã bàn giao chưa được lab chia mã con",
    sub: "26100006 · 26100009 · 26100013",
    actions: [{ label: "Xem danh sách", to: "/ho-so" }],
  },
  {
    id: "AL-02",
    cat: "alert",
    unread: false,
    tone: "danger",
    state: "Quá hạn thanh toán",
    time: "Hôm qua",
    title: "Hồ sơ 26100009 bị khoá lab do quá hạn thanh toán",
    sub: "Cty TNHH Trái cây Phương Nam · quá hạn 3 ngày",
    actions: [{ label: "Mở hồ sơ", to: "/ho-so-chi-tiet/26100009" }],
  },
  {
    id: "SY-01",
    cat: "system",
    unread: false,
    tone: "info",
    state: "Hệ thống",
    time: "31/07",
    title: "Cập nhật tham số hệ thống: hạn trả kết quả mặc định 5 ngày",
    sub: "Người thực hiện: Quản trị viên · áp dụng từ 01/08/2026",
    actions: [{ label: "Xem tham số", to: "/admin/tham-so" }],
  },
  {
    id: "SP-01",
    cat: "support",
    unread: true,
    tone: "info",
    state: "Phản hồi mới",
    time: "15:40",
    title: "HT-26-0007 có phản hồi mới từ Hỗ trợ kỹ thuật",
    sub: "Không in được tem mẫu · dự kiến bản vá 10/08",
    actions: [{ label: "Mở yêu cầu", to: "/ho-tro/yeu-cau/HT-26-0007" }],
  },
  {
    id: "SP-02",
    cat: "support",
    unread: true,
    tone: "warning",
    state: "Chờ bạn phản hồi",
    time: "06/08",
    title: "HT-26-0006 đang chờ bạn làm rõ yêu cầu tính năng",
    sub: "Lọc bảng công việc lab theo chỉ tiêu phân tích",
    actions: [{ label: "Mở yêu cầu", to: "/ho-tro/yeu-cau/HT-26-0006" }],
  },
];
