// Adapter cho PWA quản lý: gọi thẳng Worker cùng origin.
import { ApiError, NO_AUTH, type AppState, type GoogleToken, type LessonsApi, type Platform, type RulesApi, type SuggestApi, type TariffApi, type TeachApi, type User, type VipoApi, type LotApi, type CheckApi } from './types';
import { PRODUCT } from '@product/product';

const KEY = `${PRODUCT.code}.session`;
/** Cache của service worker chứa phản hồi API theo URL (không theo người dùng): phải xoá mỗi khi đổi người dùng (vite.config.ts: runtimeCaching). */
const API_CACHES = ['api', 'sheets'];

interface Stored {
  token: string;
  exp: number;
  user: User;
  /** Đăng nhập bằng mật khẩu tạm: chỉ được đổi mật khẩu. */
  mustChangePassword?: boolean;
}

function load(): Stored | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
    return s && s.exp > Date.now() / 1000 ? s : null;
  } catch {
    return null;
  }
}

function save(s: Stored | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

/** Xoá dữ liệu API đã cache để người kế tiếp trên máy dùng chung không thấy dữ liệu người trước (cả khi mất mạng). */
export async function clearApiCaches(): Promise<void> {
  try {
    await Promise.all(API_CACHES.map((n) => caches.delete(n)));
  } catch {
    /* không có Cache API */
  }
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }, token?: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    // Phiên hết hiệu lực / tài khoản bị khoá / đổi mật khẩu ở nơi khác: bỏ phiên cục bộ, quay về đăng nhập.
    if (res.status === 401 && path !== '/v1/auth/login' && path !== '/v1/auth/change-password') {
      save(null);
      await clearApiCaches();
    }
    const { error: _e, ...params } = data as Record<string, unknown>;
    throw new ApiError(data.error ?? `http_${res.status}`, res.status, params as Record<string, string | number>);
  }
  return data as T;
}

/** Sổ quy tắc chỉ có ở app desktop (dữ liệu nằm trên máy): mọi hàm từ chối bằng desktop_only. Không giả làm thenable. */
export const pwaRules = new Proxy({} as RulesApi, {
  get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : () => Promise.reject(new ApiError('desktop_only', 0))),
});

/** Báo giá và Sổ dạy AI chỉ có ở app desktop. */
export const pwaSuggest = new Proxy({} as SuggestApi, {
  get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : () => Promise.reject(new ApiError('desktop_only', 0))),
});
export const pwaLessons = new Proxy({} as LessonsApi, {
  get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : () => Promise.reject(new ApiError('desktop_only', 0))),
});

/** Biểu thuế chỉ có ở app desktop (dữ liệu nằm trên máy): mọi hàm từ chối bằng desktop_only. Không giả làm thenable. */
export const pwaTariff = new Proxy({} as TariffApi, {
  get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : () => Promise.reject(new ApiError('desktop_only', 0))),
});

/** Sổ dạy AI chỉ có ở app desktop (bài học nằm trên máy): mọi hàm từ chối bằng desktop_only. */
export const pwaTeach = new Proxy({} as TeachApi, {
  get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : () => Promise.reject(new ApiError('desktop_only', 0))),
});

/** Sheet Vipo chỉ có ở app desktop: mọi hàm từ chối bằng desktop_only. Không giả làm thenable. */
export const pwaVipo = new Proxy({} as VipoApi, {
  get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : () => Promise.reject(new ApiError('desktop_only', 0))),
});

/** Gộp lô chỉ có ở app desktop: mọi hàm từ chối bằng desktop_only. Không giả làm thenable. */
export const pwaLot = new Proxy({} as LotApi, {
  get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : () => Promise.reject(new ApiError('desktop_only', 0))),
});

/** Kiểm tra trước khai báo chỉ có ở app desktop: mọi hàm từ chối bằng desktop_only. */
export const pwaCheck = new Proxy({} as CheckApi, {
  get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : () => Promise.reject(new ApiError('desktop_only', 0))),
});

export const pwaPlatform: Platform = {
  kind: 'pwa',
  async getState(): Promise<AppState> {
    return {
      user: load()?.user ?? null,
      auth: { ...NO_AUTH, mustChangePassword: !!load()?.mustChangePassword },
      license: null,
      version: { ui: import.meta.env.VITE_APP_VERSION ?? '0.1.0', bin: '-', coreApi: 0, uiSource: 'embedded' },
    };
  },
  async login(username, password) {
    // Đăng nhập là một người dùng mới: bỏ mọi dữ liệu API còn lại của người trước (phiên hết hạn, đóng tab không đăng xuất...).
    await clearApiCaches();
    const r = await request<Stored>('/v1/auth/login', { method: 'POST', body: { username, password, client: 'web', product: PRODUCT.code } });
    save(r);
    return r.user;
  },
  async changePassword(current, next, confirm) {
    const r = await request<Stored>('/v1/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next, confirmPassword: confirm } }, load()?.token);
    save({ ...r, mustChangePassword: false });
    return r.user;
  },
  async logout() {
    // Huỷ phiên ở máy chủ trước (admin thấy phiên biến mất ngay); lỗi mạng thì vẫn đăng xuất cục bộ.
    try {
      await request('/v1/auth/logout', { method: 'POST' }, load()?.token);
    } catch {
      /* mất mạng */
    }
    save(null);
    await clearApiCaches(); // máy dùng chung không lộ dữ liệu người trước khi offline
    return 0; // web không có hàng đợi đồng bộ cục bộ
  },
  api: <T>(path: string, init?: { method?: string; body?: unknown }) => request<T>(path, init, load()?.token),
  googleToken: () => request<GoogleToken>('/v1/google/token', { method: 'POST' }, load()?.token),
  rules: pwaRules,
  suggest: pwaSuggest,
  lessons: pwaLessons,
  tariff: pwaTariff,
  teach: pwaTeach,
  vipo: pwaVipo,
  lot: pwaLot,
  check: pwaCheck,
};
