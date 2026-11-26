import type {
  IamAssignedWork,
  IamCapabilities,
  IamInvitationInput,
  IamInvitationResult,
  IamRoleCatalogue,
  IamRolePermissions,
  IamSignatureInput,
  IamSignatureProfile,
  IamUser,
  IamUserPage,
} from "../types/iam";
import { ApiError, createApiClient, uploadFile, type TokenProvider } from "@/lib/api";

function validBranchIds(branchIds: string[]): string[] {
  if (branchIds.length === 0 || branchIds.some((id) => !id || !id.trim())) {
    throw new ApiError(422, { code: "E-IAM-006", message: "Chi nhánh không hợp lệ." });
  }
  return branchIds;
}

export function createIamApi(tokenProvider: TokenProvider) {
  const api = createApiClient(tokenProvider);
  return {
    me: () => api.get<IamUser>("/me"),
    capabilities: () => api.get<IamCapabilities>("/me/capabilities"),
    updatePreferences: (timezone: string) => api.patch<IamUser>("/me/preferences", { timezone }),
    // GET|PATCH /me/signature - không có id trên đường dẫn và không có id trong thân, nên không
    // cách nào nhắm vào người khác. Ảnh là một lượt riêng vì trả về byte, không phải JSON.
    signature: () => api.get<IamSignatureProfile>("/me/signature"),
    updateSignature: (input: IamSignatureInput) =>
      api.patch<IamSignatureProfile>("/me/signature", input),
    signatureImage: () => api.getBlob("/me/signature/image"),
    // Ảnh chữ ký đi qua đúng đường tải tệp dùng chung; `PATCH /me/signature` chỉ nhận documentId.
    // Máy chủ chỉ nhận ảnh do chính người gọi tải lên, nên hai bước này phải cùng một tài khoản.
    uploadSignatureImage: (file: File) =>
      uploadFile(api, file, { grant: "iam.signature", fileName: file.name }),
    users: (pageSize = 100) => api.get<IamUserPage>(`/users?pageSize=${Math.min(pageSize, 500)}`),
    invite: (input: IamInvitationInput) =>
      api.post<IamInvitationResult>("/users/invitations", {
        ...input,
        branchIds: validBranchIds(input.branchIds),
      }),
    resendInvitation: (id: string) =>
      api.post<unknown>(`/users/invitations/${encodeURIComponent(id)}/resend`),
    // GET /users/{id}/signature/image - cùng `user.read` với cả lớp danh bạ. Chỉ có đường đọc:
    // chữ ký do người khác tải lên là bằng chứng của không ai, nên không có route ghi tương ứng.
    // 404 khi người đó chưa đặt chữ ký, và đó là trạng thái bình thường chứ không phải lỗi.
    userSignatureImage: (id: string) =>
      api.getBlob(`/users/${encodeURIComponent(id)}/signature/image`),
    assignedWork: (id: string) =>
      api.get<IamAssignedWork>(`/users/${encodeURIComponent(id)}/assigned-work`),
    deactivate: (id: string, reason: string) =>
      api.post<IamUser>(`/users/${encodeURIComponent(id)}/deactivate`, { reason }),
    // POST /users/{id}/reactivate - đưa hồ sơ đã vô hiệu hoá trở lại. Server tự chọn trạng thái
    // đích (ACTIVE, hoặc PENDING_ACTIVATION nếu người đó chưa từng kích hoạt), không nhận vai trò:
    // vô hiệu hoá không đóng phân quyền nên mở lại là trả đúng phân quyền cũ.
    reactivate: (id: string, reason: string) =>
      api.post<IamUser>(`/users/${encodeURIComponent(id)}/reactivate`, { reason }),
    roles: () => api.get<IamRoleCatalogue>("/roles"),
    rolePermissions: (id: string) =>
      api.get<IamRolePermissions>(`/roles/${encodeURIComponent(id)}/permissions`),
    updateRoleAssignments: (
      id: string,
      input: Pick<IamInvitationInput, "roleId" | "branchIds" | "extraPermissionIds">,
    ) =>
      api.put<IamUser>(`/users/${encodeURIComponent(id)}/role-assignments`, {
        ...input,
        branchIds: validBranchIds(input.branchIds),
      }),
    updateRolePermissions: (id: string, permissionIds: string[]) =>
      api.put<IamRolePermissions>(`/roles/${encodeURIComponent(id)}/permissions`, {
        permissionIds,
      }),
  };
}

export type IamApi = ReturnType<typeof createIamApi>;
