// App 3 - Giám sát, mở ở khung giữa (/giam-sat): lịch chạy cục bộ, webhook gửi đi, lượt gửi, cảnh báo.
// Báo cáo lượt chạy nằm trên máy (màn Kiểm thử: "Mở thư mục", "Mở báo cáo"); không gửi lên đâu cả.
// Phần hiển thị thuần (MonitorView) render và test độc lập; MonitorPage tải từ Go và tải lại khi "monitor:change".
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Checkbox, Input, Toggle } from '@shell/components/ui';
import { errorText, useSession } from '@shell/lib/session';
import { useToast } from '@shell/components/overlays/ToastHost';
import { AlertList } from '../chat/components/metrics';
import { DeliveryLog } from '../chat/components/runs';
import { Card, Muted } from '../chat/components/shared';
import { EVENTS, monitorApi, onMonitorChange, type Alert, type Delivery, type Schedule, type Webhook } from './bridge';

const DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/** "Mỗi 30 phút" / "08:30 các ngày T2, T3" / "08:30 mọi ngày". */
export function whenText(sc: Pick<Schedule, 'everyMin' | 'at' | 'days'>): string {
  if (sc.everyMin > 0) return `Mỗi ${sc.everyMin} phút`;
  const days = sc.days ?? [];
  return days.length === 0 || days.length === 7 ? `${sc.at} mọi ngày` : `${sc.at} các ngày ${days.map((d) => DAYS[d]).join(', ')}`;
}

const dateTime = (iso?: string) => (iso ? new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export interface MonitorData {
  schedules: Schedule[];
  webhooks: Webhook[];
  deliveries: Delivery[];
  alerts: Alert[];
}

export interface MonitorActions {
  toggleSchedule: (sc: Schedule) => void;
  deleteSchedule: (id: string) => void;
  addSchedule: (sc: Schedule) => Promise<boolean>;
  toggleWebhook: (w: Webhook) => void;
  deleteWebhook: (id: string) => void;
  addWebhook: (name: string, url: string, events: string[]) => Promise<string | null>;
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card title={title} aside={aside}>
      {children}
    </Card>
  );
}

function ScheduleForm({ onSave }: { onSave: MonitorActions['addSchedule'] }) {
  const [name, setName] = useState('');
  const [app, setApp] = useState('');
  const [flows, setFlows] = useState('');
  const [count, setCount] = useState('1');
  const [mode, setMode] = useState<'every' | 'at'>('at');
  const [every, setEvery] = useState('60');
  const [at, setAt] = useState('08:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const submit = async () => {
    const ok = await onSave({
      id: '',
      name,
      enabled: true,
      everyMin: mode === 'every' ? Number(every) || 0 : 0,
      at: mode === 'at' ? at : '',
      days: mode === 'at' ? days : null,
      request: {
        app,
        flows: flows.trim() ? flows.split(',').map((f) => f.trim()).filter(Boolean) : null,
        devices: null,
        filter: { platform: '', model: '', count: Number(count) || 0 },
        env: null,
        secrets: null,
        repeat: 1,
        record: '',
        label: '',
        timeoutSec: 0,
      },
    });
    if (ok) setName('');
  };
  return (
    <form
      className="grid gap-[8px] rounded-[8px] bg-muted-box p-[10px] sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input label="Tên lịch" value={name} onChange={(e) => setName(e.target.value)} placeholder="Đăng nhập buổi sáng" />
      <Input label="App (bộ flow)" value={app} onChange={(e) => setApp(e.target.value)} placeholder="mexpress" mono />
      <Input label="Flow (cách nhau dấu phẩy; trống = mọi flow)" value={flows} onChange={(e) => setFlows(e.target.value)} mono />
      <Input label="Số máy (0 = mọi máy rảnh)" value={count} onChange={(e) => setCount(e.target.value)} inputMode="numeric" />
      <div className="flex items-end gap-[8px] sm:col-span-2">
        <label className="flex items-center gap-[6px] text-[12.5px]/[16px] text-text-2">
          <input type="radio" checked={mode === 'at'} onChange={() => setMode('at')} /> Lúc
        </label>
        <Input aria-label="Giờ chạy" value={at} onChange={(e) => setAt(e.target.value)} disabled={mode !== 'at'} wrapperClassName="w-[90px]" mono />
        <label className="ml-[12px] flex items-center gap-[6px] text-[12.5px]/[16px] text-text-2">
          <input type="radio" checked={mode === 'every'} onChange={() => setMode('every')} /> Mỗi
        </label>
        <Input aria-label="Số phút" value={every} onChange={(e) => setEvery(e.target.value)} disabled={mode !== 'every'} wrapperClassName="w-[80px]" inputMode="numeric" />
        <span className="pb-[11px] text-[12.5px]/[16px] text-text-2">phút</span>
      </div>
      {mode === 'at' && (
        <div className="flex flex-wrap gap-[10px] sm:col-span-2">
          {DAYS.map((d, i) => (
            <Checkbox key={d} checked={days.includes(i)} onChange={(on) => setDays((x) => (on ? [...x, i].sort() : x.filter((y) => y !== i)))}>
              {d}
            </Checkbox>
          ))}
        </div>
      )}
      <div className="flex items-center gap-[10px] sm:col-span-2">
        <Button type="submit" size="sm" disabled={!name.trim() || !app.trim()}>
          Thêm lịch
        </Button>
        <Muted>Lịch chỉ chạy khi ChatQASoftware trên máy này đang mở và có người đăng nhập đủ quyền chạy; lịch chạy dưới tên người đó. Lần đến hạn lúc máy tắt bị bỏ qua.</Muted>
      </div>
    </form>
  );
}

