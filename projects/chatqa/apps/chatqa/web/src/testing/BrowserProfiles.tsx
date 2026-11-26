// Cài đặt › Kiểm thử › Trình duyệt (web): bộ chạy trình duyệt (Node + Playwright + trình duyệt tải về, cài một lần từ app) và hồ
// sơ trình duyệt. Mỗi hồ sơ là một thiết bị web trong danh sách máy. Kiểm tra ở đây khớp pw.Profile.Validate (Go); Go vẫn kiểm lại.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Download, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button, Input, Toggle } from '@shell/components/ui';
import { useToast } from '@shell/components/overlays/ToastHost';
import { errorText } from '@shell/lib/session';
import { Card, Muted } from '../chat/components/shared';
import { browserLabel, hostOf, onWebRuntime, towerApi, type BrowserProfile, type WebRuntimeEvent, type WebRuntimeStatus } from '../live/bridge';

/** Thuộc tính getByTestId mặc định (pw.DefaultTestIDAttribute). */
export const DEFAULT_TEST_ID = 'data-testid';

/** Lựa chọn trình duyệt: chromium/firefox/webkit tải về, msedge/chrome là trình duyệt có sẵn trên máy (channel của chromium). */
export type BrowserKey = 'chromium' | 'msedge' | 'chrome' | 'firefox' | 'webkit';

export const BROWSER_OPTIONS: { key: BrowserKey; browser: string; channel: string; label: string }[] = [
  { key: 'chromium', browser: 'chromium', channel: '', label: 'Chromium (tải về)' },
  { key: 'msedge', browser: 'chromium', channel: 'msedge', label: 'Microsoft Edge (có sẵn trên máy)' },
  { key: 'chrome', browser: 'chromium', channel: 'chrome', label: 'Google Chrome (có sẵn trên máy)' },
  { key: 'firefox', browser: 'firefox', channel: '', label: 'Firefox (tải về thêm)' },
  { key: 'webkit', browser: 'webkit', channel: '', label: 'WebKit (tải về thêm)' },
];

export const browserKeyOf = (p: Pick<BrowserProfile, 'browser' | 'channel'>): BrowserKey => (p.channel || p.browser) as BrowserKey;

/** Trình duyệt mặc định theo hệ điều hành: Edge có sẵn trên Windows 11, Chromium tải về trên macOS. os: "windows/amd64" hoặc navigator.platform. */
export const defaultBrowserKey = (os: string): BrowserKey => (/^win/i.test(os) ? 'msedge' : 'chromium');

export const viewportPresets = [
  { key: '1280x800', label: 'Máy tính 1280×800', width: 1280, height: 800 },
  { key: '1440x900', label: 'Laptop 1440×900', width: 1440, height: 900 },
  { key: '1920x1080', label: 'Full HD 1920×1080', width: 1920, height: 1080 },
  { key: '768x1024', label: 'Máy tính bảng 768×1024', width: 768, height: 1024 },
  { key: '390x844', label: 'Điện thoại 390×844', width: 390, height: 844 },
] as const;

const CUSTOM = 'custom';
const presetOf = (w: number, h: number) => viewportPresets.find((v) => v.width === w && v.height === h)?.key ?? CUSTOM;

const ID_RE = /^web-[a-z0-9-]{1,40}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TEST_ID_RE = /^[A-Za-z_][A-Za-z0-9_:.-]{0,63}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Hậu tố công cộng hay gặp (Public Suffix List): *.<hậu tố> mở cửa cho mọi người dùng của dịch vụ đó. Danh sách rút gọn để báo
 * lỗi sớm; Go kiểm bằng danh sách đầy đủ.
 */
