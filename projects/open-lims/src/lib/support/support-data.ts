/* Dữ liệu mock cho khu Hỗ trợ người dùng (help center kiểu Zendesk rút gọn). */

export type TicketKind = "bug" | "help" | "feature";
export type TicketState = "new" | "processing" | "waiting" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type SupTone = "info" | "success" | "warning" | "danger" | "neutral";

export const BUG_CR_LOG_URL =
  "https://docs.google.com/spreadsheets/d/1W61dmvIRLYl6YTvhTufKs6MQu0J7r5BxPIH1DHElNeQ/edit?usp=sharing";

export const TICKET_KIND_TEXT: Record<TicketKind, string> = {
  bug: "Lỗi phần mềm",
  help: "Hỗ trợ sử dụng",
  feature: "Đề xuất tính năng",
};

export const TICKET_STATE_TEXT: Record<TicketState, { label: string; tone: SupTone }> = {
  new: { label: "Mới", tone: "info" },
  processing: { label: "Đang xử lý", tone: "warning" },
  waiting: { label: "Chờ phản hồi", tone: "danger" },
  resolved: { label: "Đã giải quyết", tone: "success" },
  closed: { label: "Đã đóng", tone: "neutral" },
};

export const TICKET_PRIORITY_TEXT: Record<TicketPriority, string> = {
  low: "Thấp",
  normal: "Bình thường",
  high: "Cao",
  urgent: "Khẩn cấp",
};

/** Danh sách màn hình để người dùng chỉ đúng chỗ gặp vấn đề. */
export const SUPPORT_SCREENS: { key: string; label: string }[] = [
  { key: "S-02", label: "Tạo yêu cầu kiểm nghiệm" },
  { key: "S-05", label: "Lấy mẫu hiện trường" },
  { key: "S-07", label: "Tiếp nhận mẫu" },
  { key: "S-09", label: "Bàn giao vào lab" },
  { key: "S-10", label: "Hồ sơ kiểm nghiệm" },
  { key: "S-14", label: "Bảng công việc lab" },
  { key: "S-15", label: "Nhập kết quả" },
  { key: "S-17", label: "Kiểm tra kỹ thuật" },
  { key: "S-18", label: "Phê duyệt phiếu" },
  { key: "S-16", label: "Trả kết quả" },
  { key: "A-01", label: "Người dùng và vai trò" },
  { key: "other", label: "Khác / không rõ màn hình" },
];

export interface SupportMessage {
  id: string;
  author: string;
  role: string;
  side: "user" | "agent";
  time: string;
  body: string;
}

export interface SupportTicket {
  id: string;
  kind: TicketKind;
  title: string;
  summary: string;
  state: TicketState;
  priority: TicketPriority;
  screen: string;
  createdAt: string;
  updatedAt: string;
  sla: string;
  unread: boolean;
  messages: SupportMessage[];
}

export interface SupportDoc {
  id: string;
  group: string;
  title: string;
  desc: string;
  version: string;
  updated: string;
  size: string;
  /** Chưa có file thật → hiện trạng thái "Sắp cập nhật" thay vì link chết. */
  url?: string;
}

export interface FaqItem {
  id: string;
  cat: string;
  q: string;
  a: string;
}

export const SUPPORT_DOC_GROUPS = [
  "Hướng dẫn sử dụng theo vai trò",
  "Quy trình nghiệp vụ",
  "Biểu mẫu BM",
  "Ghi chú phiên bản",
] as const;