function WebhookForm({ onSave }: { onSave: MonitorActions['addWebhook'] }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['task_failed', 'alert']);
  const [secret, setSecret] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-[8px] rounded-[8px] bg-muted-box p-[10px]">
      {secret ? (
        <div className="flex flex-col gap-[6px]" role="status">
          <p className="text-[12.5px]/[17px] font-semibold text-text">Khoá ký của webhook (chỉ hiện lần này, hãy lưu ngay)</p>
          <code className="select-all break-all rounded-[6px] bg-surface px-[8px] py-[6px] font-mono text-[11.5px]/[16px] text-text">{secret}</code>
          <Muted>Bên nhận kiểm X-CQS-Signature = "sha256=" + HMAC-SHA256(khoá, X-CQS-Timestamp + "." + thân yêu cầu) và bỏ yêu cầu có thời điểm quá cũ.</Muted>
          <Button size="sm" variant="secondary" className="self-start" onClick={() => setSecret(null)}>
            Đã lưu khoá
          </Button>
        </div>
      ) : (
        <form
          className="grid gap-[8px] sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave(name, url, events).then((s) => {
              if (s) {
                setSecret(s);
                setName('');
                setUrl('');
              }
            });
          }}
        >
          <Input label="Tên" value={name} onChange={(e) => setName(e.target.value)} placeholder="Slack QA" />
          <Input label="Địa chỉ (https)" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.vn/qa" mono />
          <div className="flex flex-wrap gap-[10px] sm:col-span-2">
            {EVENTS.map((ev) => (
              <Checkbox key={ev.code} checked={events.includes(ev.code)} onChange={(on) => setEvents((x) => (on ? [...x, ev.code] : x.filter((y) => y !== ev.code)))}>
                {ev.label}
              </Checkbox>
            ))}
          </div>
          <Button type="submit" size="sm" className="self-start" disabled={!name.trim() || !url.trim() || events.length === 0}>
            Thêm webhook
          </Button>
        </form>
      )}
    </div>
  );
}