const PUBLIC_SUFFIXES = new Set([
  'vercel.app', 'netlify.app', 'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com',
  'herokuapp.com', 'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net', 'amazonaws.com', 's3.amazonaws.com', 'onrender.com',
  'fly.dev', 'up.railway.app', 'surge.sh', 'glitch.me', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'blogspot.com', 'loca.lt',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.kr',
  'com.br', 'com.cn', 'com.sg', 'com.my', 'com.hk', 'com.tw', 'co.nz', 'co.in', 'co.za', 'co.th', 'co.id',
]);

/** Chuẩn hoá host như Go: bỏ khoảng trắng, chữ thường, bỏ dấu chấm cuối. */
const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, '');

/** Lỗi của một host đã chuẩn hoá (khớp validHost của Go), "" nếu hợp lệ: tên host, IPv4, hoặc *.tên-miền-đăng-ký-được. */
export function hostError(h: string): string {
  if (IPV4_RE.test(h)) return '';
  const wild = h.startsWith('*.');
  const domain = wild ? h.slice(2) : h;
  if (domain.length > 253 || domain.includes('*') || !domain.split('.').every((l) => LABEL_RE.test(l))) return `host không hợp lệ: ${h}`;
  if (wild) {
    if (!domain.includes('.')) return `wildcard phải trên một tên miền cụ thể: ${h}`;
    if (PUBLIC_SUFFIXES.has(domain)) return `wildcard trên hậu tố công cộng không được phép: ${h}`;
  }
  return '';
}

/** Chữ người dùng gõ vào ô host -> một host hợp lệ (dán cả URL cũng được), hoặc câu lỗi. */
export function hostChip(raw: string): { host: string } | { error: string } {
  let h = raw.trim();
  if (h.includes('://')) {
    try {
      h = new URL(h).hostname;
    } catch {
      return { error: `host không hợp lệ: ${raw.trim()}` };
    }
  }
  h = normHost(h);
  if (!h) return { error: 'nhập tên host, vd app.example.com hoặc *.example.com' };
  const error = hostError(h);
  return error ? { error } : { host: h };
}

/** Kiểm hồ sơ như pw.Profile.Validate (cùng câu báo lỗi); trả "" nếu hợp lệ. */
export function validProfile(p: BrowserProfile): string {
  if (!ID_RE.test(p.id.trim())) return 'mã hồ sơ phải có dạng web-<chữ thường, số, gạch ngang> (tối đa 40 ký tự)';
  const name = p.name.trim();
  if (!name || [...name].length > 80) return 'tên hồ sơ trống hoặc dài quá 80 ký tự';
  if (!['chromium', 'firefox', 'webkit'].includes(p.browser)) return 'trình duyệt phải là chromium, firefox hoặc webkit';
  if (p.channel === 'msedge' || p.channel === 'chrome') {
    if (p.browser !== 'chromium') return `kênh ${p.channel} chỉ dùng với chromium`;
  } else if (p.channel !== '') return 'kênh trình duyệt phải trống, msedge hoặc chrome';
  const { width: w, height: h } = p;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 320 || w > 3840 || h < 240 || h > 2160) return 'viewport phải trong 320..3840 x 240..2160';
  let url: URL | undefined;
  try {
    url = new URL(p.baseURL.trim());
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) {
    return 'baseURL phải là http(s)://host[...] và không chứa tài khoản';
  }
  for (const raw of p.allowedHosts) {
    const host = normHost(raw);
    const err = host ? hostError(host) : '';
    if (err) return err;
  }
  if (!TEST_ID_RE.test(p.testIdAttribute.trim() || DEFAULT_TEST_ID)) return 'thuộc tính test id không hợp lệ';
  return '';
}

/** Hồ sơ gửi Go: bỏ khoảng trắng, host chuẩn hoá và không trùng, test id mặc định. */
export function normalizeProfile(p: BrowserProfile): BrowserProfile {
  return {
    ...p,
    id: p.id.trim(),
    name: p.name.trim(),
    baseURL: p.baseURL.trim(),
    allowedHosts: [...new Set(p.allowedHosts.map(normHost).filter(Boolean))],
    testIdAttribute: p.testIdAttribute.trim() || DEFAULT_TEST_ID,
  };
}

