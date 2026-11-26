// Phiên PWA và cache API của service worker: đổi người dùng (đăng nhập, đăng xuất, phiên hết hạn 401) phải xoá cache 'api'.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pwaPlatform } from './pwa';

const store = new Map<string, string>();
let cacheNames: Set<string>;
const respond = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

beforeEach(() => {
  store.clear();
  cacheNames = new Set(['api', 'sheets', 'workbox-precache']);
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  vi.stubGlobal('caches', { delete: (n: string) => Promise.resolve(cacheNames.delete(n)) });
});
afterEach(() => vi.unstubAllGlobals());

const session = { token: 't', exp: 4102444800, user: { id: 'u1', tenant: 'x', name: 'Lan', role: 'manager' } };

describe('cache API của service worker (PWA)', () => {
  it('đăng xuất: huỷ phiên ở Worker, xoá phiên cục bộ và cache api + sheets, giữ precache của app', async () => {
    store.set('hsdesk.session', JSON.stringify(session));
    const fetchMock = vi.fn(() => respond(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await pwaPlatform.logout();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/logout', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer t' }) }));
    expect(store.has('hsdesk.session')).toBe(false);
    expect([...cacheNames]).toEqual(['workbox-precache']);
  });

  it('đăng xuất khi mất mạng vẫn xoá phiên và cache', async () => {
    store.set('hsdesk.session', JSON.stringify(session));
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network'))));
    await pwaPlatform.logout();
    expect(store.has('hsdesk.session')).toBe(false);
    expect(cacheNames.has('api')).toBe(false);
  });

  it('đăng nhập người mới xoá cache của người trước (phiên cũ hết hạn, không đăng xuất)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => respond(200, session)));
    await pwaPlatform.login('tranlan', 'matkhau-12345');
    expect(cacheNames.has('api')).toBe(false);
    expect(JSON.parse(store.get('hsdesk.session')!).user.id).toBe('u1');
  });

  it('phiên bị Worker từ chối (401: khoá tài khoản, đăng xuất từ xa, đổi mật khẩu nơi khác) xoá phiên và cache', async () => {
    store.set('hsdesk.session', JSON.stringify(session));
    vi.stubGlobal('fetch', vi.fn(() => respond(401, { error: 'session_revoked' })));
    await expect(pwaPlatform.api('/v1/admin/users')).rejects.toMatchObject({ status: 401 });
    expect(store.has('hsdesk.session')).toBe(false);
    expect(cacheNames.has('api')).toBe(false);
  });

  it('đăng nhập sai (401 ở chính màn đăng nhập) không đụng phiên khác', async () => {
    store.set('hsdesk.session', JSON.stringify(session));
    vi.stubGlobal('fetch', vi.fn(() => respond(401, { error: 'invalid_credentials' })));
    await expect(pwaPlatform.login('a', 'b')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(store.has('hsdesk.session')).toBe(true);
  });
});
