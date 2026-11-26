/* Dữ liệu mẫu cho khu vực quản trị - chuyển thể từ prototype
   design-handoff/DLP LIMS.dc.html (màn A-00 → A-12). */

import { PERM, ROLE_IDS, ROLE_LABELS, ROLE_PERMISSIONS, type RoleId } from "@/lib/admin/rbac";

export interface AdminUser {
  id: string;
  code: string;
  name: string;
  email: string;
  /** "Vai trò · chi nhánh" như prototype */
  roles: string;
  roleId: string;
  branch: string;
  /** Mã chi nhánh thật để nạp sẵn bộ chọn phân quyền; chỉ có ở chế độ Clerk (`branch` là chuỗi
   *  hiển thị, không dùng gửi lên `PUT /users/{id}/role-assignments` được). */
  branchIds?: string[];
  /** Quyền cấp riêng ngoài vai trò, lấy từ danh bạ backend. */
  extraPermissionIds?: string[];
  status: "active" | "invited" | "off";
  lastLogin: string;
  /** Chức danh in dưới chữ ký trên phiếu kết quả (`IamUser.jobTitle`); chỉ có ở chế độ Clerk. */
  jobTitle?: string;
  /** Người này có đang là chỗ dựa quản trị của đơn vị không (`IamUser.administers`); chỉ có ở chế
   *  độ Clerk — dữ liệu mẫu không có máy chủ nào tính hộ. */
  administers?: boolean;
  /** hạn lời mời (chỉ với status = invited) */
  expires?: string;
  invitationId?: string;
}

export interface AdminRole {
  id: RoleId;
  name: string;
  description: string;
  users: number;
  perms: string[];
  system: boolean;
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  address: string;
  phone: string;
  users: number;
  active: boolean;
}

export interface CatalogItem {
  id: string;
  code: string;
  name: string;
  group: string;
  unit: string;
  active: boolean;
}

export interface SystemParam {
  id: string;
  key: string;
  label: string;
  value: string;
  group: string;
  hint: string;
}

export interface AdminMenuItem {
  code: string;
  to: string;
  label: string;
  hint: string;
  perm: string;
  title: string;
  subtitle: string;
  crumb: string;
}

export interface AdminMenuGroup {
  group: string;
  items: AdminMenuItem[];
}

export const ADMIN_MENU: AdminMenuGroup[] = [
  {
    group: "Tổng quan",
    items: [
      {
        code: "A-00",
        to: "/admin",
        label: "Trang cài đặt",
        hint: "Điểm vào các nhóm cấu hình",
        perm: "admin.view",
        title: "Cài đặt hệ thống",
        subtitle: "Chỉ hiện mục mà tài khoản có quyền · mọi thay đổi đều ghi audit",
        crumb: "Tổng quan",
      },
    ],
  },
  {
    group: "Người dùng & quyền",
    items: [
      {
        code: "A-01a",
        to: "/admin/nguoi-dung",
        label: "Người dùng",
        hint: "Mời, phân quyền, vô hiệu hoá",
        perm: "user.read",
        title: "Người dùng",
        subtitle: "Mời qua email, gán vai trò × chi nhánh, vô hiệu hoá khi nghỉ việc",
        crumb: "Người dùng",
      },
      {
        code: "A-01d",
        to: "/admin/vai-tro",
        label: "Vai trò & quyền",
        hint: "Ma trận permission theo miền nghiệp vụ",
        perm: "user.manage",
        title: "Vai trò & quyền",
        subtitle: "Bảy vai trò chuẩn; quyền nhạy cảm bị khoá theo quy định",
        crumb: "Vai trò & quyền",
      },
    ],
  },
  {
    group: "Tổ chức & danh mục",
    items: [
      {
        code: "A-02",
        to: "/admin/chi-nhanh",
        label: "Chi nhánh",
        hint: "Mã tham gia quy tắc sinh mã hồ sơ",
        perm: "user.manage",
        title: "Chi nhánh & danh mục",
        subtitle: "Khuôn màn danh mục dùng chung: mã · tên đa ngữ · hiệu lực · phiên bản",
        crumb: "Chi nhánh",
      },
      {
        code: "A-03",
        to: "/admin/danh-muc",
        label: "Danh mục nghiệp vụ",
        hint: "Loại mẫu, chỉ tiêu/LOD-LOQ, phương pháp thử",
        perm: "user.manage",
        title: "Danh mục nghiệp vụ",
        subtitle:
          "Chỉ tiêu, LOD/LOQ, phương pháp thử - sửa trường ảnh hưởng phiếu thì tạo phiên bản mới",
        crumb: "Danh mục nghiệp vụ",
      },
    ],
  },
  {
    group: "Hệ thống",
    items: [
      {
        code: "A-09",
        to: "/admin/nhat-ky",
        label: "Nhật ký hệ thống",
        hint: "Tra ai đã làm gì, trên đối tượng nào",
        perm: PERM.AUDIT_READ,
        title: "Nhật ký hệ thống",
        subtitle: "Tra cứu toàn hệ theo người thực hiện · hành động · đối tượng · khoảng thời gian",
        crumb: "Nhật ký hệ thống",
      },
      {
        code: "A-12",
        to: "/admin/tham-so",
        label: "Tham số vận hành",
        hint: "Bốn tham số mở trong giao diện quản trị",
        perm: "user.manage",
        title: "Tham số vận hành",
        subtitle: "Bốn tham số nghiệp vụ mở cho quản trị, có giá trị mặc định và audit",
        crumb: "Tham số vận hành",
      },
    ],
  },
];

