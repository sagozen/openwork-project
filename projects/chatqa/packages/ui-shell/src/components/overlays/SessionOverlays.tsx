// Hộp thoại / khoá màn toàn cục theo AuthState của Go: phiên hết hạn, quá hạn offline, bị khoá khi đang dùng, máy bị thu hồi.
// Là anh em của màn đang làm (không bọc nó), nên đè lên mà không đổi route và không mất dữ liệu đang gõ.
import { useEffect, useState } from 'react';
import { isDesktop, platform } from '../../platform';
import { errorText, useSession } from '../../lib/session';
import { overlayOf } from '../../lib/auth-flow';
import { useAction } from '../../lib/use-action';
import { LockedOutDialog, OfflineLockScreen, RevokedDialog, SessionExpiredDialog } from './dialogs';

/** Đóng cửa sổ app (Wails runtime.Quit); ngoài Wails thì đóng tab. */
export function closeApp() {
  const rt = (window as unknown as { runtime?: { Quit?: () => void } }).runtime;
  if (rt?.Quit) rt.Quit();
  else window.close();
}

function ExpiredOverlay() {
  const { username, refresh } = useSession();
  const [name, setName] = useState(username);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'relogin' | 'logout' | null>(null);
  useEffect(() => setName(username), [username]);

  // Đăng nhập lại (nút hoặc Enter) và Đăng xuất dùng chung một cờ: đang chạy thì lần bấm tiếp bị bỏ qua.
  const [run, busy] = useAction(async (kind: 'relogin' | 'logout') => {
    setPending(kind);
    try {
      if (kind === 'logout') {
        try {
          await platform.logout();
        } finally {
          await refresh();
        }
        return;
      }
      setError('');
      try {
        await platform.login(name.trim(), password);
        setPassword('');
        await refresh(); // Go xoá overlay; màn đang làm không bị gỡ nên route và form còn nguyên
      } catch (e) {
        setError(errorText(e));
        setPassword('');
      }
    } finally {
      setPending(null);
    }
  });
  const relogin = () => (name.trim() && password ? run('relogin') : undefined);
  const logout = () => run('logout');
  return (
    <SessionExpiredDialog
      text={errorText({ code: 'session_expired' })}
      username={name}
      onUsername={username ? undefined : setName}
      password={password}
      onPassword={setPassword}
      error={error}
      busy={busy}
      pending={pending}
      onRelogin={() => void relogin()}
      onLogout={() => void logout()}
    />
  );
}

function OfflineOverlay() {
  const { auth, refresh } = useSession();
  const days = auth.offlineDays;
  // Thử lại và Đăng xuất dùng chung một cờ: đang chạy thì cả hai nút khoá.
  const [run, busy] = useAction(async (kind: 'retry' | 'logout') => {
    try {
      if (kind === 'logout') await platform.logout();
    } finally {
      await refresh(); // GetState thử gọi máy chủ; nếu liên lạc được thì Go đặt lại đồng hồ và overlay biến mất
    }
  });
  const retry = () => run('retry');
  const logout = () => run('logout');
  return (
    <OfflineLockScreen
      title={`Máy đã ${days} ngày chưa kết nối`}
      text={errorText({ code: 'offline_expired' }, { n: days })}
      pending={auth.pending}
      busy={busy}
      onRetry={() => void retry()}
      onLogout={() => void logout()}
    />
  );
}

export function SessionOverlays() {
  const { state, auth, refresh } = useSession();
  // Bị khoá: Go đã đăng xuất sẵn và giữ overlay tới lần đăng nhập kế; bấm Đăng xuất chỉ cần ẩn hộp (theo giờ khoá, khoá lần sau vẫn hiện).
  const [ackedAt, setAckedAt] = useState<number | null>(null);
  const overlay = overlayOf(state);
  if (!isDesktop || !overlay) return null;
  switch (overlay) {
    case 'expired':
      return <ExpiredOverlay />;
    case 'offline_locked':
      return <OfflineOverlay />;
    case 'locked_out':
      if (ackedAt === auth.at) return null;
      return (
        <LockedOutDialog
          text={errorText({ code: 'locked_in_use' }, { lockedAt: auth.at })}
          onLogout={() => {
            setAckedAt(auth.at);
            void platform.logout().finally(() => void refresh());
          }}
        />
      );
    case 'revoked':
      return <RevokedDialog text={errorText({ code: 'device_revoked' })} onClose={closeApp} />;
  }
}