/** Mã hồ sơ từ tên (bỏ dấu tiếng Việt): "Staging Đơn hàng" -> web-staging-don-hang; trùng mã có sẵn thì thêm -2, -3... */
export function profileIdFrom(name: string, taken: string[]): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/, '');
  const base = `web-${slug || 'trinh-duyet'}`;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Hồ sơ mới: trình duyệt mặc định theo hệ điều hành, 1280×800, chạy ẩn (không mở cửa sổ). */
export function newProfile(os: string): BrowserProfile {
  const opt = BROWSER_OPTIONS.find((o) => o.key === defaultBrowserKey(os)) ?? BROWSER_OPTIONS[0];
  return { id: '', name: '', browser: opt.browser, channel: opt.channel, width: 1280, height: 800, baseURL: '', headless: true, allowedHosts: [], testIdAttribute: DEFAULT_TEST_ID };
}

/** Tiến độ cài theo thành phần (node, modules, chromium, ffmpeg, firefox, webkit). */
export type RuntimeProgress = Record<string, { done: number; total: number }>;

/** Cập nhật tiến độ theo một sự kiện "web:runtime"; lượt cài xong thì xoá hết. */
export function applyRuntimeEvent(prev: RuntimeProgress, ev: WebRuntimeEvent): RuntimeProgress {
  if (ev.finished) return {};
  if (!ev.component) return prev;
  return { ...prev, [ev.component]: { done: ev.done, total: ev.total } };
}

/** Câu báo lỗi khi lượt cài kết thúc lỗi (mã của Go qua contracts/errors.json, chi tiết điền vào {chi tiết}). */
export function installErrorText(ev: WebRuntimeEvent): string {
  if (!ev.code) return ev.error ? `Cài không xong: ${ev.error}` : 'Cài không xong.';
  const detail = (ev.error ?? '').replace(/^\s*[a-z][a-z0-9_]*\s*:\s*/, '');
  return errorText({ code: ev.code, params: { 'chi tiết': detail } });
}

const MB = 1024 * 1024;
export const fmtSize = (bytes?: number) => (bytes && bytes > 0 ? `${Math.max(1, Math.round(bytes / MB))} MB` : '');

const STATE_LABEL: Record<string, string> = { missing: 'Chưa cài', installing: 'Đang cài', ready: 'Đã cài', unsupported: 'Không hỗ trợ trên máy này' };
const COMPONENT_LABEL: Record<string, string> = { node: 'Node.js', modules: 'Playwright + TypeScript', ffmpeg: 'ffmpeg (video của Chromium)' };
const componentLabel = (c: string) => COMPONENT_LABEL[c] ?? browserLabel(c);

function StatusRow({ label, state, size, version, action }: { label: string; state: string; size?: number; version?: string; action?: ReactNode }) {
  const missing = state === 'missing';
  return (
    <li className="flex items-center gap-[10px] border-t border-divider py-[6px] first:border-t-0" data-testid="runtime-row">
      <span className="min-w-0 flex-1 truncate text-[12.5px]/[16px] text-text">
        {label}
        {version ? <span className="font-mono text-[11px] text-text-3"> {version}</span> : null}
      </span>
      <span className={missing ? 'text-[11.5px]/[15px] text-amber' : 'text-[11.5px]/[15px] text-text-3'}>
        {STATE_LABEL[state] ?? state}
        {missing && size ? ` · ${fmtSize(size)}` : ''}
      </span>
      {action}
    </li>
  );
}

