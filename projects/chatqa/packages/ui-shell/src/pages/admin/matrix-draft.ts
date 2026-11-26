// Bảng quyền theo vai: bản nháp trên màn hình so với bản đã lưu (FR-011). Chỉ gửi các ô đổi; ô khoá không đổi được (BR-003).
import permissions from '@contracts/permissions.json';
import type { MatrixView } from './admin-api';

export const PERMS = permissions.permissions;
export const GROUPS = permissions.groups;
export const EDIT_ROLES = ['manager', 'leader', 'staff'] as const;

/** Quyền có trong bảng máy chủ trả về: chỉ quyền của sản phẩm công ty có bản quyền. */
export const shown = (cells: Cells, perm: string) => EDIT_ROLES.some((r) => !!cells[r] && perm in cells[r]);
export type EditRole = (typeof EDIT_ROLES)[number];

const LOCKED = new Set(PERMS.filter((p) => p.locked).map((p) => p.code));

export type Cells = Record<string, Record<string, boolean>>;

/** Ô không chỉnh được: cột admin (luôn có) và các dòng khoá (BR-003). */
export const isLocked = (role: string, perm: string) => role === 'admin' || LOCKED.has(perm);

export interface CellChange {
  role: string;
  perm: string;
  from: boolean;
  to: boolean;
}

/** Bật/tắt một ô trong bản nháp; ô khoá thì giữ nguyên. */
export function toggled(draft: Cells, role: string, perm: string): Cells {
  if (isLocked(role, perm)) return draft;
  return { ...draft, [role]: { ...draft[role], [perm]: !draft[role][perm] } };
}

/** Các ô khác với bản đã lưu (cho chip "{n} thay đổi chưa lưu" và viền cam). */
export function changesOf(saved: MatrixView, draft: Cells): CellChange[] {
  const out: CellChange[] = [];
  for (const role of EDIT_ROLES) {
    for (const p of PERMS) {
      const from = saved.cells[role][p.code];
      const to = draft[role][p.code];
      if (from !== to) out.push({ role, perm: p.code, from, to });
    }
  }
  return out;
}

/** Thân PUT /matrix: chỉ các ô đổi, kèm version đã mở. */
export function saveBody(saved: MatrixView, draft: Cells) {
  const cells: Cells = {};
  for (const c of changesOf(saved, draft)) (cells[c.role] ??= {})[c.perm] = c.to;
  return { version: saved.version, cells };
}

export const hasChanges = (saved: MatrixView, draft: Cells) => changesOf(saved, draft).length > 0;

/** Bản nháp ban đầu = bản đã lưu (sao chép để sửa). */
export const draftFrom = (saved: MatrixView): Cells => Object.fromEntries(Object.entries(saved.cells).map(([r, row]) => [r, { ...row }]));

/** Số ô thay đổi theo từng nhóm (cho tiêu đề nhóm). */
export function changesByGroup(saved: MatrixView, draft: Cells): Record<string, number> {
  const group = new Map(PERMS.map((p) => [p.code, p.group]));
  const out: Record<string, number> = {};
  for (const c of changesOf(saved, draft)) out[group.get(c.perm)!] = (out[group.get(c.perm)!] ?? 0) + 1;
  return out;
}
