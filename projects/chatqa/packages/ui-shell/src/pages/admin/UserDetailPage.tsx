import { useState } from 'react';
import { Check, KeyRound, LockOpen, Lock, Pencil } from 'lucide-react';
import { Navigate, useParams } from 'react-router';
import { Button } from '../../components/ui';
import { useAction } from '../../lib/use-action';
import { roleServedByProduct } from '../../platform/roles';
import type { AppCode } from '../../platform/types';
import { PRODUCT_APPS } from '../../lib/catalog';
import { adminApi, type AdminDevice, type AdminUser, type AdminUserDetail, type AuditItem, type WebSession } from './admin-api';
import { toAdminError, writeOnline } from './admin-error';
import { DEFAULT_ACTIONS, makeLookups, presentAudit } from './audit-format';
import { useAdmin, usePhoneLayout } from './admin-context';
import { AdminPage, AdminToast, ErrorBanner } from './parts';
import { PhoneAdminPage } from './phone/parts';
import { UserDetailPhone } from './phone/UserDetailPhone';
import { HistoryPanel, ProfilePanel, SessionsPanel } from './user-detail-panels';
import { unlockUser, UserActionDialogs, type UserDialogState } from './UserActionDialogs';
import { useResource } from './use-resource';

const GRID_APPS = PRODUCT_APPS.filter((a) => a.status === 'active').map((a) => a.code as AppCode);

export default function UserDetailPage() {
  const { id = '' } = useParams();
  const phone = usePhoneLayout();
  const { base } = useAdmin();
  const nowSec = Math.floor(Date.now() / 1000);
  const res = useResource(async () => {
    const [user, users, license, devices] = await Promise.all([
      adminApi.user(id),
      adminApi.users().catch(() => [] as AdminUser[]),
      adminApi.license().catch(() => null),
      adminApi.devices().catch(() => [] as AdminDevice[]),
    ]);
    // Lịch sử của người này (cả việc họ làm và việc làm với họ); lỗi thì bỏ qua, trang vẫn dùng được.
    const history = await adminApi.audit({ user: id, action: DEFAULT_ACTIONS, limit: 8 }).then((p) => p.items, () => [] as AuditItem[]);
    return { user, users, licenseApps: (license?.apps ?? GRID_APPS) as AppCode[], devices, history };
  }, [id]);
  const [dialog, setDialog] = useState<UserDialogState>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const d = res.data;
  const u: AdminUserDetail | undefined = d?.user;

  // Đăng xuất từ xa (một phiên hoặc tất cả) dùng chung một cờ: đang chạy thì mọi nút phiên đều khoá, không gửi trùng.
  const [pendingSession, setPendingSession] = useState<string | null>(null);
  const [revokeSessions, revoking] = useAction(async (target: WebSession | 'all') => {
    if (!u) return;
    setError(null);
    setPendingSession(target === 'all' ? 'all' : target.id);
    try {
      const list = target === 'all' ? u.web_sessions : [target];
      for (const s of list) await writeOnline(() => adminApi.revokeWebSession(u.id, s.id));
      await res.reload();
    } catch (e) {
      setError(toAdminError(e));
      if (target === 'all') await res.reload();
    } finally {
      setPendingSession(null);
    }
  });
  const [unlock, unlocking] = useAction(async (user: AdminUser) => {
    setError(null);
    try {
      await unlockUser(user);
      setToast(`Đã mở khoá tài khoản ${user.display_name}.`);
      await res.reload();
    } catch (e) {
      setError(toAdminError(e));
    }
  });
  const revoke = (s: WebSession) => revokeSessions(s);
  const revokeAll = () => revokeSessions('all');
  const sessionBusy = revoking ? pendingSession : null;

  const lookups = d ? makeLookups(d.users, d.devices) : null;
  const history = d && lookups ? d.history.map((it) => presentAudit(it, lookups)) : [];
  const locked = u?.status === 'locked';

  const dialogs = (
    <UserActionDialogs
      dialog={dialog}
      setDialog={setDialog}
      users={d?.users ?? []}
      licenseApps={d?.licenseApps ?? GRID_APPS}
      onUnlock={(x) => void unlock(x)}
      unlocking={unlocking}
      onDone={(text) => {
        setDialog(null);
        setToast(text);
        void res.reload();
      }}
    />
  );
  const toastEl = toast && (
    <AdminToast icon={<Check size={15} />} onClose={() => setToast(null)}>
      {toast}
    </AdminToast>
  );

  // Tài khoản của sản phẩm khác (Vipo của HS Desk): không sửa được ở đây, về danh sách.
  if (u && !roleServedByProduct(u.role)) return <Navigate to={`${base}/nguoi-dung`} replace />;

  if (phone) {
    return (
      <PhoneAdminPage title={u?.display_name ?? ' '} back={`${base}/nguoi-dung`} error={res.error ?? error}>
        {u && d && (
          <UserDetailPhone
            user={u}
            licenseApps={d.licenseApps}
            nowSec={nowSec}
            onEdit={() => setDialog({ kind: 'edit', user: u })}
            onReset={() => setDialog({ kind: 'reset', user: u })}
            onLock={() => setDialog({ kind: 'lock', user: u })}
            onUnlock={() => void unlock(u)}
            onRevoke={(x) => void revoke(x)}
            onRevokeAll={() => void revokeAll()}
            unlocking={unlocking}
            sessionBusy={sessionBusy}
          />
        )}
        {!u && res.loading && <p className="py-16 text-center text-sm text-text-3">Đang tải...</p>}
        {dialogs}
        {toastEl}
      </PhoneAdminPage>
    );
  }

  return (
    <AdminPage
      tab="users"
      crumb={`Cài đặt › Người dùng & quyền › ${u?.display_name ?? '…'}`}
      title={u?.display_name ?? ' '}
      actions={
        u && (
          <>
            <Button variant="secondary" icon={<Pencil size={15} />} onClick={() => setDialog({ kind: 'edit', user: u })}>
              Sửa
            </Button>
            <Button variant="secondary" icon={<KeyRound size={15} />} onClick={() => setDialog({ kind: 'reset', user: u })}>
              Đặt lại mật khẩu
            </Button>
            {locked ? (
              <Button variant="secondary" icon={<LockOpen size={15} />} loading={unlocking} onClick={() => void unlock(u)}>
                {unlocking ? 'Đang mở khoá…' : 'Mở khoá'}
              </Button>
            ) : (
              <Button variant="secondary" icon={<Lock size={15} />} onClick={() => setDialog({ kind: 'lock', user: u })} className="[--stroke-c:var(--color-line-red)] !text-red">
                Khoá
              </Button>
            )}
          </>
        )
      }
    >
      <ErrorBanner error={res.error ?? error} />
      {!u && res.loading && <p className="py-16 text-center text-sm text-text-3">Đang tải...</p>}
      {u && d && (
        <div className="flex min-h-0 w-full flex-1 items-start gap-[16px]">
          <ProfilePanel u={u} licenseApps={d.licenseApps} nowSec={nowSec} />
          <div className="flex min-w-0 flex-1 flex-col gap-[16px]">
            <SessionsPanel u={u} nowSec={nowSec} busy={sessionBusy} onRevoke={(x) => void revoke(x)} onRevokeAll={() => void revokeAll()} />
            {history.length > 0 && <HistoryPanel history={history} />}
          </div>
        </div>
      )}
      {dialogs}
      {toastEl}
    </AdminPage>
  );
}
