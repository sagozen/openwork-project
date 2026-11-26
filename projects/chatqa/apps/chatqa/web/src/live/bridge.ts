// Cầu nối tới tháp ở Go cho danh sách máy, lưới màn hình trực tiếp và giành quyền điều khiển
// (window.go.tower.Service.*, window.go.tools.Service.Call). Kiểu dưới đây khớp JSON của pool.Device và live.Frame (Go).
import { ApiError } from '@shell/platform';
import { goFn } from '@shell/platform/desktop';
import { errorText, parseErrorCode, parseErrorParams } from '@shell/lib/errors';

export type DeviceState = 'connected' | 'preparing' | 'ready' | 'busy' | 'unhealthy' | 'disconnected';
/** Người dùng đang giữ máy: chờ bước hiện tại xong, giữ máy rảnh, hoặc lượt chạy tạm dừng. */
export type HoldState = '' | 'pending' | 'held' | 'paused';

export interface Device {
  id: string;
  platform: string;
  state: DeviceState;
  name?: string;
  model?: string;
  osVersion?: string;
  simulator?: boolean;
  battery?: number;
  driver?: string;
  warm?: boolean;
  held?: HoldState;
  problem?: string;
}

export interface LiveFrame {
  deviceId: string;
  seq: number;
  mode: 'idle' | 'busy' | 'held' | 'cold' | '';
  width: number;
  height: number;
  jpeg: string;
  grabMs: number;
  error?: string;
}

export interface Takeover {
  deviceId: string;
  paused: boolean;
}

export interface ToolResult {
  kind: string;
  data: unknown;
}

/**
 * Lỗi Go "mã: chi tiết" thành ApiError. Chi tiết dạng "k=v,k=v" thành tham số; chi tiết là câu thường (vd "máy web đang chạy
 * flow; ...") giữ ở tham số {chi tiết} để câu của contracts/errors.json điền được.
 */
export function goError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const msg = String(e instanceof Error ? e.message : e);
  const params = parseErrorParams(msg);
  const detail = /^\s*[a-z][a-z0-9_]*\s*:\s*(.*)$/s.exec(msg)?.[1]?.trim() ?? '';
  if (detail && Object.keys(params).length === 0) params['chi tiết'] = detail;
  return new ApiError(parseErrorCode(msg), 0, params);
}

/** Gọi một hàm Go đã bind (vd 'tower.Service.Fleet'); lỗi "mã: chi tiết" thành ApiError. Core cũ chưa có hàm: "incompatible". */
export async function goCall<T>(path: string, ...args: unknown[]): Promise<T> {
  try {
    return (await goFn(path)(...args)) as T;
  } catch (e) {
    throw goError(e);
  }
}

/** Hồ sơ trình duyệt (pw.Profile): một hồ sơ là một thiết bị web trong danh sách máy (mã web-...). */
export interface BrowserProfile {
  id: string;
  name: string;
  /** chromium | firefox | webkit */
  browser: string;
  /** "" (chromium tải về) | msedge | chrome (trình duyệt có sẵn trên máy, chỉ với chromium). */
  channel: string;
  width: number;
  height: number;
  baseURL: string;
  /** false = mở cửa sổ trình duyệt khi chạy. */
  headless: boolean;
  /** Tên host hoặc *.tên-miền; host của baseURL luôn được phép. */
  allowedHosts: string[];
  testIdAttribute: string;
}

/** Trạng thái một thành phần của bộ chạy: missing | installing | ready | unsupported. size = số byte cần tải khi chưa cài. */
export interface RuntimeComponent {
  state: string;
  version?: string;
  size?: number;
}

/** Bộ chạy trình duyệt trên máy này (pw.Status). */
export interface WebRuntimeStatus {
  /** "<goos>/<goarch>", vd darwin/arm64, windows/amd64. */
  platform: string;
  node: RuntimeComponent;
  modules: RuntimeComponent;
  browsers: (RuntimeComponent & { name: string })[] | null;
  channels: { name: string; installed: boolean }[] | null;
}

/** Sự kiện "web:runtime": tiến độ cài từng thành phần; finished = lượt cài xong (error trống là thành công). */
export interface WebRuntimeEvent {
  /** node | modules | chromium | ffmpeg | firefox | webkit */
  component?: string;
  done: number;
  total: number;
  finished: boolean;
  code?: string;
  error?: string;
}

/** Thao tác trên trang của thiết bị web (testengine.WebAction). Bàn phím khi giành quyền dùng kind keys: text hoặc key. */
export interface WebAction {
  kind: 'navigate' | 'back' | 'click' | 'fill' | 'press' | 'select' | 'wait' | 'keys';
  text?: string;
  /** Tên phím Playwright: Enter, Tab, Backspace, ArrowUp, Shift+Tab... */
  key?: string;
  url?: string;
  ref?: string;
  snapshotId?: string;
  locator?: string;
}

export interface WebResult {
  locator: string;
  url: string;
  tree: string;
  snapshotId: string;
}