/** Màn Giám sát thuần theo dữ liệu. readOnly: người không có quyền cqs.automations vẫn xem được, không thấy nút sửa. */
export function MonitorView({ data, actions, readOnly }: { data: MonitorData; actions: MonitorActions; readOnly?: boolean }) {
  return (
    <div className="flex flex-col gap-[10px] px-[16px] py-[14px]" data-testid="monitor">
      <AlertList data={data.alerts} />
      <Section title={`Lịch chạy · ${data.schedules.length}`}>
        {data.schedules.length === 0 ? (
          <Muted>Chưa có lịch nào.</Muted>
        ) : (
          <ul>
            {data.schedules.map((sc) => (
              <li key={sc.id} className="flex items-center gap-[10px] border-t border-divider py-[7px] first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px]/[16px] font-semibold text-text">{sc.name}</p>
                  <p className="truncate text-[11.5px]/[15px] text-text-3">
                    {whenText(sc)} · {sc.request.app}
                    {sc.request.flows?.length ? ` · ${sc.request.flows.join(', ')}` : ''} · lần sau {dateTime(sc.nextRun)}
                    {sc.lastTask ? ` · lần trước ${sc.lastTask}` : ''}
                  </p>
                  {sc.lastError && <p className="truncate text-[11.5px]/[15px] text-amber">{sc.lastError}</p>}
                </div>
                {!readOnly && (
                  <>
                    <Toggle size="setting" slot={false} checked={sc.enabled} onChange={() => actions.toggleSchedule(sc)} label={`Bật lịch ${sc.name}`} />
                    <Button size="sm" variant="secondary" onClick={() => actions.deleteSchedule(sc.id)}>
                      Xoá
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {!readOnly && <ScheduleForm onSave={actions.addSchedule} />}
      </Section>
      <Section title={`Webhook · ${data.webhooks.length}`}>
        {data.webhooks.length === 0 ? (
          <Muted>Chưa có webhook nào.</Muted>
        ) : (
          <ul>
            {data.webhooks.map((w) => (
              <li key={w.id} className="flex items-center gap-[10px] border-t border-divider py-[7px] first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px]/[16px] font-semibold text-text">{w.name}</p>
                  <p className="truncate font-mono text-[11px]/[15px] text-text-3">{w.url}</p>
                  <p className="truncate text-[11.5px]/[15px] text-text-3">{w.events.map((e) => EVENTS.find((x) => x.code === e)?.label ?? e).join(' · ')}</p>
                </div>
                {!readOnly && (
                  <>
                    <Toggle size="setting" slot={false} checked={w.enabled} onChange={() => actions.toggleWebhook(w)} label={`Bật webhook ${w.name}`} />
                    <Button size="sm" variant="secondary" onClick={() => actions.deleteWebhook(w.id)}>
                      Xoá
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {!readOnly && <WebhookForm onSave={actions.addWebhook} />}
      </Section>
      <DeliveryLog data={data.deliveries} />
    </div>
  );
}

const EMPTY: MonitorData = { schedules: [], webhooks: [], deliveries: [], alerts: [] };

export default function MonitorPage() {
  const { show } = useToast();
  const canEdit = useSession().can('cqs.automations');
  const [data, setData] = useState<MonitorData>(EMPTY);
  const load = useCallback(async () => {
    try {
      const [schedules, webhooks, deliveries, alerts] = await Promise.all([
        monitorApi.schedules(),
        monitorApi.webhooks(),
        monitorApi.deliveries(),
        monitorApi.alerts(),
      ]);
      setData({ schedules, webhooks, deliveries, alerts });
    } catch (e) {
      show(errorText(e));
    }
  }, [show]);
  useEffect(() => {
    void load();
    return onMonitorChange(() => void load());
  }, [load]);

  const run = useCallback(
    async <T,>(p: Promise<T>): Promise<T | null> => {
      try {
        const r = await p;
        void load();
        return r;
      } catch (e) {
        show(errorText(e));
        return null;
      }
    },
    [load, show],
  );

  const actions: MonitorActions = {
    toggleSchedule: (sc) => void run(monitorApi.saveSchedule({ ...sc, enabled: !sc.enabled })),
    deleteSchedule: (id) => void run(monitorApi.deleteSchedule(id)),
    addSchedule: async (sc) => (await run(monitorApi.saveSchedule(sc))) !== null,
    toggleWebhook: (w) => void run(monitorApi.setWebhookEnabled(w.id, !w.enabled)),
    deleteWebhook: (id) => void run(monitorApi.deleteWebhook(id)),
    addWebhook: async (name, url, events) => (await run(monitorApi.createWebhook(name, url, events)))?.secret ?? null,
  };
  return <MonitorView data={data} actions={actions} readOnly={!canEdit} />;
}
