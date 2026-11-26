import type { ReactNode } from 'react';
import { Lock, Wrench } from 'lucide-react';
import roles from '@contracts/roles.json';
import { cx } from './cx';

export type RoleCode = (typeof roles.roles)[number]['code'];

/** Vai tra từ contracts/roles.json (nhãn + màu chip). `owner` là tên cũ của admin. */
export function roleOf(code: string) {
  const legacy = (roles.legacy as Record<string, string>)[code] ?? code;
  return roles.roles.find((r) => r.code === legacy);
}

/** Chip vai: 10/600, padding 2 7, bo 5; màu theo contracts/roles.json. */
export function RoleChip({ role, className }: { role: string; className?: string }) {
  const r = roleOf(role);
  if (!r) return null;
  return (
    <span
      className={cx('inline-flex items-center rounded-[5px] px-[7px] py-[2px] text-[10px]/[13px] font-semibold whitespace-nowrap', className)}
      style={{ color: r.chip.fg, backgroundColor: r.chip.bg }}
    >
      {r.label}
    </span>
  );
}

/** Ô app 22×18: số mono 9/700. `granted` false = ô mờ (app chưa cấp). */
export function AppChip({ no, granted = true }: { no: string; granted?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex h-[18px] w-[22px] shrink-0 items-center justify-center rounded-[4px] font-mono text-[9px]/[12px] font-bold stroke-in',
        granted ? '[--stroke-c:var(--color-text-3)] bg-surface text-text' : 'bg-disabled-bg text-disabled-fg',
      )}
    >
      {no}
    </span>
  );
}

const DOT = { green: 'text-green', amber: 'text-amber', red: 'text-red', gray: 'text-text-3', blue: 'text-blue' } as const;

/** Chấm 7px + nhãn 10.5/600, cùng màu (Hoạt động, Khoá tạm, Đã khoá). */
export function StatusDot({ tone, children }: { tone: keyof typeof DOT; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-[5px] text-[10.5px]/[13px] font-semibold whitespace-nowrap', DOT[tone])}>
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}

const TAGS = {
  // Bên triển khai: nền đen, icon cờ lê cam nhạt (contracts/roles.json tags.deployer)
  deployer: { cls: 'bg-text text-white', icon: <Wrench size={9} className="text-avatar-admin-text" />, label: roles.tags.deployer },
  locked: { cls: 'bg-red-soft text-red', icon: <Lock size={9} />, label: roles.tags.locked },
} as const;

/** Thẻ nhỏ dưới tên người dùng: 9/600, cao 13, bo 4. */
export function Tag({ kind }: { kind: keyof typeof TAGS }) {
  const t = TAGS[kind];
  return (
    <span className={cx('inline-flex h-[13px] items-center gap-[3px] rounded-[4px] px-[5px] py-[1px] text-[9px]/[11px] font-semibold whitespace-nowrap', t.cls)}>
      {t.icon}
      {t.label}
    </span>
  );
}

/** Nhãn "Gửi yêu cầu" của vai Vipo (chỉ có màn gửi yêu cầu). */
export function OnlyRequestTag({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-[4px] bg-amber-soft px-[6px] py-[2px] text-[9px]/[11px] font-semibold text-amber">{children}</span>;
}

const AVATAR = {
  admin: 'bg-avatar-admin text-avatar-admin-text',
  manager: 'bg-avatar-manager text-avatar-manager-text',
  leader: 'bg-avatar-leader text-avatar-leader-text',
  staff: 'bg-avatar-staff text-avatar-staff-text',
  vipo: 'bg-avatar-vipo text-avatar-vipo-text',
  locked: 'bg-avatar-locked text-avatar-locked-text',
  ai: 'bg-avatar-ai text-avatar-ai-text',
} as const;
export type AvatarTone = keyof typeof AVATAR;

/** Ảnh đại diện tròn chữ viết tắt, 700; cỡ chữ ≈ 0.35 × đường kính (pen: 24→9, 26→9, 30→11, 34→11). */
const AVATAR_LH: Record<number, number> = { 9: 11, 9.5: 12, 11: 14 };

export function Avatar({ initials, tone = 'admin', size = 26, fontSize, className }: { initials: string; tone?: AvatarTone; size?: number; fontSize?: number; className?: string }) {
  const fs = fontSize ?? (size >= 30 ? 11 : 9);
  return (
    <span
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full leading-[normal] font-bold', AVATAR[tone], className)}
      style={{ width: size, height: size, fontSize: fs, lineHeight: `${AVATAR_LH[fs] ?? Math.round(fs * 1.25)}px` }}
    >
      {initials}
    </span>
  );
}
