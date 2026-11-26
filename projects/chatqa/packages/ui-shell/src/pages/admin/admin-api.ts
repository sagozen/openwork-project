// Gọi API quản trị công ty (worker/src/routes/admin-*.ts). Mọi hàm cần mạng: mất mạng => ApiError E-020, không lưu gì (NFR-004).
import { platform } from '../../platform';
import { ApiError, type AppCode } from '../../platform/types';
import { PRODUCT } from '@product/product';

const A = '/v1/admin';

export type UserStatus = 'active' | 'temp_locked' | 'locked';

export interface AdminUser {
  id: string;
  username: string;
  display_name: string;
  role: string;
  status: UserStatus;
  /** null = mọi app bản quyền bật. */
  apps: AppCode[] | null;
  is_deployer: boolean;
  must_change_pw: boolean;
  temp_pw_expires_at: number | null;
  locked_at: number | null;
  temp_locked_until: number | null;
  last_login_at: number | null;
  last_device: string | null;
  created_at: number;
}

export interface WebSession {
  id: string;
  created_at: number;
  last_seen: number;
  ua: string | null;
  ip_hint: string | null;
}

export interface AdminUserDetail extends AdminUser {
  is_last_admin: boolean;
  web_sessions: WebSession[];
}

export interface CreatedUser {
  id: string;
  username: string;
  /** Chỉ hiện đúng một lần (NFR-001). */
  tempPassword: string;
  tempPasswordExpiresAt: number;
}

export interface MatrixView {
  version: number;
  updatedBy: { id: string; name: string } | null;
  updatedAt: number | null;
  roles: string[];
  /** cells[vai][quyền] */
  cells: Record<string, Record<string, boolean>>;
}

export interface LicenseView {
  id: string;
  apps: AppCode[];
  maxDevices: number;
  used: number;
  keyMasked: string;
  status: string;
  expiresAt: number;
  offlineHours: number;
}

export interface AdminDevice {
  id: string;
  name: string;
  app_version: string | null;
  activated_at: number;
  last_seen: number;
  revoked: number;
  revoked_at: number | null;
  key_hint: string;
  last_user_id: string | null;
  last_user_name: string | null;
  status: 'in_use' | 'offline_overdue' | 'revoked';
}

export interface AuditItem {
  id: number;
  at: number;
  actor_user_id: string | null;
  actor_label: string;
  actor_name: string | null;
  actor_locked: boolean;
  actor_deployer: boolean;
  action: string;
  target_type: string;
  target_id: string | null;
  target_name: string | null;
  before: unknown;
  after: unknown;
}

export interface AuditPage {
  items: AuditItem[];
  total: number;
  next: number | null;
}

export interface AuditQuery {
  user?: string;
  action?: string[];
  from?: number;
  to?: number;
  cursor?: number;
  limit?: number;
}

export interface PendingOp {
  id: string;
  user_id: string;
  user_name: string | null;
  user_locked: boolean;
  device_id: string | null;
  device_name: string | null;
  /** Máy gửi perm + app; `label`/`object` là mô tả tuỳ chọn máy Windows có thể kèm ("Gộp 12 dòng vào lô", "LO-2611-021"). */
  op: { perm?: string; app?: string; label?: string; object?: string } | null;
  device_time: number;
  created_at: number;
  reason: string;
  status: 'pending' | 'accepted' | 'dropped';
  decided_by_name: string | null;
  decided_at: number | null;
}

export interface UserInput {
  username: string;
  displayName?: string;
  role: string;
  apps?: AppCode[] | null;
  isDeployer?: boolean;
  password?: string;
}

export const qs = (q: Record<string, string | number | undefined>) => {
  const p = Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
};

export const auditQuery = (q: AuditQuery) => qs({ user: q.user, action: q.action?.join(','), from: q.from, to: q.to, cursor: q.cursor, limit: q.limit });

const call = <T>(path: string, method = 'GET', body?: unknown) => platform.api<T>(`${A}${path}`, { method, body });

export const adminApi = {
  users: () => call<AdminUser[]>('/users'),
  user: (id: string) => call<AdminUserDetail>(`/users/${id}`),
  createUser: (u: UserInput) => call<CreatedUser>('/users', 'POST', u),
  updateUser: (id: string, patch: { displayName?: string; role?: string; apps?: AppCode[] | null; active?: boolean }) => call<{ ok: true; changed: boolean }>(`/users/${id}`, 'PATCH', patch),
  /** password: mật khẩu admin chọn trong hộp thoại; Worker hiện tại tự sinh và bỏ qua trường này, nên luôn dùng `tempPassword` trả về. */
  resetPassword: (id: string, password?: string) => call<{ tempPassword: string; expiresAt: number }>(`/users/${id}/reset-password`, 'POST', password ? { password } : undefined),
  revokeWebSession: (userId: string, sid: string) => call<{ ok: true }>(`/users/${userId}/web-sessions/${sid}`, 'DELETE'),

  matrix: () => call<MatrixView>('/matrix'),
  saveMatrix: (version: number, cells: Record<string, Record<string, boolean>>) => call<MatrixView>('/matrix', 'PUT', { version, cells }),
  /** `product`: chỉ trả các ô của sản phẩm đó về mặc định (ChatQASoftware); bỏ trống = mọi quyền công ty có bản quyền. */
  resetMatrix: (version: number, product?: string) => call<MatrixView>('/matrix/reset', 'POST', product ? { version, product } : { version }),

  license: () => call<LicenseView>(`/license?product=${PRODUCT.code}`),
  devices: () => call<AdminDevice[]>('/devices'),
  revokeDevice: (id: string) => call<{ ok: true; changed: boolean }>(`/devices/${id}/revoke`, 'POST'),
  reactivateDevice: (id: string) => call<{ ok: true; changed: boolean }>(`/devices/${id}/reactivate`, 'POST'),

  audit: (q: AuditQuery = {}) => call<AuditPage>(`/audit${auditQuery(q)}`),
  pendingOps: (status: 'pending' | 'accepted' | 'dropped' | 'all' = 'pending') => call<PendingOp[]>(`/pending-ops${qs({ status })}`),
  decidePending: (id: string, decision: 'accept' | 'drop') => call<{ ok: true }>(`/pending-ops/${id}/${decision}`, 'POST'),
};

/** Lỗi E-020 khi mất mạng ở màn quản trị: không lưu gì. */
export const needNetwork = () => new ApiError('need_network', 0);