export const SUPPORT_DOCS: SupportDoc[] = [
  {
    id: "D-01",
    group: "Hướng dẫn sử dụng theo vai trò",
    title: "HDSD - Nhân viên tiếp nhận mẫu",
    desc: "Tiếp nhận, chia mẫu, in tem và bàn giao vào phòng thử nghiệm.",
    version: "v2.4",
    updated: "02/08/2026",
    size: "3,2 MB",
  },
  {
    id: "D-02",
    group: "Hướng dẫn sử dụng theo vai trò",
    title: "HDSD - Thí nghiệm viên",
    desc: "Nhận task, nhập kết quả và nhập hàng loạt từ file máy đo.",
    version: "v2.4",
    updated: "02/08/2026",
    size: "2,8 MB",
  },
  {
    id: "D-03",
    group: "Hướng dẫn sử dụng theo vai trò",
    title: "HDSD - Trưởng nhóm & người phê duyệt",
    desc: "Kiểm tra kỹ thuật, phê duyệt và phát hành phiếu kết quả.",
    version: "v2.3",
    updated: "28/07/2026",
    size: "2,1 MB",
  },
  {
    id: "D-04",
    group: "Hướng dẫn sử dụng theo vai trò",
    title: "HDSD - Quản trị hệ thống",
    desc: "Người dùng, vai trò, chi nhánh, danh mục và tham số hệ thống.",
    version: "v2.2",
    updated: "20/07/2026",
    size: "4,0 MB",
  },
  {
    id: "D-05",
    group: "Quy trình nghiệp vụ",
    title: "Quy trình kiểm nghiệm tổng thể",
    desc: "Sơ đồ luồng từ yêu cầu tới phát hành kết quả kèm mốc SLA từng bước.",
    version: "v1.6",
    updated: "15/07/2026",
    size: "1,4 MB",
  },
  {
    id: "D-06",
    group: "Quy trình nghiệp vụ",
    title: "Quy định lưu vết & sửa hồ sơ sau phát hành",
    desc: "Điều kiện thu hồi, sửa hồ sơ, ghi audit và tái phát hành phiếu.",
    version: "v1.2",
    updated: "10/07/2026",
    size: "980 KB",
  },
  {
    id: "D-07",
    group: "Biểu mẫu BM",
    title: "BM01 - Phiếu yêu cầu kiểm nghiệm",
    desc: "Biểu mẫu in kèm khi tiếp nhận mẫu tại quầy hoặc hiện trường.",
    version: "v3.0",
    updated: "01/08/2026",
    size: "260 KB",
  },
  {
    id: "D-08",
    group: "Biểu mẫu BM",
    title: "BM03 - Biên bản lấy mẫu hiện trường",
    desc: "Mẫu biên bản có chữ ký khách hàng dùng cho app lấy mẫu.",
    version: "v3.0",
    updated: "01/08/2026",
    size: "310 KB",
  },
  {
    id: "D-09",
    group: "Ghi chú phiên bản",
    title: "Release notes 2026.08",
    desc: "Bổ sung bảng công việc lab, phân công theo drawer, thanh tab dưới cho điện thoại.",
    version: "2026.08",
    updated: "09/08/2026",
    size: "180 KB",
  },
  {
    id: "D-10",
    group: "Ghi chú phiên bản",
    title: "Release notes 2026.09 (dự kiến)",
    desc: "Trung tâm hỗ trợ người dùng, thông báo phản hồi yêu cầu.",
    version: "2026.09",
    updated: "Dự kiến 01/09/2026",
    size: "-",
  },
];

export const FAQ_CATS = [
  "Tài khoản & đăng nhập",
  "Tiếp nhận & mẫu",
  "Kết quả & phê duyệt",
  "In ấn & tệp tin",
] as const;

