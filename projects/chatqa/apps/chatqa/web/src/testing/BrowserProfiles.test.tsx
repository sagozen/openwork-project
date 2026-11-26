import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { errorText } from '@shell/lib/errors';
import { goError, towerApi, type BrowserProfile, type WebRuntimeStatus } from '../live/bridge';
import {
  applyRuntimeEvent,
  BrowserProfilesView,
  defaultBrowserKey,
  hostChip,
  installErrorText,
  newProfile,
  normalizeProfile,
  profileErrorText,
  profileIdFrom,
  validProfile,
  viewportPresets,
  type BrowserProfilesViewProps,
} from './BrowserProfiles';

afterEach(() => vi.unstubAllGlobals());

const good: BrowserProfile = {
  id: 'web-staging',
  name: 'Staging',
  browser: 'chromium',
  channel: '',
  width: 1280,
  height: 800,
  baseURL: 'https://staging.example.com',
  headless: true,
  allowedHosts: ['api.example.com', '*.example.com'],
  testIdAttribute: 'data-testid',
};

describe('kiểm hồ sơ như Go', () => {
  it('hồ sơ hợp lệ; test id trống dùng mặc định', () => {
    expect(validProfile(good)).toBe('');
    expect(validProfile({ ...good, testIdAttribute: '' })).toBe('');
    expect(validProfile({ ...good, browser: 'firefox' })).toBe('');
    expect(validProfile({ ...good, channel: 'msedge' })).toBe('');
    expect(validProfile({ ...good, allowedHosts: ['10.0.0.12', ' API.Example.com. '] })).toBe('');
  });

  it.each<[Partial<BrowserProfile>, string]>([
    [{ id: 'staging' }, 'mã hồ sơ phải có dạng web-<chữ thường, số, gạch ngang> (tối đa 40 ký tự)'],
    [{ id: 'web-Staging' }, 'mã hồ sơ phải có dạng web-<chữ thường, số, gạch ngang> (tối đa 40 ký tự)'],
    [{ id: `web-${'a'.repeat(41)}` }, 'mã hồ sơ phải có dạng web-<chữ thường, số, gạch ngang> (tối đa 40 ký tự)'],
    [{ name: '  ' }, 'tên hồ sơ trống hoặc dài quá 80 ký tự'],
    [{ name: 'x'.repeat(81) }, 'tên hồ sơ trống hoặc dài quá 80 ký tự'],
    [{ browser: 'edge' }, 'trình duyệt phải là chromium, firefox hoặc webkit'],
    [{ browser: 'firefox', channel: 'msedge' }, 'kênh msedge chỉ dùng với chromium'],
    [{ channel: 'opera' }, 'kênh trình duyệt phải trống, msedge hoặc chrome'],
    [{ width: 319 }, 'viewport phải trong 320..3840 x 240..2160'],
    [{ height: 2161 }, 'viewport phải trong 320..3840 x 240..2160'],
    [{ width: Number.NaN }, 'viewport phải trong 320..3840 x 240..2160'],
    [{ baseURL: 'staging.example.com' }, 'baseURL phải là http(s)://host[...] và không chứa tài khoản'],
    [{ baseURL: 'ftp://staging.example.com' }, 'baseURL phải là http(s)://host[...] và không chứa tài khoản'],
    [{ baseURL: 'https://user:pw@staging.example.com' }, 'baseURL phải là http(s)://host[...] và không chứa tài khoản'],
    [{ allowedHosts: ['exa mple.com'] }, 'host không hợp lệ: exa mple.com'],
    [{ allowedHosts: ['*.com'] }, 'wildcard phải trên một tên miền cụ thể: *.com'],
    [{ allowedHosts: ['*.vercel.app'] }, 'wildcard trên hậu tố công cộng không được phép: *.vercel.app'],
    [{ allowedHosts: ['*.co.uk'] }, 'wildcard trên hậu tố công cộng không được phép: *.co.uk'],
    [{ allowedHosts: ['a.*.example.com'] }, 'host không hợp lệ: a.*.example.com'],
    [{ testIdAttribute: '1bad' }, 'thuộc tính test id không hợp lệ'],
  ])('%j -> %s', (patch, msg) => {
    expect(validProfile({ ...good, ...patch })).toBe(msg);
  });

  it('ô host: chuẩn hoá, nhận cả URL dán vào, từ chối wildcard trên hậu tố công cộng', () => {
    expect(hostChip(' API.Example.com. ')).toEqual({ host: 'api.example.com' });
    expect(hostChip('https://cdn.example.com/a/b?x=1')).toEqual({ host: 'cdn.example.com' });
    expect(hostChip('*.my-app.vercel.app')).toEqual({ host: '*.my-app.vercel.app' });
    expect(hostChip('*.vercel.app')).toEqual({ error: 'wildcard trên hậu tố công cộng không được phép: *.vercel.app' });
    expect(hostChip('*.github.io')).toMatchObject({ error: expect.stringContaining('hậu tố công cộng') });
    expect(hostChip('  ')).toMatchObject({ error: expect.any(String) });
  });

  it('hồ sơ gửi Go: bỏ khoảng trắng, host không trùng, test id mặc định', () => {
    expect(normalizeProfile({ ...good, name: ' Staging ', allowedHosts: ['A.example.com', 'a.example.com.', ''], testIdAttribute: ' ' })).toMatchObject({
      name: 'Staging',
      allowedHosts: ['a.example.com'],
      testIdAttribute: 'data-testid',
    });
  });

  it('mã hồ sơ từ tên tiếng Việt, không trùng mã có sẵn', () => {
    expect(profileIdFrom('Staging Đơn hàng', [])).toBe('web-staging-don-hang');
    expect(profileIdFrom('Staging', ['web-staging', 'web-staging-2'])).toBe('web-staging-3');
    expect(profileIdFrom('!!!', [])).toBe('web-trinh-duyet');
    expect(validProfile({ ...good, id: profileIdFrom('x'.repeat(80), []) })).toBe('');
  });

  it('trình duyệt mặc định theo hệ điều hành: Edge có sẵn trên Windows, Chromium tải về trên macOS', () => {
    expect(defaultBrowserKey('windows/amd64')).toBe('msedge');
    expect(defaultBrowserKey('Win32')).toBe('msedge');
    expect(defaultBrowserKey('darwin/arm64')).toBe('chromium');
    expect(defaultBrowserKey('MacIntel')).toBe('chromium');
    expect(newProfile('windows/amd64')).toMatchObject({ browser: 'chromium', channel: 'msedge', headless: true, testIdAttribute: 'data-testid' });
    expect(newProfile('darwin/arm64')).toMatchObject({ browser: 'chromium', channel: '' });
    expect(viewportPresets.every((v) => validProfile({ ...good, width: v.width, height: v.height }) === '')).toBe(true);
  });
});

