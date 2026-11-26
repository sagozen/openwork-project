/* Điều kiện vào từng màn nghiệp vụ - nguồn duy nhất cho cả menu chính (AppShell) và trang
   mặc định sau đăng nhập. Để hai nơi tự viết điều kiện riêng thì menu và trang mặc định sẽ
   lệch nhau, và người dùng bị ném vào một màn chỉ hiện NoAccess. */

import { PERM, type Permission } from "@/lib/admin/rbac";

export type CanFn = (perm: Permission) => boolean;

export type NavKey =
  | "request"
  | "sampleManagement"
  | "requestEdit"
  | "reception"
  | "handover"
  | "lab"
  | "labResultEntry"
  | "technicalReview"
  | "approval"
  | "report"
  | "supplementaryDocuments"
  | "sampling"
  | "customer";

/** Mỗi mục lấy ĐÚNG permission mà màn hình đó kiểm tra (D19/FR-IAM-023). */
const NAV_ACCESS: Record<NavKey, (can: CanFn, usesClerk?: boolean) => boolean> = {
  request: (can) => can(PERM.REQUEST_READ),
  // Lãnh đạo ký hoặc một cửa tiếp nhận; quyền đọc chung của lab/hiện trường không đủ.
  sampleManagement: (can) => can(PERM.REVIEW_APPROVE) || can(PERM.RECEPTION_ACCEPT),
  // Connected S-20 performs a real patch and therefore requires the same two permissions as
  // its route guard. The demo remains readable with request.read because it never calls the API.
  requestEdit: (can, usesClerk = false) =>
    can(PERM.REQUEST_READ) && (!usesClerk || can(PERM.REQUEST_PATCH_GROUP_A)),
  reception: (can) => can(PERM.RECEPTION_READ),
  handover: (can) => can(PERM.RECEPTION_HANDOVER_DELIVER) || can(PERM.RECEPTION_HANDOVER_LAB),
  lab: (can) => can(PERM.LAB_READ),
  // S-13 mở được bằng `lab.read` để người theo dõi (vd. lãnh đạo ký) xem kết quả một task từ bảng
  // công việc, nhưng MỤC MENU thì chỉ dành cho người nhập được: không có `lab.task.work` thì mọi ô
  // trên màn đều khoá, mời vào bằng một mục menu tên "Nhập kết quả" là hứa một việc không làm được.
  labResultEntry: (can) => can(PERM.LAB_READ) && can(PERM.LAB_TASK_WORK),
  technicalReview: (can) => can(PERM.REVIEW_TECHNICAL),
  approval: (can) => can(PERM.REVIEW_APPROVE),
  report: (can) => can(PERM.REPORT_READ),
  // Adding and viewing are separate grants: one-door staff may attach evidence without reading
  // results, and an auditor may need to reopen what was attached without `report.read`.
  supplementaryDocuments: (can) =>
    can(PERM.REPORT_SUPPLEMENTARY_DOCUMENT_ADD) || can(PERM.REPORT_SUPPLEMENTARY_DOCUMENT_READ),
  // Màn S-05 đòi cả hai quyền (`routes/lay-mau.tsx`): chỉ có `sampling.read` thì vào ra NoAccess.
  sampling: (can) => can(PERM.SAMPLING_READ) && can(PERM.SAMPLING_WORK),
  customer: (can) => canViewCustomerLedger(can),
};

/**
 * K-01 (khách hàng & công nợ) mở bằng `debt.view` - mã quyền THẬT của backend kể từ khi sổ công
 * nợ có phía dưới (`debt.domain.DebtPermissions`).
 *
 * Trước đây chưa có mã nào cho màn này nên điều kiện phải dựng gián tiếp từ `review.approve` +
 * `request.customer.view`, tức là suy ra "ai được xem công nợ" từ "ai ký duyệt phiếu" - một phép
 * suy đúng tình cờ với bộ vai trò lúc đó, và sai ngay khi một cửa được giao việc thu tiền. Nay
 * hỏi thẳng.
 *
 * Vẫn đòi kèm `request.customer.view`: BR-012 vẽ ranh giới danh tính khách hàng ở mã đó, và một
 * màn gọi tên khách hàng ra không được mở bằng bất cứ đường nào đi vòng qua nó.
 */
export function canViewCustomerLedger(can: CanFn): boolean {
  return can(PERM.DEBT_VIEW) && can(PERM.REQUEST_CUSTOMER_VIEW);
}