export const FAQ_ITEMS: FaqItem[] = [
  {
    id: "F-01",
    cat: "Tài khoản & đăng nhập",
    q: "Tôi quên mật khẩu hoặc không đăng nhập được thì làm thế nào?",
    a: "Dùng liên kết “Quên mật khẩu” ở màn đăng nhập để nhận email đặt lại. Nếu tài khoản bị khoá do nghỉ việc hoặc quá số lần sai, hãy gửi yêu cầu hỗ trợ để quản trị mở khoá - hệ thống ghi audit mọi lần mở khoá.",
  },
  {
    id: "F-02",
    cat: "Tài khoản & đăng nhập",
    q: "Vì sao tôi không thấy một số menu như đồng nghiệp?",
    a: "Menu hiển thị theo quyền của vai trò được gán (mặc định từ chối). Kiểm tra vai trò trong Hồ sơ cá nhân; nếu thiếu quyền cần thiết, gửi yêu cầu hỗ trợ nêu rõ màn hình và thao tác cần dùng.",
  },
  {
    id: "F-03",
    cat: "Tiếp nhận & mẫu",
    q: "Tiếp nhận sai thông tin khách hàng thì sửa ở đâu?",
    a: "Trước khi bàn giao vào lab, sửa trực tiếp tại màn Tiếp nhận. Sau khi đã bàn giao, dùng “Đề nghị sửa” để gửi yêu cầu kèm ảnh bằng chứng; người có quyền duyệt sẽ xác nhận và hệ thống lưu vết thay đổi.",
  },
  {
    id: "F-04",
    cat: "Tiếp nhận & mẫu",
    q: "Một mẫu cha chia thành nhiều mẫu con thì mã được đánh thế nào?",
    a: "Mã con kế thừa mã cha kèm hậu tố thứ tự khi chia mẫu ở bước bàn giao. Không tự đặt mã thủ công để tránh lệch với tem in.",
  },
  {
    id: "F-05",
    cat: "Kết quả & phê duyệt",
    q: "Nhập kết quả hàng loạt từ file máy đo bị lỗi định dạng?",
    a: "Tải đúng mẫu file ở nút “Nhập từ Excel”, giữ nguyên tên cột và đơn vị. Các dòng lỗi được liệt kê riêng để sửa và nhập lại; các dòng hợp lệ vẫn được ghi nhận.",
  },
  {
    id: "F-06",
    cat: "Kết quả & phê duyệt",
    q: "Phiếu đã phát hành có thu hồi được không?",
    a: "Có. Tại màn Trả kết quả, chọn “Thu hồi” và nêu lý do; phiếu chuyển trạng thái thu hồi, bản PDF cũ bị vô hiệu và mọi thao tác đều được ghi vào nhật ký.",
  },
  {
    id: "F-07",
    cat: "In ấn & tệp tin",
    q: "In tem mẫu bị lệch hoặc không ra máy in?",
    a: "Kiểm tra khổ tem trong tham số hệ thống và chọn đúng máy in nhãn ở hộp thoại in. Nếu vẫn lệch, gửi yêu cầu hỗ trợ kèm ảnh tem in thử.",
  },
  {
    id: "F-08",
    cat: "In ấn & tệp tin",
    q: "Tải phiếu PDF nhưng file không mở được?",
    a: "Thử tải lại sau khi tác vụ xuất hoàn tất 100% trong ngăn Thông báo. File chỉ hợp lệ khi tác vụ báo “Hoàn tất”.",
  },
];