const missing: WebRuntimeStatus = {
  platform: 'darwin/arm64',
  node: { state: 'missing', version: '24.21.0', size: 48 * 1024 * 1024 },
  modules: { state: 'missing', version: '1.64.0', size: 30 * 1024 * 1024 },
  browsers: [
    { name: 'chromium', state: 'missing', size: 170 * 1024 * 1024 },
    { name: 'firefox', state: 'missing', size: 90 * 1024 * 1024 },
    { name: 'webkit', state: 'missing', size: 80 * 1024 * 1024 },
  ],
  channels: [
    { name: 'msedge', installed: false },
    { name: 'chrome', installed: true },
  ],
};

const view = (p: Partial<BrowserProfilesViewProps> = {}) =>
  renderToStaticMarkup(
    <BrowserProfilesView
      status={missing}
      progress={{}}
      installing={false}
      profiles={[]}
      os="darwin/arm64"
      onInstall={() => undefined}
      onSave={async () => ''}
      onDelete={() => undefined}
      {...p}
    />,
  );

describe('thẻ Trình duyệt (web)', () => {
  it('chưa cài bộ chạy: từng thành phần kèm dung lượng, nút cài bộ chạy và cài từng trình duyệt', () => {
    const html = view();
    expect(html).toContain('Trình duyệt (web)');
    expect(html).toContain('Node.js');
    expect(html).toContain('Chưa cài · 48 MB');
    expect(html).toContain('Cài bộ chạy');
    expect(html).toContain('Cài Chromium');
    expect(html).toContain('Cài Firefox');
    expect(html).toContain('Cài WebKit');
    expect(html).toContain('Microsoft Edge (có sẵn trên máy)');
    expect(html).toContain('Chưa có hồ sơ nào');
  });

  it('đang cài: tiến độ theo thành phần, nút cài tắt', () => {
    let progress = applyRuntimeEvent({}, { component: 'node', done: 24 * 1024 * 1024, total: 48 * 1024 * 1024, finished: false });
    progress = applyRuntimeEvent(progress, { component: 'chromium', done: 0, total: 170 * 1024 * 1024, finished: false });
    const html = view({ installing: true, progress });
    expect(html).toContain('data-testid="install-progress"');
    expect(html).toContain('50% · 24 MB/48 MB');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Cài Chromium/);
    expect(applyRuntimeEvent(progress, { done: 0, total: 0, finished: true })).toEqual({});
  });

  it('cài lỗi: câu theo mã của Go, chi tiết điền vào chỗ trống', () => {
    expect(installErrorText({ done: 0, total: 0, finished: true, code: 'web_sidecar_failed', error: 'web_sidecar_failed: hết thời gian' })).toBe(
      'Tiến trình điều khiển trình duyệt bị lỗi: hết thời gian. Thử lại; lỗi lặp lại thì khởi động lại app.',
    );
    expect(installErrorText({ done: 0, total: 0, finished: true, error: 'mạng lỗi' })).toBe('Cài không xong: mạng lỗi');
  });

  it('form mở sẵn: lỗi kiểm tra hiện ngay, wildcard trên hậu tố công cộng bị từ chối, nút lưu tắt', () => {
    const html = view({ initialDraft: { ...good, allowedHosts: ['*.vercel.app'] } });
    expect(html).toContain('data-testid="profile-form"');
    expect(html).toContain('wildcard trên hậu tố công cộng không được phép: *.vercel.app');
    expect(html).toMatch(/<button type="submit"[^>]*disabled/);
  });

  it('hồ sơ mới trên Windows chọn sẵn Edge; trên macOS chọn sẵn Chromium', () => {
    const win = view({ os: 'windows/amd64', initialDraft: { ...newProfile('windows/amd64'), id: 'web-a', name: 'A', baseURL: 'https://a.example.com' } });
    expect(win).toMatch(/<option value="msedge" selected="">/);
    const mac = view({ initialDraft: { ...newProfile('darwin/arm64'), id: 'web-a', name: 'A', baseURL: 'https://a.example.com' } });
    expect(mac).toMatch(/<option value="chromium" selected="">/);
  });

  it('danh sách hồ sơ: trình duyệt, kích thước, host và nút sửa, xoá', () => {
    const html = view({ status: { ...missing, node: { state: 'ready' }, modules: { state: 'ready' } }, profiles: [{ ...good, channel: 'msedge', headless: false }] });
    expect(html).toContain('web-staging · Microsoft Edge · 1280×800 · staging.example.com · mở cửa sổ');
    expect(html).toContain('Sửa');
    expect(html).toContain('Xoá');
    expect(html).not.toContain('Cài bộ chạy');
  });

  it('lỗi kiểm tra của Go hiện đúng câu của Go; mã khác theo danh mục lỗi', () => {
    expect(profileErrorText(goError(new Error('invalid: baseURL phải là http(s)://host[...] và không chứa tài khoản')))).toBe(
      'baseURL phải là http(s)://host[...] và không chứa tài khoản',
    );
    expect(profileErrorText(goError(new Error('permission_denied: cqs.devices')))).toBe(errorText(goError(new Error('permission_denied: cqs.devices'))));
  });
});