export interface BrowserProfilesViewProps {
  status: WebRuntimeStatus | null;
  /** Lỗi đọc bộ chạy (đã thành câu). */
  statusError?: string;
  progress: RuntimeProgress;
  /** Đang có lượt cài (bấm cài đến khi Go báo xong). */
  installing: boolean;
  profiles: BrowserProfile[];
  /** Hệ điều hành để chọn trình duyệt mặc định: status.platform hoặc navigator.platform. */
  os: string;
  busy?: boolean;
  onInstall: (browsers: string[]) => void;
  /** Lưu hồ sơ; trả câu lỗi của Go ("" khi đã lưu). */
  onSave: (p: BrowserProfile) => Promise<string>;
  onDelete: (p: BrowserProfile) => void;
  /** Mở sẵn form với hồ sơ này (test, hoặc sửa từ nơi khác). */
  initialDraft?: BrowserProfile;
}

/** Thẻ Trình duyệt (web), thuần theo dữ liệu (test độc lập). */
export function BrowserProfilesView({ status, statusError, progress, installing, profiles, os, busy, onInstall, onSave, onDelete, initialDraft }: BrowserProfilesViewProps) {
  const [draft, setDraft] = useState<BrowserProfile | null>(initialDraft ?? null);
  const [editing, setEditing] = useState(false);
  const [pristine, setPristine] = useState(!initialDraft);
  const [idTouched, setIdTouched] = useState(false);
  const [hostInput, setHostInput] = useState('');
  const [hostErr, setHostErr] = useState('');
  const [serverErr, setServerErr] = useState('');
  const [preset, setPreset] = useState<string>(initialDraft ? presetOf(initialDraft.width, initialDraft.height) : viewportPresets[0].key);

  const open = (p: BrowserProfile | null, edit: boolean) => {
    setDraft(p);
    setEditing(edit);
    setPristine(true);
    setIdTouched(edit);
    setHostInput('');
    setHostErr('');
    setServerErr('');
    if (p) setPreset(presetOf(p.width, p.height));
  };
  const change = (patch: Partial<BrowserProfile>) => {
    setPristine(false);
    setServerErr('');
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, ...patch };
      if (!editing && !idTouched && patch.name !== undefined) next.id = profileIdFrom(patch.name, profiles.map((x) => x.id));
      return next;
    });
  };
  const addHost = () => {
    if (!draft || !hostInput.trim()) return;
    const r = hostChip(hostInput);
    if ('error' in r) {
      setHostErr(r.error);
      return;
    }
    setHostErr('');
    setHostInput('');
    if (!draft.allowedHosts.includes(r.host)) change({ allowedHosts: [...draft.allowedHosts, r.host] });
  };
  const clientErr = draft && !pristine ? validProfile(draft) : '';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setPristine(false);
    if (validProfile(draft) || hostErr) return;
    const err = await onSave(normalizeProfile(draft));
    if (err) setServerErr(err);
    else open(null, false);
  };

  const rt = status;
  const runtimeMissing = !!rt && (rt.node.state === 'missing' || rt.modules.state === 'missing');
  const canInstall = !installing && !busy;
  const active = Object.entries(progress);

  return (
    <Card
      title="Trình duyệt (web)"
      aside={
        !draft && (
          <Button size="xs" variant="secondary" icon={<Plus size={13} />} onClick={() => open(newProfile(os), false)}>
            Thêm hồ sơ
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-[10px]" data-testid="browser-profiles">
        <Muted>
          Mỗi hồ sơ trình duyệt là một máy web trong danh sách máy: chạy flow .spec.ts, xem trực tiếp và điều khiển như điện thoại. Bộ chạy
          (Node, Playwright, trình duyệt) tải về một lần, kiểm mã băm SHA-256, lưu trên máy này.
        </Muted>
        <Muted>
          Nguồn mở: Playwright và TypeScript (Microsoft, Apache-2.0), Node.js (OpenJS Foundation, MIT); giấy phép đi kèm bộ chạy trên máy.
          Trình duyệt tải thẳng từ máy chủ phát hành của Playwright và Google, ChatQASoftware không phân phối lại.
        </Muted>

        {statusError ? (
          <p className="text-[11.5px]/[15px] text-red">{statusError}</p>
        ) : !rt ? (
          <Muted>Đang đọc bộ chạy…</Muted>
        ) : (
          <ul data-testid="web-runtime">
            <StatusRow label="Node.js" state={rt.node.state} size={rt.node.size} version={rt.node.version} />
            <StatusRow
              label="Playwright + TypeScript"
              state={rt.modules.state}
              size={rt.modules.size}
              version={rt.modules.version}
              action={
                runtimeMissing && (
                  <Button size="xs" disabled={!canInstall} icon={<Download size={13} />} onClick={() => onInstall([])}>
                    Cài bộ chạy
                  </Button>
                )
              }
            />
            {(rt.browsers ?? []).map((b) => (
              <StatusRow
                key={b.name}
                label={browserLabel(b.name)}
                state={b.state}
                size={b.size}
                action={
                  b.state === 'missing' && (
                    <Button size="xs" variant="secondary" disabled={!canInstall} icon={<Download size={13} />} onClick={() => onInstall([b.name])}>
                      Cài {browserLabel(b.name)}
                    </Button>
                  )
                }
              />
            ))}
            {(rt.channels ?? []).map((c) => (
              <StatusRow key={c.name} label={`${browserLabel(c.name)} (có sẵn trên máy)`} state={c.installed ? 'ready' : 'missing'} />
            ))}
          </ul>
        )}
        {(installing || active.length > 0) && (
          <div className="flex flex-col gap-[4px]" data-testid="install-progress" aria-live="polite">
            {active.length === 0 ? (
              <Muted>Đang chuẩn bị cài…</Muted>
            ) : (
              active.map(([c, p]) => {
                const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
                return (
                  <div key={c} className="flex items-center gap-[8px] text-[11.5px]/[15px] text-text-2">
                    <span className="w-[160px] shrink-0 truncate">{componentLabel(c)}</span>
                    <span className="h-[6px] min-w-0 flex-1 overflow-hidden rounded-full bg-chip-neutral">
                      <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="w-[150px] shrink-0 text-right font-mono whitespace-nowrap">
                      {pct}%{p.total > 0 ? ` · ${fmtSize(p.done) || '0 MB'}/${fmtSize(p.total)}` : ''}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}

        {profiles.length === 0 && !draft ? (
          <p className="text-[11.5px]/[15px] text-text-3">Chưa có hồ sơ nào.</p>
        ) : (
          <ul className="flex flex-col" data-testid="profile-list">
            {profiles.map((p) => (
              <li key={p.id} className="flex items-center gap-[10px] border-t border-divider py-[6px] first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px]/[16px] font-semibold text-text">{p.name}</p>
                  <p className="truncate font-mono text-[11px]/[14px] text-text-3">
                    {p.id} · {browserLabel(browserKeyOf(p))} · {p.width}×{p.height} · {hostOf(p.baseURL) || p.baseURL}
                    {p.headless ? '' : ' · mở cửa sổ'}
                  </p>
                </div>
                <Button size="xs" variant="secondary" disabled={busy} icon={<Pencil size={13} />} onClick={() => open({ ...p, allowedHosts: p.allowedHosts ?? [] }, true)}>
                  Sửa
                </Button>
                <Button size="xs" variant="secondary" disabled={busy} icon={<Trash2 size={13} />} onClick={() => onDelete(p)}>
                  Xoá
                </Button>
              </li>
            ))}
          </ul>
        )}

        {draft && (
          <form className="flex flex-col gap-[10px] rounded-[8px] bg-muted-box p-[10px]" data-testid="profile-form" onSubmit={(e) => void submit(e)}>
            <div className="flex gap-[10px]">
              <Input label="Tên hồ sơ" placeholder="Staging" maxLength={80} value={draft.name} onChange={(e) => change({ name: e.target.value })} />
              <Input
                label="Mã"
                mono
                maxLength={44}
                disabled={editing}
                value={draft.id}
                onChange={(e) => {
                  setIdTouched(true);
                  change({ id: e.target.value });
                }}
              />
            </div>
            <div className="flex gap-[10px]">
              <label className="flex w-full flex-col gap-[6px] leading-[normal]">
                <span className="text-[12px]/[15px] font-semibold text-text-2">Trình duyệt</span>
                <select
                  aria-label="Trình duyệt"
                  className="stroke-in h-[40px] rounded-[8px] bg-surface px-[12px] text-[13px]/[16px] text-text"
                  value={browserKeyOf(draft)}
                  onChange={(e) => {
                    const o = BROWSER_OPTIONS.find((x) => x.key === e.target.value) ?? BROWSER_OPTIONS[0];
                    change({ browser: o.browser, channel: o.channel });
                  }}
                >
                  {BROWSER_OPTIONS.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex w-full flex-col gap-[6px] leading-[normal]">
                <span className="text-[12px]/[15px] font-semibold text-text-2">Kích thước (viewport)</span>
                <select
                  aria-label="Kích thước"
                  className="stroke-in h-[40px] rounded-[8px] bg-surface px-[12px] text-[13px]/[16px] text-text"
                  value={preset}
                  onChange={(e) => {
                    setPreset(e.target.value);
                    const v = viewportPresets.find((x) => x.key === e.target.value);
                    if (v) change({ width: v.width, height: v.height });
                  }}
                >
                  {viewportPresets.map((v) => (
                    <option key={v.key} value={v.key}>
                      {v.label}
                    </option>
                  ))}
                  <option value={CUSTOM}>Tuỳ chỉnh</option>
                </select>
              </label>
            </div>
            {preset === CUSTOM && (
              <div className="flex gap-[10px]">
                <Input label="Rộng (px)" type="number" min={320} max={3840} value={draft.width || ''} onChange={(e) => change({ width: Number(e.target.value) })} />
                <Input label="Cao (px)" type="number" min={240} max={2160} value={draft.height || ''} onChange={(e) => change({ height: Number(e.target.value) })} />
              </div>
            )}
            <Input label="Địa chỉ gốc (baseURL)" mono placeholder="https://staging.example.com" value={draft.baseURL} onChange={(e) => change({ baseURL: e.target.value })} />
            <div className="flex flex-col gap-[6px]">
              <span className="text-[12px]/[15px] font-semibold text-text-2">Host được phép (ngoài host của baseURL)</span>
              {draft.allowedHosts.length > 0 && (
                <ul className="flex flex-wrap gap-[6px]" data-testid="host-chips">
                  {draft.allowedHosts.map((h) => (
                    <li key={h} className="flex items-center gap-[4px] rounded-[6px] bg-surface px-[7px] py-[2px] font-mono text-[11.5px]/[16px] text-text-2">
                      {h}
                      <button type="button" aria-label={`Bỏ ${h}`} className="text-text-3 hover:text-text" onClick={() => change({ allowedHosts: draft.allowedHosts.filter((x) => x !== h) })}>
                        <X size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-end gap-[10px]">
                <Input
                  aria-label="Thêm host"
                  mono
                  placeholder="api.example.com hoặc *.example.com"
                  value={hostInput}
                  invalid={!!hostErr}
                  onChange={(e) => {
                    setHostInput(e.target.value);
                    setHostErr('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addHost();
                    }
                  }}
                />
                <Button type="button" variant="secondary" onClick={addHost} disabled={!hostInput.trim()}>
                  Thêm
                </Button>
              </div>
              {hostErr && <p className="text-[11.5px]/[15px] text-red">{hostErr}</p>}
            </div>
            <div className="flex items-end gap-[10px]">
              <Input label="Thuộc tính test id" mono placeholder={DEFAULT_TEST_ID} value={draft.testIdAttribute} onChange={(e) => change({ testIdAttribute: e.target.value })} />
              <label className="flex h-[40px] shrink-0 items-center gap-[8px] text-[12.5px]/[16px] text-text-2">
                <Toggle size="setting" slot={false} checked={!draft.headless} onChange={(on) => change({ headless: !on })} label="Mở cửa sổ trình duyệt" />
                Mở cửa sổ trình duyệt
              </label>
            </div>
            {(clientErr || serverErr) && (
              <p className="text-[11.5px]/[15px] text-red" data-testid="profile-error">
                {clientErr || serverErr}
              </p>
            )}
            <div className="flex gap-[10px]">
              <Button type="submit" disabled={busy || !!clientErr}>
                {editing ? 'Lưu hồ sơ' : 'Thêm hồ sơ'}
              </Button>
              <Button type="button" variant="secondary" onClick={() => open(null, false)}>
                Huỷ
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

/** Lỗi của Go khi lưu hồ sơ: lỗi kiểm tra (invalid) hiện đúng câu của Go, mã khác theo contracts/errors.json. */
export function profileErrorText(e: unknown): string {
  const err = e as { code?: string; params?: Record<string, string | number> } | null;
  const detail = err?.params?.['chi tiết'];
  return err?.code === 'invalid' && detail ? String(detail) : errorText(e);
}

/** Thẻ nối với Go: đọc bộ chạy và hồ sơ, cài theo sự kiện "web:runtime", lưu/xoá hồ sơ. */
export function BrowserProfilesCard() {
  const { show } = useToast();
  const [status, setStatus] = useState<WebRuntimeStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [progress, setProgress] = useState<RuntimeProgress>({});
  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const s = await towerApi.webRuntime();
      setStatus(s);
      setStatusError('');
      const states = [s.node, s.modules, ...(s.browsers ?? [])].map((c) => c.state);
      if (states.includes('installing')) setInstalling(true);
    } catch (e) {
      setStatusError(errorText(e));
    }
  }, []);
  const loadProfiles = useCallback(async () => {
    try {
      setProfiles(await towerApi.browserProfiles());
    } catch (e) {
      show(errorText(e));
    }
  }, [show]);
  useEffect(() => {
    void loadStatus();
    void loadProfiles();
    return onWebRuntime((ev) => {
      setProgress((p) => applyRuntimeEvent(p, ev));
      if (!ev.finished) return;
      setInstalling(false);
      show(ev.code || ev.error ? installErrorText(ev) : 'Đã cài xong bộ chạy trình duyệt.');
      void loadStatus();
    });
  }, [loadStatus, loadProfiles, show]);

  const install = async (browsers: string[]) => {
    setInstalling(true);
    setProgress({});
    try {
      await towerApi.installWebRuntime(browsers);
    } catch (e) {
      setInstalling(false);
      show(errorText(e));
    }
  };
  const save = async (p: BrowserProfile): Promise<string> => {
    setBusy(true);
    try {
      const saved = await towerApi.saveBrowserProfile(p);
      show(`Đã lưu hồ sơ ${saved.name}.`);
      await loadProfiles();
      return '';
    } catch (e) {
      return profileErrorText(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (p: BrowserProfile) => {
    if (!window.confirm(`Xoá hồ sơ ${p.name}? Lượt đang chạy trên hồ sơ này bị huỷ ngay.`)) return;
    setBusy(true);
    try {
      await towerApi.deleteBrowserProfile(p.id);
      show(`Đã xoá hồ sơ ${p.name}.`);
      await loadProfiles();
    } catch (e) {
      show(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const os = status?.platform || (typeof navigator === 'undefined' ? '' : navigator.platform);
  return (
    <BrowserProfilesView
      status={status}
      statusError={statusError}
      progress={progress}
      installing={installing}
      profiles={profiles}
      os={os}
      busy={busy}
      onInstall={(b) => void install(b)}
      onSave={save}
      onDelete={(p) => void remove(p)}
    />
  );
}
