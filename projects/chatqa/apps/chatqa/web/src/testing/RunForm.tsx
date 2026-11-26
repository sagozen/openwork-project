// Chạy tay một bộ flow từ màn Kiểm thử: chọn app, flow, nền tảng, biến bí mật, số máy, số lần và mức ảnh evidence theo bước.
// Lệnh đi qua tháp (tower.Service.Dispatch) như chat và MCP: tháp chọn máy rảnh, kiểm biến rồi chạy nền.
import { useEffect, useState } from 'react';
import { Play, Sparkles, X } from 'lucide-react';
import { Button, Checkbox, Input, Segmented, type SegmentOption } from '@shell/components/ui';
import { errorText } from '@shell/lib/session';
import { useToast } from '@shell/components/overlays/ToastHost';
import { FlowList } from '../chat/components/cards';
import { Card, Muted } from '../chat/components/shared';
import { deviceName, towerApi, type Device } from '../live/bridge';
import { isSpecFlow, testApi, type ArtifactsMode, type CompileRequest, type CompileResult, type DispatchRequest, type FlowInfo } from './bridge';

/** Chạy tay mặc định chụp mọi bước (để xem lại từng bước); chat/MCP/lịch giám sát giữ "chỉ khi lỗi". */
export const ARTIFACT_OPTIONS: SegmentOption<ArtifactsMode>[] = [
  { key: 'always', label: 'Mọi bước' },
  { key: 'on-failure', label: 'Chỉ khi lỗi' },
  { key: 'never', label: 'Không chụp' },
];

export const ARTIFACT_LABEL: Record<ArtifactsMode, string> = { always: 'mọi bước', 'on-failure': 'chỉ khi lỗi', never: 'không chụp' };

/** Nền tảng máy được chọn (filter.platform của tower.DispatchRequest); "" = mọi máy rảnh. */
export type RunPlatform = '' | 'android' | 'ios' | 'web';

export const PLATFORM_OPTIONS: SegmentOption<RunPlatform>[] = [
  { key: '', label: 'Tất cả' },
  { key: 'android', label: 'Android' },
  { key: 'ios', label: 'iOS' },
  { key: 'web', label: 'Web' },
];

/** Nền tảng mặc định theo flow đã chọn: chỉ chọn flow .spec.ts thì chạy trên trình duyệt (Web), còn lại mọi máy. */
export const defaultPlatform = (flows: string[]): RunPlatform => (flows.length > 0 && flows.every(isSpecFlow) ? 'web' : '');

/** Nhãn "web" cạnh tên flow .spec.ts. */
export function WebBadge() {
  return <span className="rounded-[5px] bg-accent-soft px-[5px] py-px font-sans text-[10px]/[13px] font-semibold text-accent-ink">web</span>;
}

export interface RunFormValue {
  app: string;
  /** Trống = mọi flow của app. */
  flows: string[];
  secrets: string[];
  repeat: string;
  /** Số máy; 0 hoặc trống = mọi máy rảnh. */
  count: string;
  label: string;
  artifacts: ArtifactsMode;
  platform: RunPlatform;
}

const toInt = (s: string, min: number) => {
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) && n >= min ? n : min;
};

/** Form -> tower.DispatchRequest (số lặp ít nhất 1, số máy 0 = mọi máy rảnh). */
export function buildDispatch(v: RunFormValue): DispatchRequest {
  return {
    app: v.app,
    flows: v.flows,
    devices: [],
    filter: { platform: v.platform, model: '', count: toInt(v.count, 0) },
    env: {},
    secrets: v.secrets,
    repeat: toInt(v.repeat, 1),
    record: '',
    artifacts: v.artifacts,
    label: v.label.trim(),
    timeoutSec: 0,
    typingFrequency: 0,
  };
}

const toggle = (list: string[], item: string, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));

/** Form sinh ca kiểm thử từ yêu cầu: các mã điền sẵn, chọn một máy để lấy cây UI và chạy xác nhận. */
export interface CompileFormValue {
  app: string;
  reqs: string[];
  deviceId: string;
  /** Chỉ điện thoại: package/bundle id. */
  appId: string;
  /** Chỉ web: trang mở trước khi đọc snapshot. */
  startPath: string;
  secrets: string[];
}

/** Máy dùng được để biên dịch: còn cắm. */
export const compileDevices = (fleet: Device[]) => fleet.filter((d) => d.state !== 'disconnected');