/** Giả window.go.tower.Service (Wails); trả danh sách lần gọi. */
function stubTower(service: Record<string, (...a: unknown[]) => unknown>) {
  const calls: unknown[][] = [];
  const wrapped = Object.fromEntries(
    Object.entries(service).map(([k, fn]) => [
      k,
      (...a: unknown[]) => {
        calls.push([k, ...a]);
        return fn(...a);
      },
    ]),
  );
  vi.stubGlobal('window', { go: { tower: { Service: wrapped } } });
  return calls;
}

describe('cầu nối hồ sơ và bộ chạy', () => {
  it('gọi đúng hàm Go: hồ sơ, lưu, xoá, bộ chạy, cài, thao tác web', async () => {
    const calls = stubTower({
      BrowserProfiles: async () => null,
      SaveBrowserProfile: async (p) => p,
      DeleteBrowserProfile: async () => undefined,
      WebRuntime: async () => missing,
      InstallWebRuntime: async () => undefined,
      WebAction: async () => ({ locator: '', url: '', tree: '', snapshotId: '' }),
    });
    expect(await towerApi.browserProfiles()).toEqual([]);
    expect(await towerApi.saveBrowserProfile(good)).toEqual(good);
    await towerApi.deleteBrowserProfile('web-staging');
    expect((await towerApi.webRuntime()).node.state).toBe('missing');
    await towerApi.installWebRuntime(['chromium']);
    await towerApi.webAction('web-staging', { kind: 'keys', text: 'abc' });
    expect(calls).toEqual([
      ['BrowserProfiles'],
      ['SaveBrowserProfile', good],
      ['DeleteBrowserProfile', 'web-staging'],
      ['WebRuntime'],
      ['InstallWebRuntime', ['chromium']],
      ['WebAction', 'web-staging', { kind: 'keys', text: 'abc' }],
    ]);
  });

  it('chưa cài bộ chạy hoặc đang chạy flow: lỗi Go thành câu tiếng Việt kèm chi tiết', async () => {
    stubTower({
      InstallWebRuntime: async () => {
        throw new Error('device_not_ready: đang có lượt chạy web');
      },
      WebRuntime: async () => {
        throw new Error('web_runtime_missing: bộ chạy trình duyệt chưa sẵn sàng');
      },
    });
    await expect(towerApi.installWebRuntime([])).rejects.toMatchObject({ code: 'device_not_ready' });
    const e = await towerApi.installWebRuntime([]).catch((x: unknown) => x);
    expect(errorText(e)).toBe('Thiết bị chưa sẵn sàng để chạy: đang có lượt chạy web.');
    const rt = await towerApi.webRuntime().catch((x: unknown) => x);
    expect(errorText(rt)).toContain('Chưa cài bộ chạy trình duyệt');
  });

  it('giành quyền máy web đang chạy flow: câu device_not_ready có lý do của Go', async () => {
    stubTower({
      TakeOver: async () => {
        throw new Error('device_not_ready: máy web đang chạy flow; giành quyền giữa lượt không hỗ trợ');
      },
    });
    const e = await towerApi.takeOver('web-staging').catch((x: unknown) => x);
    expect(errorText(e)).toBe('Thiết bị chưa sẵn sàng để chạy: máy web đang chạy flow; giành quyền giữa lượt không hỗ trợ.');
  });

  it('core cũ chưa có hàm hồ sơ trình duyệt: incompatible', async () => {
    stubTower({});
    await expect(towerApi.browserProfiles()).rejects.toMatchObject({ code: 'incompatible' });
  });
});