/** Sửa hồ sơ khách hàng, khoá và mở khoá. Xem được sổ không có nghĩa là sửa được hạn mức. */
export function canManageCustomer(can: CanFn): boolean {
  return can(PERM.CUSTOMER_MANAGE);
}

/** Phát hành hoá đơn và ghi phiếu thu. */
export function canManageDebt(can: CanFn): boolean {
  return can(PERM.DEBT_MANAGE);
}

export function resolveNavAccess(can: CanFn, usesClerk = false): Record<NavKey, boolean> {
  return {
    request: NAV_ACCESS.request(can),
    sampleManagement: NAV_ACCESS.sampleManagement(can),
    requestEdit: NAV_ACCESS.requestEdit(can, usesClerk),
    reception: NAV_ACCESS.reception(can),
    handover: NAV_ACCESS.handover(can),
    lab: NAV_ACCESS.lab(can),
    labResultEntry: NAV_ACCESS.labResultEntry(can),
    technicalReview: NAV_ACCESS.technicalReview(can),
    approval: NAV_ACCESS.approval(can),
    report: NAV_ACCESS.report(can),
    supplementaryDocuments: NAV_ACCESS.supplementaryDocuments(can),
    sampling: NAV_ACCESS.sampling(can),
    customer: NAV_ACCESS.customer(can),
  };
}

/* Thứ tự đúng bằng thứ tự mục trong menu chính. Các màn không phải đích đăng nhập mặc định
   (/nhap-ket-qua theo `lab`, /sua-ho-so theo `requestEdit`) không cần liệt kê: mục đứng trước
   trong cùng luồng luôn được chọn trước. */
const NAV_ENTRIES = [
  { to: "/ho-so", key: "request", label: "Hồ sơ kiểm nghiệm" },
  { to: "/quan-ly-mau", key: "sampleManagement", label: "Quản lý mẫu" },
  { to: "/tiep-nhan", key: "reception", label: "Tiếp nhận mẫu" },
  { to: "/ban-giao", key: "handover", label: "Bàn giao vào lab" },
  { to: "/cong-viec", key: "lab", label: "Bảng công việc lab" },
  { to: "/kiem-tra-ky-thuat", key: "technicalReview", label: "Kiểm tra kỹ thuật" },
  { to: "/phe-duyet", key: "approval", label: "Phê duyệt phiếu" },
  { to: "/tra-ket-qua", key: "report", label: "Trả kết quả" },
  { to: "/tai-lieu-bo-sung", key: "supplementaryDocuments", label: "Tài liệu bổ sung" },
  { to: "/lay-mau", key: "sampling", label: "Lấy mẫu hiện trường" },
  { to: "/khach-hang", key: "customer", label: "Khách hàng & công nợ" },
] as const satisfies readonly { to: string; key: NavKey; label: string }[];

export type LandingRoute = (typeof NAV_ENTRIES)[number]["to"] | "/admin" | "/ho-tro";

export interface NavLink {
  to: LandingRoute;
  label: string;
}

/**
 * Các màn tài khoản được phép mở, đúng thứ tự menu chính. Dùng cho màn chạy ngoài AppShell
 * (S-05 lấy mẫu hiện trường) - ở đó không có rail điều hướng nên menu người dùng phải tự
 * dựng danh sách này.
 */
export function resolveAllowedNavLinks(can: CanFn): NavLink[] {
  const links: NavLink[] = NAV_ENTRIES.filter((entry) => NAV_ACCESS[entry.key](can)).map(
    ({ to, label }) => ({ to, label }),
  );
  if (can("admin.view")) links.push({ to: "/admin", label: "Cài đặt hệ thống" });
  // Hỗ trợ người dùng không đòi quyền nào - mọi tài khoản đã đăng nhập đều mở được.
  links.push({ to: "/ho-tro", label: "Hỗ trợ người dùng" });
  return links;
}

/**
 * Trang mặc định sau đăng nhập: màn ĐẦU TIÊN trong menu mà tài khoản được phép vào.
 * Không còn màn nghiệp vụ nào thì lùi về /admin (nếu là quản trị), cuối cùng là /ho-tro -
 * màn duy nhất mọi tài khoản đã đăng nhập đều vào được.
 */
export function resolveLandingRoute(can: CanFn): LandingRoute {
  const first = NAV_ENTRIES.find((entry) => NAV_ACCESS[entry.key](can));
  if (first) return first.to;
  if (can("admin.view")) return "/admin";
  return "/ho-tro";
}