/** Lý do chưa gửi được form ("" = gửi được). Khớp kiểm tra của Go (testengine.Compile). */
export function compileProblem(v: CompileFormValue, d: Device | undefined): string {
  if (v.reqs.length === 0) return 'Chọn ít nhất một mã yêu cầu.';
  if (!d) return 'Chọn máy để lấy giao diện và chạy xác nhận.';
  if (d.platform !== 'web' && !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(v.appId.trim())) return 'Nhập App ID hợp lệ (vd com.example.app).';
  const sp = v.startPath.trim();
  if (d.platform === 'web' && sp !== '' && (!sp.startsWith('/') || sp.startsWith('//') || /[\\\s]/.test(sp))) return 'Trang mở đầu phải là đường dẫn bắt đầu bằng / (vd /login).';
  return '';
}

/** Form -> testengine.CompileRequest; teamId chỉ dùng cho iPhone thật (máy ảo và máy khác để trống). */
export function buildCompile(v: CompileFormValue, d: Device, teamId: string, confirmToken = ''): CompileRequest {
  const web = d.platform === 'web';
  return {
    app: v.app,
    source: '',
    appId: web ? '' : v.appId.trim(),
    device: { ID: d.id, Platform: d.platform, Driver: d.driver ?? '', ...(d.platform === 'ios' && !d.simulator ? { TeamID: teamId } : {}) },
    env: {},
    secrets: v.secrets,
    confirmToken,
    startPath: web ? v.startPath.trim() : '',
    reqs: v.reqs,
  };
}

/** Lỗi confirm_required: chi phí ước tính vượt trần mỗi thao tác, Go trả token để gọi lại. */
const confirmTokenOf = (e: unknown) => {
  const err = e as { code?: string; params?: Record<string, string | number> } | null;
  return err?.code === 'confirm_required' && err.params?.token ? String(err.params.token) : '';
};

/**
 * Sinh ca kiểm thử từ các mã yêu cầu điền sẵn (trang Tài liệu: chọn yêu cầu, hoặc sinh lại ca bị ảnh hưởng). Gọi test.Service.Compile
 * như tool test_compile: AI tách ca, flow qua kiểm tra an toàn và chỉ lưu khi chạy xác nhận đạt; ca giữ mã TC-… cũ.
 */