export const ADMIN_SECTIONS: AdminMenuItem[] = ADMIN_MENU.flatMap((g) => g.items).filter(
  (i) => i.to !== "/admin",
);

export const ADMIN_ROLE_OPTIONS: { value: RoleId; label: string }[] = ROLE_IDS.map((id) => ({
  value: id,
  label: ROLE_LABELS[id],
}));

export const NAV_GROUPS = [
  {
    section: "Vận hành",
    items: [
      { to: "/", label: "Cổng tra cứu", badge: "" },
      { to: "/admin", label: "Quản trị hệ thống", badge: "" },
    ],
  },
] as const;

export const MOCK_USERS: AdminUser[] = [
  {
    id: "u1",
    code: "NV-0142",
    name: "Phạm Bảo Ngọc",
    email: "ngoc.pb@dalienphat.vn",
    roles: "Nhân viên một cửa · CN1",
    roleId: "motcua",
    branch: "CN1",
    status: "active",
    lastLogin: "Hôm nay 08:02",
  },
  {
    id: "u2",
    code: "NV-0087",
    name: "Trần Minh Quân",
    email: "quan.tm@dalienphat.vn",
    roles: "QL một cửa · CN1, CN9",
    roleId: "qlmotcua",
    branch: "CN1",
    status: "active",
    lastLogin: "Hôm nay 07:41",
  },
  {
    id: "u3",
    code: "NV-0203",
    name: "Nguyễn Thị Hà",
    email: "ha.nt@dalienphat.vn",
    roles: "NV lab · CN1",
    roleId: "lab",
    branch: "CN1",
    status: "active",
    lastLogin: "Hôm nay 09:15",
  },
  {
    id: "u4",
    code: "NV-0061",
    name: "Trần Ngọc E",
    email: "e.tn@dalienphat.vn",
    roles: "Trưởng nhóm kỹ thuật · CN1",
    roleId: "truongnhom",
    branch: "CN1",
    status: "active",
    lastLogin: "Hôm qua 16:30",
  },
  {
    id: "u5",
    code: "NV-0004",
    name: "Lê Anh Tuấn",
    email: "tuan.la@dalienphat.vn",
    roles: "Lãnh đạo ký · toàn hệ thống",
    roleId: "lanhdao",
    branch: "Toàn hệ thống",
    status: "active",
    lastLogin: "Hôm nay 08:41",
  },
  {
    id: "u6",
    code: "NV-0288",
    name: "Vũ Hoàng Nam",
    email: "nam.vh@dalienphat.vn",
    roles: "NV lấy mẫu (giám định viên) · CN1",
    roleId: "hientruong",
    branch: "CN1",
    status: "invited",
    lastLogin: "-",
    expires: "05/08",
  },
  {
    id: "u7",
    code: "NV-0175",
    name: "Võ Thị F",
    email: "f.vt@dalienphat.vn",
    roles: "NV lấy mẫu (giám định viên) · CN1",
    roleId: "hientruong",
    branch: "CN1",
    status: "off",
    lastLogin: "28/07 17:02",
  },
];

/* Bảy vai trò nội bộ. Tập quyền KHÔNG khai báo lại ở đây mà lấy nguyên từ ROLE_PERMISSIONS
   (rbac.ts) - trước đây chép tay hai bản nên persona đăng nhập và danh mục vai trò ở khu quản
   trị đã lệch nhau. Chỉ phần mô tả và số người dùng là dữ liệu mẫu riêng của màn quản trị. */
const ROLE_PROFILE: Record<RoleId, { description: string; users: number; system: boolean }> = {
  admin: {
    description: "Quản trị người dùng, vai trò, danh mục và tham số. Không mở hồ sơ kiểm nghiệm.",
    users: 1,
    system: true,
  },
  lab: {
    description: "Tự nhận task, nhập kết quả, chia mã con và nhận mẫu vào lab.",
    users: 6,
    system: false,
  },
  lanhdao: {
    description: "Theo dõi tiến độ lab (chỉ đọc), phê duyệt, ký và phát hành phiếu kết quả.",
    users: 3,
    system: true,
  },
  motcua: {
    description: "Số hoá BM01, tiếp nhận mẫu, bàn giao và trả kết quả trong phạm vi chi nhánh.",
    users: 4,
    system: false,
  },
  qlmotcua: {
    description: "Quyền của một cửa, thêm phân công lấy mẫu, duyệt thay đổi và ngoại lệ.",
    users: 2,
    system: false,
  },
  hientruong: {
    description: "Ghi BM02/BM03 tại hiện trường, chỉ thấy lượt được phân công.",
    users: 5,
    system: false,
  },
  truongnhom: {
    description: "Phân công task, kiểm tra kỹ thuật và xem lưu vết phiên bản kết quả.",
    users: 2,
    system: false,
  },
};

