import {
  InteractionTag,
  InteractionTagPrimary,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
} from "@fluentui/react-components";
import { Checkmark12Filled } from "@fluentui/react-icons";

export interface RoleOption {
  id: string;
  name: string;
  /** Vai trò này có mang `user.manage` không (`GET /roles` → `RoleSummary.administers`). Bộ chọn
   *  không dùng tới, nhưng màn gọi nó dùng để biết chuyển sang vai trò này có lấy mất quyền quản
   *  trị của người cuối cùng còn giữ hay không. */
  administers?: boolean;
}
export interface BranchOption {
  id: string;
  name: string;
}

const groupTitle: React.CSSProperties = {
  font: "600 12px/16px var(--font-family-base)",
  color: "var(--foreground-secondary)",
  marginBottom: 8,
};
const hint: React.CSSProperties = {
  font: "12px/16px var(--font-family-base)",
  color: "var(--foreground-secondary)",
};

/**
 * Một vai trò × nhiều chi nhánh — đúng hình dạng mà backend nhận.
 *
 * `PUT /users/{id}/role-assignments` và `POST /users/invitations` đều lấy **một** `roleId` kèm
 * danh sách `branchIds` (`UserDirectoryResource.RoleAssignmentRequest`,
 * `ReplaceRoleAssignmentsService#replace`), và lần ghi sau thay toàn bộ lần ghi trước. Vì vậy vai
 * trò ở đây là radio chứ không phải checkbox: cho tick nhiều ô rồi chỉ gửi đi một ô là nói dối
 * người dùng về việc vừa xảy ra.
 *
 * Dùng chung giữa màn mời người dùng (A-01b) và ngăn chi tiết người dùng (A-01c) — hai chỗ ghi vào
 * cùng một cấu trúc phân quyền nên phải hỏi cùng một câu hỏi.
 */
export function RoleBranchPicker({
  roles,
  branches,
  roleId,
  branchIds,
  disabled,
  onChange,
}: {
  roles: RoleOption[];
  branches: BranchOption[];
  roleId: string;
  branchIds: string[];
  disabled?: boolean;
  onChange: (next: { roleId: string; branchIds: string[] }) => void;
}) {
  if (!roles.length) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          Chưa tải được danh mục vai trò từ máy chủ, chưa gán quyền được.
        </MessageBarBody>
      </MessageBar>
    );
  }

  const toggleBranch = (id: string) =>
    onChange({
      roleId,
      branchIds: branchIds.includes(id)
        ? branchIds.filter((item) => item !== id)
        : [...branchIds, id],
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={groupTitle}>Vai trò</div>
        <RadioGroup
          value={roleId}
          disabled={disabled}
          onChange={(_, data) => onChange({ roleId: data.value, branchIds })}
        >
          {roles.map((role) => (
            <Radio key={role.id} value={role.id} label={role.name} />
          ))}
        </RadioGroup>
      </div>

      <div>
        {/* Đếm ngay trên nhãn: chip đã có nền đặc khi được chọn, nhưng con số là thứ khớp thẳng
            với cảnh báo "cần ít nhất một chi nhánh" ở cuối form, nên không còn khoảng cách nào
            giữa cái người dùng nhìn thấy và cái form thực sự đang giữ. */}
        <div style={groupTitle}>
          Chi nhánh - chọn ít nhất một
          {branchIds.length ? ` (đã chọn ${branchIds.length})` : " (chưa chọn chi nhánh nào)"}
        </div>
        {branches.length ? (
          <div className="dlp-chiprow" role="group" aria-label="Chi nhánh">
            {branches.map((branch) => {
              const picked = branchIds.includes(branch.id);
              return (
                <InteractionTag
                  key={branch.id}
                  size="small"
                  appearance="outline"
                  className={picked ? "dlp-chip--picked" : "dlp-chip--unpicked"}
                >
                  <InteractionTagPrimary
                    disabled={disabled || !roleId}
                    aria-pressed={picked}
                    icon={picked ? <Checkmark12Filled /> : undefined}
                    onClick={() => toggleBranch(branch.id)}
                  >
                    {branch.name}
                  </InteractionTagPrimary>
                </InteractionTag>
              );
            })}
          </div>
        ) : (
          <span style={hint}>
            Chưa có chi nhánh nào để chọn. Danh sách chi nhánh gộp từ chi nhánh của những người dùng
            đã tải về và chi nhánh của chính bạn - chưa có endpoint danh mục chi nhánh riêng.
          </span>
        )}
      </div>

      <span style={hint}>
        Lưu lần này thay toàn bộ phân quyền hiện có của người dùng, không cộng thêm. Quyền mới có
        hiệu lực trong khoảng 60 giây, không cần đăng nhập lại.
      </span>
    </div>
  );
}
