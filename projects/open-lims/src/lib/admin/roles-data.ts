/* A-01d - Bảy vai trò chuẩn và ma trận quyền theo miền nghiệp vụ.
   Ma trận này dựng từ MÃ QUYỀN THẬT (PERM) và từ ROLE_PERMISSIONS, không còn bộ mã giả riêng
   ("req.create", "lab.result"...) như bản mockup đầu tiên: bộ mã đó đã lệch khỏi quyền thật của
   persona (ma trận nói quản lý một cửa không tiếp nhận mẫu và trưởng nhóm kỹ thuật không nhập
   kết quả, trong khi cả hai đều giữ mã tương ứng). Ở chế độ Clerk màn hình đọc thẳng danh mục
   quyền của backend, nên bản demo phải nói cùng thứ tiếng đó. */

import {
  ALL_PERMISSIONS,
  PERM,
  ROLE_IDS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  type Permission,
  type RoleId,
} from "@/lib/admin/rbac";
import { MOCK_ROLES } from "@/lib/admin/mock-data";

export interface RoleDef {
  /** `string` chứ không phải RoleId: ở chế độ Clerk danh sách vai trò đến từ backend. */
  id: string;
  name: string;
  /** Số người dùng gán vai trò - chỉ có ở dữ liệu mẫu (demo). GET /roles thật không trả trường này. */
  users?: number;
}

export interface PermItem {
  key: string;
  label: string;
  note: string;
  def: string[];
  /** Quyền dữ liệu khách hàng - khoá với vai trò lab/trưởng nhóm (BR-012, D07). */
  pii?: boolean;
  /** Quyền chuyên môn - khoá với quản trị hệ thống (FR-IAM-018). */
  pro?: boolean;
}

export interface PermGroup {
  name: string;
  items: PermItem[];
}

export const STANDARD_ROLES: RoleDef[] = MOCK_ROLES.map((role) => ({
  id: role.id,
  name: role.name,
  users: role.users,
}));

/** Ghi chú nghiệp vụ giữ lại từ mockup, gắn vào đúng mã quyền thật tương ứng. Mã không có ghi
 *  chú riêng thì hiện chính chuỗi quyền - giống hệt cách chế độ Clerk hiển thị danh mục backend. */
const PERM_NOTES: Partial<Record<Permission, string>> = {
  [PERM.REQUEST_CREATE]: "Số hoá BM01, sinh mã lượt lấy mẫu",
  [PERM.REQUEST_CANCEL]: "Quyền riêng, ghi audit",
  [PERM.PAYMENT_CONFIRM]: "Bắt buộc có chứng từ",
  [PERM.PAYMENT_EXCEPTION]: "Quyền riêng, ghi audit",
  [PERM.SAMPLING_ASSIGN]: "Theo phạm vi chi nhánh",
  [PERM.SAMPLING_WORK]: "Ghi BM02/BM03, chỉ lượt được giao",
  [PERM.RECEPTION_ACCEPT]: "Tiếp nhận / tạm giữ / từ chối, kèm đối chiếu tem BM03",
  [PERM.LAB_TASK_WORK]: "Nhập kết quả, chỉ sửa qua quy trình trả lại",
  [PERM.REVIEW_TECHNICAL]: "Chấp nhận / trả lại - hai hành động tách riêng",
  [PERM.REVIEW_APPROVE]: "Timestamp riêng với kiểm tra kỹ thuật",
  [PERM.REPORT_RELEASE]: "Khoá nội dung và cấp mã tra cứu",
  [PERM.REPORT_REPLACE]: "Thu hồi và thay thế phiếu đã phát hành",
  [PERM.REQUEST_CUSTOMER_VIEW]: "Ghi audit mọi lượt truy cập",
  [PERM.USER_MANAGE]: "Mời, phân quyền, vô hiệu hoá, tạo phiên bản danh mục",
};

/** Quyền dữ liệu khách hàng (BR-012/D07). Sổ khách hàng và công nợ gọi tên khách hàng ra và
 *  kèm số tiền, nên đứng cùng ranh giới với hai mã «xem thông tin khách hàng». */
const PII_PERMS: Permission[] = [
  PERM.REQUEST_CUSTOMER_VIEW,
  PERM.REVIEW_CUSTOMER_VIEW,
  PERM.CUSTOMER_MANAGE,
  PERM.DEBT_VIEW,
  PERM.DEBT_MANAGE,
];