export const MOCK_ROLES: AdminRole[] = ROLE_IDS.map((id) => ({
  id,
  name: ROLE_LABELS[id],
  perms: ROLE_PERMISSIONS[id],
  ...ROLE_PROFILE[id],
}));

export const MOCK_BRANCHES: Branch[] = [
  {
    id: "b1",
    code: "HO",
    name: "Trụ sở chính",
    address: "12 Nguyễn Văn Trỗi, Q. Phú Nhuận, TP.HCM",
    phone: "028 3844 1122",
    users: 18,
    active: true,
  },
  {
    id: "b2",
    code: "BD",
    name: "CN Bình Dương",
    address: "Lô C14, KCN Sóng Thần 2, TP. Dĩ An",
    phone: "0274 3756 880",
    users: 22,
    active: true,
  },
  {
    id: "b3",
    code: "DN",
    name: "CN Đồng Nai",
    address: "45 Đường 2, KCN Biên Hoà 2, TP. Biên Hoà",
    phone: "0251 3836 447",
    users: 14,
    active: true,
  },
  {
    id: "b4",
    code: "LA",
    name: "CN Long An",
    address: "QL1A, xã Nhựt Chánh, H. Bến Lức",
    phone: "0272 3871 265",
    users: 7,
    active: false,
  },
];

export const CATALOG_GROUPS = [
  { id: "chi-tieu", label: "Chỉ tiêu thử nghiệm" },
  { id: "phuong-phap", label: "Phương pháp" },
  { id: "don-vi", label: "Đơn vị đo" },
  { id: "loai-mau", label: "Loại mẫu" },
] as const;

export const MOCK_CATALOG: CatalogItem[] = [
  {
    id: "c1",
    code: "CT-001",
    name: "Cường độ chịu nén",
    group: "chi-tieu",
    unit: "MPa",
    active: true,
  },
  { id: "c2", code: "CT-002", name: "Độ sụt bê tông", group: "chi-tieu", unit: "cm", active: true },
  { id: "c3", code: "CT-003", name: "Độ ẩm", group: "chi-tieu", unit: "%", active: true },
  {
    id: "c4",
    code: "PP-101",
    name: "TCVN 3118:1993",
    group: "phuong-phap",
    unit: "-",
    active: true,
  },
  {
    id: "c5",
    code: "PP-102",
    name: "TCVN 3106:1993",
    group: "phuong-phap",
    unit: "-",
    active: true,
  },
  { id: "c6", code: "PP-103", name: "ASTM C39", group: "phuong-phap", unit: "-", active: false },
  { id: "c7", code: "DV-201", name: "Megapascal", group: "don-vi", unit: "MPa", active: true },
  { id: "c8", code: "DV-202", name: "Kilôgam", group: "don-vi", unit: "kg", active: true },
  { id: "c9", code: "LM-301", name: "Bê tông", group: "loai-mau", unit: "-", active: true },
  { id: "c10", code: "LM-302", name: "Cốt liệu lớn", group: "loai-mau", unit: "-", active: true },
  { id: "c11", code: "LM-303", name: "Đất nền", group: "loai-mau", unit: "-", active: true },
];

export const MOCK_PARAMS: SystemParam[] = [
  {
    id: "p1",
    key: "report.prefix",
    label: "Tiền tố số phiếu kết quả",
    value: "NEW",
    group: "Đánh số hồ sơ",
    hint: "Ghép theo mẫu <tiền tố>-<năm>-<số thứ tự>.",
  },
  {
    id: "p2",
    key: "report.seq.reset",
    label: "Chu kỳ reset số thứ tự",
    value: "Theo năm",
    group: "Đánh số hồ sơ",
    hint: "Theo năm / theo tháng / không reset.",
  },
  {
    id: "p3",
    key: "sample.retention.days",
    label: "Hạn lưu mẫu (ngày)",
    value: "90",
    group: "Mẫu thử",
    hint: "Số ngày lưu mẫu kể từ ngày trả kết quả.",
  },
  {
    id: "p4",
    key: "portal.public.enabled",
    label: "Cho phép tra cứu công khai",
    value: "Bật",
    group: "Cổng tra cứu",
    hint: "Tắt sẽ ẩn cổng tra cứu với khách hàng.",
  },
  {
    id: "p5",
    key: "portal.captcha",
    label: "Bảo vệ chống bot",
    value: "Turnstile",
    group: "Cổng tra cứu",
    hint: "Áp dụng cho form tra cứu số phiếu.",
  },
  {
    id: "p6",
    key: "session.timeout.min",
    label: "Thời gian hết phiên (phút)",
    value: "60",
    group: "Bảo mật",
    hint: "Tự đăng xuất khi không thao tác.",
  },
];
