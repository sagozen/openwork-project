import type { AppCode } from '../../platform/types';
import type { AdminUser } from './admin-api';
import { LockUserDialog } from './LockUserDialog';
import { ResetPasswordDialog } from './ResetPasswordDialog';
import { UserDialog } from './UserDialog';
import { adminApi } from './admin-api';
import { writeOnline } from './admin-error';

export type UserDialogState = { kind: 'add' } | { kind: 'edit'; user: AdminUser } | { kind: 'lock'; user: AdminUser } | { kind: 'reset'; user: AdminUser } | null;

/** Mở khoá lại tài khoản (không cần hộp xác nhận: không mất dữ liệu, mở được bất cứ lúc nào). */
export const unlockUser = (u: AdminUser) => writeOnline(() => adminApi.updateUser(u.id, { active: true }));

/** Các hộp thoại Thêm / Sửa / Khoá / Đặt lại mật khẩu dùng chung cho danh sách và trang chi tiết người dùng. */
export function UserActionDialogs({
  dialog,
  setDialog,
  users,
  licenseApps,
  onDone,
  onUnlock,
  unlocking,
}: {
  dialog: UserDialogState;
  setDialog: (d: UserDialogState) => void;
  users: AdminUser[];
  licenseApps: AppCode[];
  /** Một thao tác đã lưu xong: câu thông báo + tài khoản cần làm nổi (đặt lại mật khẩu). */
  onDone: (text: string, flashId?: string) => void;
  onUnlock: (u: AdminUser) => void;
  /** Đang mở khoá (từ dòng trạng thái của hộp Sửa): nút mở khoá trong hộp khoá lại. */
  unlocking?: boolean;
}) {
  if (!dialog) return null;
  const close = () => setDialog(null);
  switch (dialog.kind) {
    case 'add':
      return (
        <UserDialog
          mode="add"
          users={users}
          licenseApps={licenseApps}
          onClose={close}
          onCreated={(c, f) => onDone(`Đã thêm ${f.displayName.trim() || c.username}. Mật khẩu tạm hết hạn sau 72 giờ nếu chưa dùng.`)}
          onUpdated={() => undefined}
          onToggleLock={() => undefined}
        />
      );
    case 'edit':
      return (
        <UserDialog
          key={dialog.user.id}
          mode="edit"
          user={dialog.user}
          users={users}
          licenseApps={licenseApps}
          onClose={close}
          onCreated={() => undefined}
          onUpdated={(u) => onDone(`Đã lưu thay đổi cho ${u.display_name}. Có hiệu lực từ lúc lưu.`)}
          onToggleLock={(u) => (u.status === 'locked' ? onUnlock(u) : setDialog({ kind: 'lock', user: u }))}
          toggleLockBusy={unlocking}
        />
      );
    case 'lock':
      return <LockUserDialog user={dialog.user} onClose={close} onLocked={(u) => onDone(`Đã khoá tài khoản ${u.display_name}.`)} />;
    case 'reset':
      return (
        <ResetPasswordDialog
          user={dialog.user}
          onClose={close}
          onDone={(u) => onDone(`Đã đặt lại mật khẩu cho ${u.display_name}. ${u.display_name} phải đổi mật khẩu ở lần đăng nhập tới. Mật khẩu tạm không hiện lại ở đâu nữa.`, u.id)}
        />
      );
  }
}