export const SEED_TICKETS: SupportTicket[] = [
  {
    id: "HT-26-0007",
    kind: "bug",
    title: "Không in được tem mẫu trên máy trạm quầy tiếp nhận",
    summary: "Hộp thoại in hiện ra nhưng máy in nhãn không nhận lệnh.",
    state: "processing",
    priority: "high",
    screen: "S-07",
    createdAt: "07/08/2026 09:12",
    updatedAt: "08/08/2026 15:40",
    sla: "Còn 6 giờ",
    unread: true,
    messages: [
      {
        id: "m1",
        author: "Bạn",
        role: "Người gửi",
        side: "user",
        time: "07/08/2026 09:12",
        body: "Từ sáng nay máy trạm quầy 2 không in được tem. Hộp thoại in vẫn hiện, chọn máy in nhãn rồi bấm In thì không có phản hồi.",
      },
      {
        id: "m2",
        author: "Trần Hải Đăng",
        role: "Hỗ trợ kỹ thuật",
        side: "agent",
        time: "07/08/2026 10:05",
        body: "Cảm ơn anh/chị. Nhờ kiểm tra giúp driver máy in nhãn trên máy trạm và chụp màn hình hộp thoại in.",
      },
      {
        id: "m3",
        author: "Bạn",
        role: "Người gửi",
        side: "user",
        time: "08/08/2026 08:20",
        body: "Đã cài lại driver nhưng vẫn vậy. Máy trạm quầy 1 in bình thường.",
      },
      {
        id: "m4",
        author: "Trần Hải Đăng",
        role: "Hỗ trợ kỹ thuật",
        side: "agent",
        time: "08/08/2026 15:40",
        body: "Chúng tôi đã tái hiện được lỗi khi khổ tem trong tham số hệ thống khác khổ nạp trong máy. Bản vá dự kiến phát hành 10/08.",
      },
    ],
  },
  {
    id: "HT-26-0006",
    kind: "feature",
    title: "Cho phép lọc bảng công việc lab theo chỉ tiêu phân tích",
    summary: "Nhóm hoá lý cần lọc nhanh theo chỉ tiêu để chia việc buổi sáng.",
    state: "waiting",
    priority: "normal",
    screen: "S-14",
    createdAt: "05/08/2026 14:30",
    updatedAt: "06/08/2026 09:15",
    sla: "Đang chờ bạn phản hồi",
    unread: true,
    messages: [
      {
        id: "m1",
        author: "Bạn",
        role: "Người gửi",
        side: "user",
        time: "05/08/2026 14:30",
        body: "Đề xuất thêm bộ lọc theo chỉ tiêu phân tích ở bảng công việc, hiện chỉ lọc được theo người phụ trách.",
      },
      {
        id: "m2",
        author: "Nguyễn Bảo Trâm",
        role: "Quản lý sản phẩm",
        side: "agent",
        time: "06/08/2026 09:15",
        body: "Đề xuất hợp lý. Anh/chị cho biết thường lọc theo nhóm chỉ tiêu (hoá lý, vi sinh) hay từng chỉ tiêu cụ thể?",
      },
    ],
  },
  {
    id: "HT-26-0005",
    kind: "help",
    title: "Hướng dẫn thu hồi phiếu đã gửi khách hàng",
    summary: "Cần quy trình chuẩn khi phát hiện sai số liệu sau khi gửi.",
    state: "resolved",
    priority: "normal",
    screen: "S-16",
    createdAt: "01/08/2026 10:02",
    updatedAt: "02/08/2026 11:20",
    sla: "Đã xử lý trong 1 ngày",
    unread: false,
    messages: [
      {
        id: "m1",
        author: "Bạn",
        role: "Người gửi",
        side: "user",
        time: "01/08/2026 10:02",
        body: "Phiếu 26100009 đã gửi khách nhưng phát hiện sai đơn vị của một chỉ tiêu, xử lý thế nào?",
      },
      {
        id: "m2",
        author: "Trần Hải Đăng",
        role: "Hỗ trợ kỹ thuật",
        side: "agent",
        time: "02/08/2026 11:20",
        body: "Vào màn Trả kết quả, chọn Thu hồi và nêu lý do. Sau đó sửa hồ sơ và phát hành lại. Chi tiết xem tài liệu “Quy định lưu vết và sửa hồ sơ sau phát hành”.",
      },
    ],
  },
  {
    id: "HT-26-0004",
    kind: "bug",
    title: "Tìm kiếm toàn cục không ra hồ sơ theo tên khách hàng",
    summary: "Nhập tên khách hàng không có kết quả, nhập mã hồ sơ thì ra.",
    state: "closed",
    priority: "low",
    screen: "S-10",
    createdAt: "24/07/2026 16:40",
    updatedAt: "27/07/2026 08:10",
    sla: "Đã đóng",
    unread: false,
    messages: [
      {
        id: "m1",
        author: "Bạn",
        role: "Người gửi",
        side: "user",
        time: "24/07/2026 16:40",
        body: "Tìm theo tên khách hàng không ra kết quả nào.",
      },
      {
        id: "m2",
        author: "Trần Hải Đăng",
        role: "Hỗ trợ kỹ thuật",
        side: "agent",
        time: "27/07/2026 08:10",
        body: "Tài khoản của anh/chị chưa có quyền xem thông tin khách hàng (PII) nên kết quả bị ẩn. Đã cấp quyền, vui lòng đăng nhập lại.",
      },
    ],
  },
];

export function nextTicketId(existing: SupportTicket[]): string {
  const nums = existing
    .map((t) => Number.parseInt(t.id.split("-")[2] ?? "", 10))
    .filter((n) => Number.isFinite(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `HT-26-${String(next).padStart(4, "0")}`;
}