export function CompileForm({
  app,
  reqs,
  title = 'Sinh ca kiểm thử',
  onClose,
  onDone,
}: {
  app: string;
  /** Mã yêu cầu điền sẵn (bỏ chọn được từng mã). */
  reqs: string[];
  title?: string;
  onClose?: () => void;
  /** Sinh xong (để trang đọc lại độ phủ, ca bị ảnh hưởng). */
  onDone?: (res: CompileResult) => void;
}) {
  const { show } = useToast();
  const [v, setV] = useState<CompileFormValue>({ app, reqs, deviceId: '', appId: '', startPath: '', secrets: [] });
  const [fleet, setFleet] = useState<Device[]>([]);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ token: string; text: string } | null>(null);
  const [result, setResult] = useState<CompileResult | null>(null);
  const set = (p: Partial<CompileFormValue>) => setV((o) => ({ ...o, ...p }));

  // Mở lại với bộ mã khác (sinh lại ca khác): điền lại mã, bỏ kết quả cũ.
  useEffect(() => {
    setV((o) => ({ ...o, app, reqs }));
    setResult(null);
    setConfirm(null);
  }, [app, reqs]);
  useEffect(() => {
    towerApi.fleet().then(
      (all) => {
        const list = compileDevices(all);
        setFleet(list);
        setV((o) => (o.deviceId || list.length === 0 ? o : { ...o, deviceId: list[0].id }));
      },
      (e) => show(errorText(e)),
    );
    testApi.secretNames().then(
      (names) => {
        setSecretNames(names);
        setV((o) => ({ ...o, secrets: names }));
      },
      () => undefined, // không đọc được kho: vẫn sinh được flow không dùng biến bí mật
    );
  }, [show]);

  const device = fleet.find((d) => d.id === v.deviceId);
  const problem = compileProblem(v, device);
  const start = async (token = '') => {
    if (problem || !device) return;
    setBusy(true);
    setConfirm(null);
    try {
      const teamId = device.platform === 'ios' && !device.simulator ? await towerApi.teamId() : '';
      const res = await testApi.compile(buildCompile(v, device, teamId, token));
      setResult(res);
      void testApi.track('docs_compile', { app: v.app, reqs: v.reqs.length, cases: res.cases.length });
      show(`Đã sinh ${res.cases.length} ca cho ${v.app}.`);
      onDone?.(res);
    } catch (e) {
      const t = confirmTokenOf(e);
      if (t) setConfirm({ token: t, text: errorText(e) });
      else show(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={`${title} · ${app}`}
      aside={
        onClose && (
          <Button size="xs" variant="secondary" icon={<X size={13} />} onClick={onClose}>
            Đóng
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-[10px]" data-testid="compile-form">
        <div className="flex flex-col gap-[6px]">
          <span className="text-[12px]/[15px] font-semibold text-text-2">Mã yêu cầu</span>
          <div className="flex flex-wrap gap-x-[14px] gap-y-[6px]">
            {reqs.map((r) => (
              <Checkbox key={r} checked={v.reqs.includes(r)} onChange={(on) => set({ reqs: toggle(v.reqs, r, on) })}>
                <span className="font-mono">{r}</span>
              </Checkbox>
            ))}
          </div>
        </div>
        {fleet.length === 0 ? (
          <Muted>Chưa có máy nào đang cắm. Cắm điện thoại hoặc thêm hồ sơ trình duyệt rồi mở lại.</Muted>
        ) : (
          <label className="flex w-full flex-col gap-[6px] leading-[normal]">
            <span className="text-[12px]/[15px] font-semibold text-text-2">Máy lấy giao diện và chạy xác nhận</span>
            <select
              className="stroke-in h-[40px] rounded-[8px] bg-surface px-[12px] text-[13px]/[16px] text-text"
              value={v.deviceId}
              onChange={(e) => set({ deviceId: e.target.value })}
            >
              {fleet.map((d) => (
                <option key={d.id} value={d.id}>
                  {deviceName(d)} · {d.platform}
                </option>
              ))}
            </select>
          </label>
        )}
        {device && device.platform !== 'web' && (
          <Input label="App ID" mono placeholder="com.example.app" value={v.appId} onChange={(e) => set({ appId: e.target.value })} />
        )}
        {device?.platform === 'web' && (
          <Input label="Trang mở đầu (để trống = /)" mono placeholder="/login" value={v.startPath} onChange={(e) => set({ startPath: e.target.value })} />
        )}
        {secretNames.length > 0 && (
          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px]/[15px] font-semibold text-text-2">Biến bí mật flow được dùng</span>
            <div className="flex flex-wrap gap-x-[14px] gap-y-[6px]">
              {secretNames.map((n) => (
                <Checkbox key={n} checked={v.secrets.includes(n)} onChange={(on) => set({ secrets: toggle(v.secrets, n, on) })}>
                  <span className="font-mono">{n}</span>
                </Checkbox>
              ))}
            </div>
          </div>
        )}
        <Muted>Gọi AI một lần cho các yêu cầu đã chọn; ca không đổi được giữ nguyên, không gọi lại AI. Flow chỉ được lưu khi chạy xác nhận đạt.</Muted>
        {problem && <p className="text-[11.5px]/[15px] text-amber">{problem}</p>}
        {confirm && (
          <div className="flex flex-wrap items-center gap-[8px] rounded-[6px] bg-amber-soft px-[8px] py-[6px]" data-testid="compile-confirm">
            <p className="min-w-0 flex-1 text-[12px]/[16px] text-text">{confirm.text}</p>
            <Button size="xs" disabled={busy} onClick={() => void start(confirm.token)}>
              Xác nhận
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-[10px]">
          <Button disabled={busy || problem !== ''} onClick={() => void start()} icon={<Sparkles size={15} />}>
            {busy ? 'Đang sinh ca…' : 'Sinh ca kiểm thử'}
          </Button>
        </div>
        {result && <FlowList data={result} />}
      </div>
    </Card>
  );
}

export function RunForm({ apps }: { apps: { app: string; flows: FlowInfo[] }[] }) {
  const { show } = useToast();
  const [v, setV] = useState<RunFormValue>({ app: '', flows: [], secrets: [], repeat: '1', count: '0', label: '', artifacts: 'always', platform: '' });
  // Người dùng đã tự chọn nền tảng: chọn flow không đổi lựa chọn đó nữa.
  const [platformPicked, setPlatformPicked] = useState(false);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<RunFormValue>) => setV((o) => ({ ...o, ...p }));

  // Biến bí mật đã lưu: mặc định truyền hết (chỉ tên, giá trị Go tự lấy từ kho).
  useEffect(() => {
    testApi.secretNames().then(
      (names) => {
        setSecretNames(names);
        setV((o) => ({ ...o, secrets: names }));
      },
      () => undefined, // không đọc được kho: vẫn chạy được flow không dùng biến bí mật
    );
  }, []);
  // App chọn mặc định: app đầu tiên; app bị xoá khỏi kho thì chọn lại.
  useEffect(() => {
    if (apps.length > 0 && !apps.some((a) => a.app === v.app)) setV((o) => ({ ...o, app: apps[0].app, flows: [] }));
  }, [apps, v.app]);

  if (apps.length === 0) return null;
  const flows = apps.find((a) => a.app === v.app)?.flows ?? [];
  const start = async () => {
    if (!v.app) return;
    const req = buildDispatch(v);
    setBusy(true);
    try {
      const task = await testApi.dispatch(req);
      void testApi.track('run_start', { app: req.app, flows: req.flows.length, artifacts: req.artifacts, repeat: req.repeat, task: task.id });
      show(`Đã bắt đầu chạy ${req.app} (task ${task.id}). Kết quả hiện ở Lượt chạy gần nhất khi xong.`);
    } catch (e) {
      show(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Chạy flow">
      <div className="flex flex-col gap-[10px]" data-testid="run-form">
        <div className="flex gap-[10px]">
          <label className="flex w-full flex-col gap-[6px] leading-[normal]">
            <span className="text-[12px]/[15px] font-semibold text-text-2">App</span>
            <select
              className="stroke-in h-[40px] rounded-[8px] bg-surface px-[12px] text-[13px]/[16px] text-text"
              value={v.app}
              onChange={(e) => set({ app: e.target.value, flows: [], ...(platformPicked ? {} : { platform: '' }) })}
            >
              {apps.map((a) => (
                <option key={a.app} value={a.app}>
                  {a.app}
                </option>
              ))}
            </select>
          </label>
          <Input label="Số lần lặp" type="number" min={1} max={100} value={v.repeat} onChange={(e) => set({ repeat: e.target.value })} />
          <Input label="Số máy (0 = mọi máy rảnh)" type="number" min={0} value={v.count} onChange={(e) => set({ count: e.target.value })} />
        </div>
        {flows.length > 0 && (
          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px]/[15px] font-semibold text-text-2">Flow (không chọn = mọi flow)</span>
            <div className="flex flex-wrap gap-x-[14px] gap-y-[6px]">
              {flows.map((f) => (
                <Checkbox
                  key={f.name}
                  checked={v.flows.includes(f.name)}
                  onChange={(on) => {
                    const next = toggle(v.flows, f.name, on);
                    set({ flows: next, ...(platformPicked ? {} : { platform: defaultPlatform(next) }) });
                  }}
                >
                  <span className="flex items-center gap-[5px]">
                    <span className="font-mono">{f.name}</span>
                    {isSpecFlow(f.name) && <WebBadge />}
                  </span>
                </Checkbox>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-[6px]" data-testid="run-platform">
          <span className="text-[12px]/[15px] font-semibold text-text-2">Nền tảng</span>
          <Segmented
            options={PLATFORM_OPTIONS}
            value={v.platform}
            onChange={(k) => {
              setPlatformPicked(true);
              set({ platform: k });
            }}
          />
          <Muted>Flow .yaml chạy trên điện thoại, flow .spec.ts chạy trên trình duyệt. Số máy áp dụng riêng cho từng loại.</Muted>
        </div>
        {secretNames.length > 0 && (
          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px]/[15px] font-semibold text-text-2">Biến bí mật truyền vào flow</span>
            <div className="flex flex-wrap gap-x-[14px] gap-y-[6px]">
              {secretNames.map((n) => (
                <Checkbox key={n} checked={v.secrets.includes(n)} onChange={(on) => set({ secrets: toggle(v.secrets, n, on) })}>
                  <span className="font-mono">{n}</span>
                </Checkbox>
              ))}
            </div>
          </div>
        )}
        <Input label="Bản app đang thử (tuỳ chọn)" placeholder="1.4.2" value={v.label} onChange={(e) => set({ label: e.target.value })} />
        <div className="flex flex-col gap-[6px]">
          <span className="text-[12px]/[15px] font-semibold text-text-2">Ảnh evidence</span>
          <Segmented options={ARTIFACT_OPTIONS} value={v.artifacts} onChange={(k) => set({ artifacts: k })} />
          <Muted>Ảnh trước/sau từng bước để xem lại trong chi tiết lượt chạy. Mọi bước làm flow chậm hơn và tốn đĩa hơn; dữ liệu chỉ lưu trên máy này.</Muted>
        </div>
        <div className="flex flex-wrap gap-[10px]">
          <Button disabled={busy || !v.app} onClick={() => void start()} icon={<Play size={15} />}>
            {busy ? 'Đang gửi lệnh…' : 'Chạy'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
