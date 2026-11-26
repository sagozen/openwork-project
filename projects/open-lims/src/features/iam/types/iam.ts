export type IamUserStatus = "ACTIVE" | "PENDING_ACTIVATION" | "DEACTIVATED";

export interface IamRole {
  code: string;
  name: string;
}

export interface IamBranch {
  id: string;
  code: string;
  name: string;
  isTest: boolean;
}

export interface IamUser {
  userId: string;
  email: string;
  fullName: string;
  /**
   * Chức danh in dưới chữ ký khi người này phê duyệt một phiếu kết quả (FR-IAM-024).
   *
   * Tuỳ chọn vì chỉ danh bạ (`GET /users`) trả trường này; `GET /me` dùng chung kiểu này mà không
   * trả - hồ sơ của chính mình đọc chức danh qua `GET /me/signature` (`IamSignatureProfile`).
   * Vắng khi chưa ai đặt chức danh, và phiếu khi đó chỉ in họ tên.
   */
  jobTitle?: string;
  status: IamUserStatus;
  displayTimezone?: string;
  roles: IamRole[];
  branches: IamBranch[];
  /** Mã quyền cấp riêng đang có hiệu lực; danh bạ và phản hồi cập nhật phân quyền trả về. */
  extraPermissionIds?: string[];
  lastLoginAt?: string;
  /**
   * Người này có phải chỗ dựa quản trị của đơn vị hay không — đúng phép tính mà backend dùng để
   * từ chối `E-IAM-013` (`AdministrationPredicates.ADMINISTERS`: đang hoạt động, còn chi nhánh, và
   * giữ `user.manage` qua vai trò hoặc qua grant riêng).
   *
   * FE đọc cờ này để chặn trước thao tác hạ quyền/vô hiệu hoá admin cuối cùng, thay vì tự đếm theo
   * vai trò — cách tự đếm bỏ sót người được cấp `user.manage` bằng grant riêng và sẽ chặn nhầm.
   * Quyết định thật vẫn nằm ở lần ghi trên server.
   *
   * Tuỳ chọn vì `GET /me` dùng chung kiểu này mà không trả trường này: hồ sơ của chính mình không
   * trả lời câu hỏi "đơn vị còn ai quản trị", và chỉ danh bạ (`GET /users`) mới trả.
   */
  administers?: boolean;
  invitation?: { id: string; expiresAt: string; status: string };
}

export interface IamUserPage {
  users: IamUser[];
  pageSize: number;
}

/**
 * Chữ ký và chức danh của chính người đang đăng nhập (`GET|PATCH /api/v1/me/signature`).
 *
 * Không nằm trong `IamUser`: `GET /me` không trả hai giá trị này (`MeResponse` dựng từ danh tính
 * đã cache, cố tình không mang chúng), còn ảnh thì luôn là một lượt tải riêng.
 */
export interface IamSignatureProfile {
  /** Chức danh in dưới chữ ký trên phiếu kết quả. Vắng khi chưa ai đặt. */
  jobTitle?: string;
  signatureDocumentId?: string;
  hasSignature: boolean;
}

/**
 * Lượt ghi luôn ghi đè chức danh: gửi chuỗi rỗng là xoá chức danh, đúng như người dùng vừa xoá ô
 * nhập. Ngược lại, `signatureDocumentId` bỏ trống nghĩa là **giữ nguyên ảnh đang lưu** - chỉ gửi
 * khi vừa tải ảnh mới lên.
 */
export interface IamSignatureInput {
  jobTitle: string;
  signatureDocumentId?: string;
}

export interface IamCapabilities {
  permissions: string[];
  navigation: Array<{ key: string; label: string; enabled: boolean; reason?: string | null }>;
  resolvedAt: string;
}

export interface IamRoleCatalogueEntry {
  code: string;
  name: string;
  /**
   * Vai trò này có mang `user.manage` không (chỉ có ở danh mục vai trò, không có ở danh mục
   * quyền). Dùng để biết trước: chuyển người cuối cùng còn quyền quản trị sang vai trò này có làm
   * đơn vị mất người quản trị hay không.
   */
  administers?: boolean;
}

export interface IamRoleCatalogue {
  roles: IamRoleCatalogueEntry[];
  permissions: IamRoleCatalogueEntry[];
}

/**
 * Tập quyền một vai trò đang giữ, kèm tập quyền vai trò đó không bao giờ được giữ.
 *
 * `GET|PUT /roles/{code}/permissions` (RoleResource.java) trả cùng một tài liệu này.
 * `lockedPermissionIds` do backend tính từ FR-IAM-018 (vai trò quản trị × quyền chuyên môn) và
 * BR-012/D07 (vai trò phòng thử nghiệm × quyền xem thông tin khách hàng) — FE khoá đúng danh sách
 * này chứ không tự suy lại quy định, vì tự suy lại chính là cách quy định được in ra màn hình mà
 * không có gì thi hành.
 */
export interface IamRolePermissions {
  code: string;
  name: string;
  permissionIds: string[];
  lockedPermissionIds: string[];
}

export interface IamAssignedWork {
  samplingAssignments: number;
  analysisTasks: number;
  pendingApprovals: number;
  total: number;
}

export interface IamInvitationInput {
  email: string;
  fullName: string;
  roleId: string;
  branchIds: string[];
  extraPermissionIds?: string[];
}

export interface IamInvitationResult {
  userId: string;
  status: IamUserStatus;
  invitation: { id: string; expiresAt: string; status: string };
}

export { ApiError as IamApiError, apiErrorMessage as iamErrorMessage } from "@/lib/api";
export type { ProblemDetails as IamApiErrorBody } from "@/lib/api";
