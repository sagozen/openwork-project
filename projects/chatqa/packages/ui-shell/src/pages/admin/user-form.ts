// Biểu mẫu Thêm / Sửa người dùng (FR-008, FR-009): kiểm tra, thân gửi lên, ảnh hưởng của việc hạ vai / bỏ app.
import roles from '@contracts/roles.json';
import limits from '@contracts/limits.json';
import { PRODUCT } from '@product/product';
import { rolesForProduct } from '../../platform/roles';
import { stripMarks } from './format';
import type { AdminUser, UserInput } from './admin-api';
import type { AppCode } from '../../platform/types';

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** Vai chọn được ở sản phẩm này (ChatQASoftware không có Vipo — vai chỉ dùng HS Desk). */
export const roleOptions = (product: string = PRODUCT.code) => rolesForProduct(product).map((r) => ({ key: r.code, label: r.label }));
export const ROLE_OPTIONS = roleOptions();
/** Thứ bậc để biết "hạ vai": admin > manager > leader > staff > vipo. */
const RANK: Record<string, number> = { admin: 4, manager: 3, leader: 2, staff: 1, vipo: 0 };

export const roleLabelOf = (code: string) => roles.roles.find((r) => r.code === code)?.label ?? code;
export const isDemotion = (from: string, to: string) => (RANK[to] ?? 0) < (RANK[from] ?? 0);

export interface UserForm {
  username: string;
  displayName: string;
  role: string;
  /** App đang chọn (chỉ gồm app đã kích hoạt cho công ty). */
  apps: AppCode[];
  isDeployer: boolean;
  password: string;
}

export const emptyForm = (licenseApps: AppCode[]): UserForm => ({ username: '', displayName: '', role: 'staff', apps: [...licenseApps], isDeployer: false, password: '' });

export const formFromUser = (u: AdminUser, licenseApps: AppCode[]): UserForm => ({
  username: u.username,
  displayName: u.display_name,
  role: u.role,
  apps: u.apps ?? [...licenseApps],
  isDeployer: u.is_deployer,
  password: '',
});

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Chọn hết app đã kích hoạt => gửi null ("mọi app bản quyền bật", theo cả app mở thêm về sau). */
export const appsBody = (apps: AppCode[], licenseApps: AppCode[]): AppCode[] | null => (sameSet(apps, licenseApps) ? null : apps);

/** Vai Vipo không có app nội bộ (BR-013). */
export const effectiveApps = (role: string, apps: AppCode[]): AppCode[] => (role === 'vipo' ? [] : apps);

export type FormProblem = 'invalid_input' | 'weak_password' | null;

/** Lỗi nhập (chưa gọi máy chủ). username_taken do máy chủ trả (E-008). */
export function createProblems(f: UserForm): { username: FormProblem; password: FormProblem; deployer: FormProblem } {
  return {
    username: USERNAME_RE.test(f.username.trim().toLowerCase()) ? null : 'invalid_input',
    password: f.password.length >= limits.passwordMinLength ? null : 'weak_password',
    deployer: f.isDeployer && f.role !== 'admin' ? 'invalid_input' : null,
  };
}

export const canCreate = (f: UserForm) => {
  const p = createProblems(f);
  return !p.username && !p.password && !p.deployer;
};

export function createBody(f: UserForm, licenseApps: AppCode[]): UserInput {
  return {
    username: f.username.trim().toLowerCase(),
    displayName: f.displayName.trim() || undefined,
    role: f.role,
    apps: f.role === 'vipo' ? [] : appsBody(f.apps, licenseApps),
    isDeployer: f.isDeployer || undefined,
    password: f.password,
  };
}

export interface UserPatch {
  displayName?: string;
  role?: string;
  apps?: AppCode[] | null;
}

/** Chỉ các trường đổi; null = không có gì để lưu. */
export function editPatch(orig: AdminUser, f: UserForm, licenseApps: AppCode[]): UserPatch | null {
  const patch: UserPatch = {};
  if (f.displayName.trim() && f.displayName.trim() !== orig.display_name) patch.displayName = f.displayName.trim();
  if (f.role !== orig.role) patch.role = f.role;
  const before = effectiveApps(orig.role, orig.apps ?? licenseApps);
  const after = effectiveApps(f.role, f.apps);
  if (f.role !== 'vipo' && !sameSet(before, after)) patch.apps = appsBody(f.apps, licenseApps);
  return Object.keys(patch).length ? patch : null;
}

export interface EditImpact {
  demoted: boolean;
  fromRole: string;
  toRole: string;
  removedApps: AppCode[];
  /** Có cần hiện bảng cảnh báo FR-009 (lô đang giữ, mặt hàng đang khoá)? Không chặn lưu. */
  needsPreflight: boolean;
}

export function editImpact(orig: AdminUser, f: UserForm, licenseApps: AppCode[]): EditImpact {
  const before = effectiveApps(orig.role, orig.apps ?? licenseApps);
  const after = effectiveApps(f.role, f.apps);
  const removedApps = before.filter((a) => !after.includes(a));
  const demoted = isDemotion(orig.role, f.role);
  return { demoted, fromRole: orig.role, toRole: f.role, removedApps, needsPreflight: demoted || removedApps.length > 0 };
}

/** Mật khẩu tạm gợi ý "Vy-7429-tam" (tên cuối bỏ dấu + 4 số + "tam"): đủ dài, dễ đọc qua điện thoại. */
export function suggestTempPassword(displayName: string, digits: () => string = randomDigits): string {
  const last = stripMarks(displayName.trim().split(/\s+/).pop() ?? '').replace(/[^A-Za-z0-9]/g, '');
  const head = last ? last[0].toUpperCase() + last.slice(1).toLowerCase() : 'Hs';
  return `${head}-${digits()}-tam`;
}

function randomDigits(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  return String(n).padStart(4, '0');
}

const BLOCKING = new Set(['username_taken', 'last_admin']);
const codeOf = (e: unknown) => (e as { code?: string } | null)?.code ?? '';

/** Lỗi chặn lưu (E-009 tên trùng, E-010 admin cuối): nút lưu tắt cho tới khi người dùng sửa biểu mẫu. */
export const isBlockingError = (e: unknown) => BLOCKING.has(codeOf(e));

/** Nút lưu bật được? Thêm: đủ thông tin; Sửa: có thay đổi và còn tên hiển thị. Đang có lỗi chặn thì tắt. */
export function canSaveUser(mode: 'add' | 'edit', form: UserForm, patch: UserPatch | null, error: unknown): boolean {
  if (isBlockingError(error)) return false;
  return mode === 'add' ? canCreate(form) : !!patch && !!form.displayName.trim();
}
