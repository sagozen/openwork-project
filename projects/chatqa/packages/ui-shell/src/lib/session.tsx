import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NO_AUTH, platform, type AppCode, type AppState } from '../platform';
import { isAdmin } from '../platform/roles';
import { appItem as findAppItem } from './auth-flow';
import { companyLabel, keepUserWhileExpired } from './auth-ui';
import { demoFlag } from './demo';
import { SessionContext, type AppAccess, type SessionCtx } from './session-context';
import { PRODUCT } from '@product/product';
export { errorText } from './errors';
export { useSession, type AppAccess } from './session-context';

const USER_KEY = `${PRODUCT.code}.lastUsername`;
const readUsername = () => {
  try {
    return localStorage.getItem(USER_KEY) ?? '';
  } catch {
    return '';
  }
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [username, setUsername] = useState(readUsername);
  // ?demo=temp-held (chỉ bản dev, bộ so ảnh): coi như vừa gõ mật khẩu tạm ở màn đăng nhập nên màn bắt buộc không hỏi lại.
  const secret = useRef(import.meta.env.DEV && demoFlag('temp-held') ? 'mat-khau-tam' : '');
  const lastUser = useRef<AppState['user']>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await platform.getState();
      if (next.user) lastUser.current = next.user;
      else if (next.auth?.overlay !== 'expired') lastUser.current = null;
      setState(keepUserWhileExpired(next, lastUser.current));
      setError(null);
    } catch (e) {
      // Trước đây lỗi bị nuốt => state null => app hiện nhầm màn "Kích hoạt bản quyền".
      console.error('getState', e);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Go phát "auth:state" khi hộp thoại/khoá màn đổi (heartbeat báo khoá, thu hồi, hết hạn offline, phiên hết hạn):
  // đọc lại toàn bộ trạng thái để user, ứng dụng và hộp thoại cùng khớp.
  useEffect(() => platform.onAuthState?.(() => void refresh()), [refresh]);

  // Mật khẩu tạm chỉ cần tới khi đổi xong: hết nhu cầu thì xoá khỏi bộ nhớ.
  useEffect(() => {
    if (state && !state.auth?.mustChangePassword) secret.current = '';
  }, [state]);

  const value = useMemo<SessionCtx>(() => {
    // PWA không có license theo máy (license null) => chỉ xét quyền người dùng.
    // user.apps null/thiếu = mọi app bản quyền bật (Worker: migrations/0003_user_apps.sql).
    const appAccess = (code: AppCode): AppAccess => {
      if (state?.license && !state.license.apps.includes(code)) return 'license';
      const apps = state?.user?.apps;
      if (apps && !apps.includes(code)) return 'user';
      return 'ok';
    };
    return {
      state,
      loading,
      error,
      refresh,
      hasApp: (code) => appAccess(code) === 'ok',
      appAccess,
      can: (perm) => isAdmin(state?.user?.role) || !!state?.user?.perms?.includes(perm),
      auth: state?.auth ?? NO_AUTH,
      appItem: (code) => findAppItem(state, code),
      company: companyLabel(state),
      username,
      rememberLogin: (u, p) => {
        const name = u.trim().toLowerCase();
        setUsername(name);
        secret.current = p;
        try {
          localStorage.setItem(USER_KEY, name);
        } catch {
          /* private mode */
        }
      },
      tempPassword: () => secret.current,
    };
  }, [state, loading, error, refresh, username]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