export const towerApi = {
  fleet: () => goCall<Device[] | null>('tower.Service.Fleet').then((r) => r ?? []),
  /** Máy đang hiện trên lưới và máy đang phóng to; ids rỗng = đóng lưới. */
  liveWatch: (ids: string[], focus: string) => goCall<void>('tower.Service.LiveWatch', ids, focus),
  takeOver: (id: string) => goCall<Takeover>('tower.Service.TakeOver', id),
  handBack: (id: string) => goCall<boolean>('tower.Service.HandBack', id),
  /** Apple Team ID để ký agent trên iPhone thật; "" = chưa nhập. */
  teamId: () => goCall<string>('tower.Service.TeamID'),
  setTeamId: (team: string) => goCall<void>('tower.Service.SetTeamID', team),
  /** Hồ sơ trình duyệt đã lưu (thiết bị web). */
  browserProfiles: () => goCall<BrowserProfile[] | null>('tower.Service.BrowserProfiles').then((r) => r ?? []),
  /** Thêm hoặc sửa hồ sơ; Go kiểm và trả hồ sơ đã chuẩn hoá, danh sách máy cập nhật ngay. */
  saveBrowserProfile: (p: BrowserProfile) => goCall<BrowserProfile>('tower.Service.SaveBrowserProfile', p),
  /** Xoá hồ sơ; lượt đang chạy trên hồ sơ bị huỷ và lệnh trả về ngay. */
  deleteBrowserProfile: (id: string) => goCall<void>('tower.Service.DeleteBrowserProfile', id),
  webRuntime: () => goCall<WebRuntimeStatus>('tower.Service.WebRuntime'),
  /** Cài Node + Playwright và các trình duyệt tải về (chromium | firefox | webkit) ở nền; tiến độ qua "web:runtime". */
  installWebRuntime: (browsers: string[]) => goCall<void>('tower.Service.InstallWebRuntime', browsers),
  /** Thao tác trên trang của máy web đang giữ (bàn phím khi giành quyền). Go không ghi chữ gõ vào nhật ký. */
  webAction: (id: string, a: WebAction) => goCall<WebResult>('tower.Service.WebAction', id, a),
};

/** Màn Cài đặt › Kiểm thử, nơi có thẻ Trình duyệt (web): cài bộ chạy, quản lý hồ sơ. */
export const TEST_SETTINGS_PATH = '/cai-dat/kiem-thu';

export const isWebDevice = (d: { platform: string }) => d.platform === 'web';

/** Tên hiện của máy: hồ sơ trình duyệt theo tên hồ sơ (model của nó là "trình duyệt WxH"), điện thoại theo model. */
export const deviceName = (d: { id: string; platform: string; name?: string; model?: string }) =>
  (isWebDevice(d) ? d.name || d.model : d.model || d.name) || d.id;

/** Host của một URL ("" nếu không phải URL). */
export function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Dòng phụ của máy web: trình duyệt · WxH · host(baseURL). Model do Go ghép dạng "msedge 1280x800 [headless]". */
export function webSubtitle(d: { model?: string }, baseURL?: string): string {
  const [browser = '', size = ''] = (d.model ?? '').split(' ');
  return [browser, size, hostOf(baseURL)].filter(Boolean).join(' · ');
}

const BROWSER_LABEL: Record<string, string> = { msedge: 'Microsoft Edge', chrome: 'Google Chrome', chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };

/** Tên dễ đọc của trình duyệt/kênh. */
export const browserLabel = (name: string) => BROWSER_LABEL[name] ?? name;

/** Vấn đề của máy web cần làm ở Cài đặt: chưa cài bộ chạy, hoặc chưa có Edge/Chrome trên máy. */
export const isWebSetupProblem = (d: { platform: string; problem?: string }) =>
  isWebDevice(d) && (d.problem === 'web_runtime_missing' || d.problem === 'device_tool_missing');

/** Câu báo vấn đề của máy web (Go đặt mã lỗi làm problem); mã khác giữ nguyên. */
export function webProblemText(d: { model?: string; problem?: string }): string {
  if (!d.problem || !/^[a-z][a-z0-9_]*$/.test(d.problem)) return d.problem ?? '';
  const browser = (d.model ?? '').split(' ')[0];
  return errorText(new ApiError(d.problem, 0, { 'công cụ': browserLabel(browser) }));
}

/** Gọi tool qua danh mục chung (cùng đường với chat và MCP: quyền, nhật ký như nhau). */
export const callTool = (name: string, args: Record<string, unknown>) => goCall<ToolResult>('tools.Service.Call', name, JSON.stringify(args));

/** Nghe một sự kiện Go (Wails runtime); trả hàm huỷ nghe. Ngoài desktop không làm gì. */
export function onGoEvent<T>(name: string, cb: (data: T) => void): () => void {
  const rt = (window as unknown as { runtime?: { EventsOn: (n: string, cb: (d: unknown) => void) => unknown; EventsOff: (n: string) => void } }).runtime;
  if (!rt) return () => undefined;
  const off = rt.EventsOn(name, (d) => cb(d as T));
  return typeof off === 'function' ? (off as () => void) : () => rt.EventsOff(name);
}

/** Nghe tiến độ cài bộ chạy trình duyệt ("web:runtime"); trả hàm huỷ nghe. */
export const onWebRuntime = (cb: (ev: WebRuntimeEvent) => void) => onGoEvent<WebRuntimeEvent>('web:runtime', cb);
