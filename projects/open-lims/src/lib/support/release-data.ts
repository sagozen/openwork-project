/* Ghi chú phiên bản DLP LIMS - lịch sử thay đổi và lộ trình sắp tới. */

export type ReleaseStatus = "current" | "released" | "planned";
export type ChangeKind = "new" | "improve" | "fix";

export interface ReleaseChange {
  kind: ChangeKind;
  area: string;
  text: string;
}

export interface ReleaseEntry {
  version: string;
  name: string;
  date: string;
  status: ReleaseStatus;
  summary: string;
  changes: ReleaseChange[];
}

export const APP_VERSION = "2026.08.2";
export const APP_BUILD = "build 20260809.1";
export const APP_RELEASED_AT = "09/08/2026";

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  new: "Mới",
  improve: "Cải tiến",
  fix: "Sửa lỗi",
};

export const RELEASES: ReleaseEntry[] = [
  {
    version: "2026.08.2",
    name: "Trung tâm hỗ trợ người dùng",
    date: "09/08/2026",
    status: "current",
    summary:
      "Bổ sung khu Hỗ trợ người dùng: tài liệu HDSD, gửi yêu cầu hỗ trợ/lỗi/tính năng, theo dõi phản hồi và câu hỏi thường gặp.",
    changes: [
      {
        kind: "new",
        area: "Hỗ trợ",
        text: "Trung tâm hỗ trợ với tìm kiếm chung cho tài liệu, FAQ và yêu cầu.",
      },
      {
        kind: "new",
        area: "Hỗ trợ",
        text: "Gửi và theo dõi yêu cầu hỗ trợ, báo lỗi, đề xuất tính năng dạng hội thoại.",
      },
      {
        kind: "new",
        area: "Hỗ trợ",
        text: "Thư viện tài liệu PDF theo nhóm: HDSD theo vai trò, quy trình, biểu mẫu.",
      },
      {
        kind: "improve",
        area: "Thông báo",
        text: "Thêm nhóm thông báo “Hỗ trợ” và huy hiệu chưa đọc trên menu chính.",
      },
    ],
  },
  {
    version: "2026.08.1",
    name: "Phân công & giao diện điện thoại",
    date: "02/08/2026",
    status: "released",
    summary:
      "Chuẩn hoá phân công hồ sơ và công việc lab theo cùng một ngăn thao tác, hoàn thiện giao diện điện thoại cho lấy mẫu hiện trường.",
    changes: [
      {
        kind: "new",
        area: "Lab",
        text: "Bảng công việc lab kèm bộ đếm bộ lọc và phân công hàng loạt.",
      },
      {
        kind: "improve",
        area: "Phân công",
        text: "Ngăn phân công hiển thị trạng thái và tải việc của từng người.",
      },
      {
        kind: "improve",
        area: "Điện thoại",
        text: "Thanh tab dưới cho các nghiệp vụ hay dùng; biểu mẫu xếp dọc dưới 640px.",
      },
      {
        kind: "fix",
        area: "Hiện trường",
        text: "Chặn tiếp tục khi đối soát hiện trường còn sai lệch chưa xử lý.",
      },
    ],
  },
  {
    version: "2026.07",
    name: "Hồ sơ kiểm nghiệm & không gian làm việc",
    date: "15/07/2026",
    status: "released",
    summary:
      "Màn hồ sơ kiểm nghiệm với nhiều phương án bố cục, lưu chế độ xem theo nhóm và quản lý cột hiển thị.",
    changes: [
      {
        kind: "new",
        area: "Hồ sơ",
        text: "Bố cục dày, danh sách việc và bảng kanban; lưu chế độ xem riêng.",
      },
      { kind: "new", area: "Hồ sơ", text: "Ngăn bộ lọc nâng cao và quản lý hiển thị/sắp xếp cột." },
      {
        kind: "improve",
        area: "Bảo mật",
        text: "Che dữ liệu cá nhân khách hàng theo quyền và ghi vết mỗi lần xem.",
      },
    ],
  },
  {
    version: "2026.06",
    name: "Nền tảng LIMS & quản trị",
    date: "20/06/2026",
    status: "released",
    summary:
      "Phiên bản nền: đăng nhập một lần, phân quyền theo vai trò, quản trị người dùng, chi nhánh, danh mục và tham số.",
    changes: [
      {
        kind: "new",
        area: "Xác thực",
        text: "Đăng nhập tập trung, mời người dùng và khoá tài khoản có ghi audit.",
      },
      {
        kind: "new",
        area: "Quản trị",
        text: "Ma trận vai trò – quyền, quản lý chi nhánh, danh mục chỉ tiêu và tham số.",
      },
      {
        kind: "new",
        area: "Nghiệp vụ",
        text: "Luồng đầy đủ từ tạo yêu cầu, tiếp nhận, chia mẫu tới phát hành kết quả.",
      },
    ],
  },
];

export const UPCOMING: ReleaseEntry[] = [
  {
    version: "2026.09",
    name: "Báo cáo & bảng điều khiển",
    date: "Dự kiến 01/09/2026",
    status: "planned",
    summary: "Bảng điều khiển năng suất theo chi nhánh, báo cáo SLA và xuất Excel theo kỳ.",
    changes: [
      {
        kind: "new",
        area: "Báo cáo",
        text: "Bảng điều khiển SLA: tồn đọng, trễ hạn, năng suất theo thí nghiệm viên.",
      },
      { kind: "new", area: "Báo cáo", text: "Xuất báo cáo Excel/PDF theo kỳ và theo khách hàng." },
      {
        kind: "improve",
        area: "Hỗ trợ",
        text: "Đánh giá mức hài lòng sau khi yêu cầu hỗ trợ được đóng.",
      },
    ],
  },
  {
    version: "2026.10",
    name: "Kết nối máy đo & ký số",
    date: "Dự kiến 15/10/2026",
    status: "planned",
    summary: "Nhận kết quả trực tiếp từ máy đo và ký số phiếu kết quả trước khi phát hành.",
    changes: [
      { kind: "new", area: "Lab", text: "Kết nối máy đo để nạp kết quả tự động, giảm nhập tay." },
      {
        kind: "new",
        area: "Phê duyệt",
        text: "Ký số phiếu kết quả kèm dấu thời gian và kiểm tra toàn vẹn.",
      },
      {
        kind: "improve",
        area: "Khách hàng",
        text: "Gửi kết quả qua email kèm liên kết tra cứu có hạn.",
      },
    ],
  },
];
