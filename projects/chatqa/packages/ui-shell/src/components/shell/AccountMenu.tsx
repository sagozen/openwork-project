import { KeyRound, LogOut } from 'lucide-react';
import { Avatar, Menu, MenuItem, roleOf, type AvatarTone } from '../ui';

const TONES: Record<string, AvatarTone> = { admin: 'admin', manager: 'manager', leader: 'leader', staff: 'staff', vipo: 'vipo' };

/** Chữ viết tắt: chữ cái đầu của hai từ cuối ("Hoàng Anh Tùng" -> "AT", "Phạm Minh" -> "PM"). */
export function initialsOf(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (w.length === 0) return '?';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[w.length - 2][0] + w[w.length - 1][0]).toUpperCase();
}
export const toneOf = (role: string): AvatarTone => TONES[roleOf(role)?.code ?? ''] ?? 'staff';

/** Nhãn vai trong menu: nhỏ hơn RoleChip của bảng (đệm 1 6, bo 4), cùng màu theo contracts/roles.json. */
function RoleBadge({ role }: { role: string }) {
  const r = roleOf(role);
  if (!r) return null;
  return (
    <span className="self-start rounded-[4px] px-[6px] py-px text-[10px]/[13px] font-semibold" style={{ color: r.chip.fg, backgroundColor: r.chip.bg }}>
      {r.label}
    </span>
  );
}

/** Menu tài khoản (pen: h4Lox0 "Menu tài khoản"): tên + vai, Đổi mật khẩu, Đăng xuất (FR-004 trên mọi màn chính). */
export function AccountMenu({ name, role, onChangePassword, onLogout, highlight, className }: { name: string; role: string; onChangePassword: () => void; onLogout: () => void; /** Tô nền mục Đổi mật khẩu như khung pen (trạng thái rê chuột). */ highlight?: boolean; className?: string }) {
  return (
    <Menu variant="account" className={className}>
      <div className="flex items-center gap-[10px] px-[10px] pt-[10px] pb-[12px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <Avatar initials={initialsOf(name)} tone={toneOf(role)} size={34} />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="truncate text-[13px]/[16px] font-bold text-text">{name}</span>
          <RoleBadge role={role} />
        </div>
      </div>
      <MenuItem variant="account" active={highlight} icon={<KeyRound size={15} />} onClick={onChangePassword}>
        Đổi mật khẩu
      </MenuItem>
      <MenuItem variant="account" tone="danger" icon={<LogOut size={15} />} onClick={onLogout}>
        Đăng xuất
      </MenuItem>
    </Menu>
  );
}
