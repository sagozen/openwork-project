// Cầu nối tới App 3 - Giám sát ở Go (window.go.monitor.Service.*, apps/chatqa/desktop/internal/modules/monitor) và danh sách
// task của tháp cho ô Hoạt động. Kiểu khớp JSON của chatqa/internal/monitor.
import { goCall, onGoEvent } from '../live/bridge';
import type { Task } from '../chat/components/runs';

export interface DispatchRequest {
  app: string;
  flows: string[] | null;
  devices: string[] | null;
  filter: { platform: string; model: string; count: number };
  env: Record<string, string> | null;
  secrets: string[] | null;
  repeat: number;
  record: string;
  label: string;
  timeoutSec: number;
}

export interface Schedule {
  id: string;
  name: string;
  request: DispatchRequest;
  everyMin: number;
  at: string;
  days: number[] | null;
  enabled: boolean;
  createdAt?: string;
  nextRun?: string;
  lastRun?: string;
  lastTask?: string;
  lastError?: string;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

export interface Delivery {
  id: string;
  target: string;
  event: string;
  at: string;
  status: string;
  attempts: number;
  code?: number;
  error?: string;
  latencyMs: number;
  nextAt?: string;
}

export interface Alert {
  level: 'warn' | 'error';
  kind: string;
  deviceId?: string;
  text: string;
}

export type { Task } from '../chat/components/runs';

/** Sự kiện webhook chọn được (khớp monitor.Event* ở Go). */
export const EVENTS: { code: string; label: string }[] = [
  { code: 'task_failed', label: 'Task lỗi' },
  { code: 'task_finished', label: 'Task xong (mọi kết quả)' },
  { code: 'alert', label: 'Cảnh báo mới' },
];

const list = <T,>(r: T[] | null) => r ?? [];
const m = (fn: string) => `monitor.Service.${fn}`;

export const monitorApi = {
  schedules: () => goCall<Schedule[] | null>(m('Schedules')).then(list),
  saveSchedule: (sc: Schedule) => goCall<Schedule>(m('SaveSchedule'), sc),
  deleteSchedule: (id: string) => goCall<void>(m('DeleteSchedule'), id),
  webhooks: () => goCall<Webhook[] | null>(m('Webhooks')).then(list),
  createWebhook: (name: string, url: string, events: string[]) => goCall<{ webhook: Webhook; secret: string }>(m('CreateWebhook'), name, url, events),
  setWebhookEnabled: (id: string, on: boolean) => goCall<void>(m('SetWebhookEnabled'), id, on),
  deleteWebhook: (id: string) => goCall<void>(m('DeleteWebhook'), id),
  deliveries: (limit = 50) => goCall<Delivery[] | null>(m('Deliveries'), limit).then(list),
  alerts: () => goCall<Alert[] | null>(m('Alerts')).then(list),
  tasks: (limit = 10) => goCall<Task[] | null>('tower.Service.Tasks', { status: '', since: '0001-01-01T00:00:00Z', limit }).then(list),
};

/** Có gì đổi ở Giám sát hoặc một task đổi trạng thái: gọi cb (để tải lại). Trả hàm huỷ nghe. */
export function onMonitorChange(cb: () => void): () => void {
  const a = onGoEvent('monitor:change', cb);
  const b = onGoEvent('tower:task', cb);
  return () => {
    a();
    b();
  };
}
