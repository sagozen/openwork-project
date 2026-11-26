import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from "@fluentui/react-components";
import { useMemo, useState } from "react";
import { ADMIN_ROLE_OPTIONS, type AdminUser } from "@/lib/admin/mock-data";
import type { IamInvitationInput } from "@/features/iam/types/iam";
import {
  RoleBranchPicker,
  type BranchOption,
  type RoleOption,
} from "@/components/lims/admin/RoleBranchPicker";
import { FieldLabel } from "@/components/lims/common";

export type InviteRoleOption = RoleOption;
export type InviteBranchOption = BranchOption;

const FALLBACK_ROLES: InviteRoleOption[] = ADMIN_ROLE_OPTIONS.map((r) => ({
  id: r.value,
  name: r.label,
}));
const FALLBACK_BRANCHES: InviteBranchOption[] = [
  { id: "1", name: "CN1" },
  { id: "9", name: "CN9" },
];

/* A-01b · Mời người dùng: email + họ tên + ma trận vai trò × chi nhánh. */
export function InviteUserDialog({
  open,
  users,
  roles,
  branches,
  onOpenChange,
  onInvite,
}: {
  open: boolean;
  users: AdminUser[];
  roles?: InviteRoleOption[];
  branches?: InviteBranchOption[];
  onOpenChange: (v: boolean) => void;
  onInvite: (input: IamInvitationInput) => void;
}) {
  // `undefined` = chế độ minh hoạ (không có máy chủ nào để hỏi) nên dùng dữ liệu dựng sẵn.
  // Mảng RỖNG là câu trả lời thật của máy chủ - giữ nguyên là rỗng. Trước đây cả hai trường hợp
  // cùng rơi vào dữ liệu dựng sẵn, nên một đơn vị chưa khai chi nhánh nào lại thấy "CN1, CN9"
  // và mời được người vào một chi nhánh không tồn tại.
  const roleOptions = roles ?? FALLBACK_ROLES;
  const branchOptions = branches ?? FALLBACK_BRANCHES;
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [branchIds, setBranchIds] = useState<string[]>([]);

  const dup = useMemo(
    () => !!email.trim() && users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase()),
    [email, users],
  );
  const ready = !!email.trim() && !!name.trim() && !!roleId && branchIds.length > 0;

  const reset = () => {
    setEmail("");
    setName("");
    setRoleId("");
    setBranchIds([]);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        onOpenChange(d.open);
        if (!d.open) reset();
      }}
    >
      <DialogSurface style={{ maxWidth: 560 }}>
        <DialogBody>
          <DialogTitle>Mời người dùng</DialogTitle>
          <DialogContent>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 220px" }}>
                  <Field
                    label={
                      <FieldLabel
                        label="Email"
                        tooltip="Lời mời gửi qua email, có thời hạn và thu hồi được"
                      />
                    }
                    required
                    validationState={dup ? "error" : "none"}
                    validationMessage={
                      dup
                        ? "Email này đã có tài khoản - mở hồ sơ người dùng thay vì mời lại"
                        : undefined
                    }
                  >
                    <Input
                      value={email}
                      onChange={(_, d) => setEmail(d.value)}
                      placeholder="ten@dalienphat.vn"
                    />
                  </Field>
                </div>
                <div style={{ flex: "1 1 200px" }}>
                  <Field label="Họ tên" required>
                    <Input value={name} onChange={(_, d) => setName(d.value)} />
                  </Field>
                </div>
              </div>

              <RoleBranchPicker
                roles={roleOptions}
                branches={branchOptions}
                roleId={roleId}
                branchIds={branchIds}
                onChange={(next) => {
                  setRoleId(next.roleId);
                  setBranchIds(next.branchIds);
                }}
              />

              <MessageBar intent={dup ? "error" : ready ? "info" : "warning"}>
                <MessageBarBody>
                  <MessageBarTitle>
                    {dup ? "Email đã tồn tại:" : ready ? "Sau khi gửi:" : "Còn thiếu:"}
                  </MessageBarTitle>{" "}
                  {dup
                    ? "Tài khoản với email này đã có trong hệ thống - mở hồ sơ đó để chỉnh vai trò, không tạo lời mời mới."
                    : ready
                      ? "Hệ thống tạo người dùng ở trạng thái «Đã mời – chờ kích hoạt» kèm sẵn vai trò, rồi gửi lời mời. Quản trị nhận thông báo khi lời mời được chấp nhận."
                      : "Cần email, họ tên, một vai trò và ít nhất một chi nhánh."}
                </MessageBarBody>
              </MessageBar>
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="primary"
              disabled={!ready || dup}
              onClick={() => {
                onInvite({ email: email.trim(), fullName: name.trim(), roleId, branchIds });
                onOpenChange(false);
                reset();
              }}
            >
              Gửi lời mời
            </Button>
            <Button
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
            >
              Huỷ
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