/** Quyền quản trị thuần - phần còn lại là quyền chuyên môn và bị khoá với quản trị hệ thống
 *  (FR-IAM-018: admin không chạm dữ liệu nghiệp vụ). */
const ADMIN_PERMS: Permission[] = [
  PERM.USER_READ,
  PERM.USER_MANAGE,
  PERM.AUDIT_READ,
  PERM.CONFIG_MANAGE,
];

const GROUP_LAYOUT: { name: string; keys: Permission[] }[] = [
  {
    name: "Hồ sơ & thanh toán",
    keys: [
      PERM.REQUEST_READ,
      PERM.REQUEST_CREATE,
      PERM.REQUEST_PATCH_GROUP_A,
      PERM.REQUEST_CANCEL,
      PERM.PAYMENT_CONFIRM,
      PERM.PAYMENT_EXCEPTION,
    ],
  },
  {
    name: "Hiện trường & tiếp nhận mẫu",
    keys: [
      PERM.SAMPLING_READ,
      PERM.SAMPLING_ASSIGN,
      PERM.SAMPLING_WORK,
      PERM.SAMPLING_CHANGE_APPROVE,
      PERM.RECEPTION_READ,
      PERM.RECEPTION_ACCEPT,
      PERM.RECEPTION_SPLIT,
      PERM.RECEPTION_LABEL_PRINT_PARENT,
      PERM.RECEPTION_LABEL_PRINT_LAB,
      PERM.RECEPTION_HANDOVER_DELIVER,
      PERM.RECEPTION_HANDOVER_LAB,
    ],
  },
  {
    name: "Phòng thử nghiệm",
    keys: [
      PERM.LAB_READ,
      PERM.LAB_TASK_CLAIM,
      PERM.LAB_TASK_ASSIGN,
      PERM.LAB_TASK_WORK,
      PERM.LAB_RESULT_VALUE_VIEW,
      PERM.REVIEW_TECHNICAL,
      PERM.REVIEW_VERSION_HISTORY,
    ],
  },
  {
    name: "Phê duyệt & phát hành",
    keys: [
      PERM.REVIEW_APPROVE,
      PERM.REPORT_READ,
      PERM.REPORT_PREVIEW,
      PERM.REPORT_BUILD,
      PERM.REPORT_SIGN,
      PERM.REPORT_RELEASE,
      PERM.REPORT_REPLACE,
      PERM.REPORT_DELIVER,
      PERM.REPORT_SUPPLEMENTARY_DOCUMENT_ADD,
      PERM.REPORT_SUPPLEMENTARY_DOCUMENT_READ,
      PERM.DOCUMENT_DOWNLOAD,
    ],
  },
  {
    name: "Dữ liệu khách hàng & quản trị",
    keys: [
      PERM.REQUEST_CUSTOMER_VIEW,
      PERM.REVIEW_CUSTOMER_VIEW,
      PERM.CUSTOMER_MANAGE,
      PERM.DEBT_VIEW,
      PERM.DEBT_MANAGE,
      PERM.USER_READ,
      PERM.USER_MANAGE,
      PERM.AUDIT_READ,
      PERM.CONFIG_MANAGE,
    ],
  },
];

const LABEL_OF = new Map(ALL_PERMISSIONS.map((p) => [p.key, p.label]));

/** Vai trò ĐANG giữ mã quyền này - suy từ ROLE_PERMISSIONS chứ không chép tay. */
function rolesHolding(key: Permission): RoleId[] {
  return ROLE_IDS.filter((id) => ROLE_PERMISSIONS[id].includes(key));
}

export const PERM_GROUPS: PermGroup[] = GROUP_LAYOUT.map((group) => ({
  name: group.name,
  items: group.keys.map((key) => ({
    key,
    label: LABEL_OF.get(key) ?? key,
    note: PERM_NOTES[key] ?? key,
    def: rolesHolding(key),
    ...(PII_PERMS.includes(key) ? { pii: true } : {}),
    ...(ADMIN_PERMS.includes(key) ? {} : { pro: true }),
  })),
}));

export function isPermLocked(p: PermItem, roleId: string): boolean {
  return (!!p.pii && ["lab", "truongnhom"].includes(roleId)) || (!!p.pro && roleId === "admin");
}

export function lockedNote(p: PermItem): string {
  return p.pii
    ? "Vai trò phòng thử nghiệm không được xem thông tin khách hàng"
    : "Quản trị hệ thống không được sửa dữ liệu chuyên môn";
}

/** Nhãn vai trò dùng lại ở chú thích ma trận. */
export { ROLE_LABELS };
