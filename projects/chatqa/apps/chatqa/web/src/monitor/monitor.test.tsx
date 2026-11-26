import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { noActions } from '../chat/components/shared';
import { ActivityView } from './ActivityPane';
import { MonitorView, whenText, type MonitorActions, type MonitorData } from './MonitorPage';
import { EVENTS } from './bridge';

const actions: MonitorActions = {
  toggleSchedule: () => undefined,
  deleteSchedule: () => undefined,
  addSchedule: async () => true,
  toggleWebhook: () => undefined,
  deleteWebhook: () => undefined,
  addWebhook: async () => null,
};

const req = { app: 'mexpress', flows: ['01_login.yaml'], devices: null, filter: { platform: '', model: '', count: 2 }, env: null, secrets: null, repeat: 1, record: '', label: '', timeoutSec: 0 };
const data: MonitorData = {
  schedules: [{ id: 's-1', name: 'Đăng nhập buổi sáng', request: req, everyMin: 0, at: '08:30', days: [1, 2, 3, 4, 5], enabled: true, nextRun: '2026-11-16T01:30:00Z', lastError: 'bỏ lỡ lần 14/11 08:30: ChatQASoftware không mở trên máy này' }],
  webhooks: [{ id: 'w-1', name: 'Slack QA', url: 'https://hooks.example.vn/qa', events: ['task_failed', 'alert'], enabled: true, createdAt: '' }],
  deliveries: [{ id: 'd-1', target: 'Slack QA · task_failed', event: 'task_failed', at: '2026-11-14T02:00:00Z', status: 'dead', attempts: 5, code: 500, latencyMs: 120 }],
  alerts: [{ level: 'error', kind: 'delivery_dead', text: '1 lượt gửi webhook bị bỏ sau 5 lần thử trong 24 giờ' }],
};

describe('Giám sát', () => {
  it('mô tả lịch: lặp theo phút, giờ trong ngày, ngày trong tuần', () => {
    expect(whenText({ everyMin: 30, at: '', days: null })).toBe('Mỗi 30 phút');
    expect(whenText({ everyMin: 0, at: '08:30', days: [] })).toBe('08:30 mọi ngày');
    expect(whenText({ everyMin: 0, at: '08:30', days: [1, 5] })).toBe('08:30 các ngày T2, T6');
  });

  it('màn Giám sát: lịch, webhook không lộ khoá, lượt gửi bị bỏ, cảnh báo, lưu ý máy phải mở; không còn gửi Drive', () => {
    const html = renderToStaticMarkup(<MonitorView data={data} actions={actions} />);
    for (const s of ['Đăng nhập buổi sáng', '08:30 các ngày T2, T3, T4, T5, T6', 'bỏ lỡ lần', 'Slack QA', 'Task lỗi · Cảnh báo mới', 'Bỏ sau nhiều lần thử', 'lượt gửi webhook bị bỏ', 'chỉ chạy khi ChatQASoftware trên máy này đang mở', 'Thêm webhook']) {
      expect(html, s).toContain(s);
    }
    expect(html).not.toMatch(/Drive/i);
    expect(EVENTS.map((e) => e.code)).toEqual(['task_failed', 'task_finished', 'alert']);
  });

  it('không có quyền cqs.automations: chỉ xem, không có nút sửa', () => {
    const html = renderToStaticMarkup(<MonitorView data={data} actions={actions} readOnly />);
    expect(html).not.toContain('Thêm lịch');
    expect(html).not.toContain('Thêm webhook');
    expect(html).not.toContain('>Xoá<');
    expect(html).toContain('Đăng nhập buổi sáng');
  });

  it('ô Hoạt động: trống thì lời nhắc; có thì cảnh báo, task, lượt gửi', () => {
    expect(renderToStaticMarkup(<ActivityView data={{ alerts: [], tasks: [], deliveries: [] }} actions={noActions} />)).toContain('Chưa có hoạt động');
    const html = renderToStaticMarkup(
      <ActivityView data={{ alerts: data.alerts, tasks: [{ id: 't-9', kind: 'dispatch', status: 'failed', passed: 1, failed: 1, createdAt: '' }], deliveries: data.deliveries }} actions={noActions} />,
    );
    for (const s of ['Cảnh báo', 't-9', 'Chạy lại lỗi', 'Lượt gửi webhook']) expect(html, s).toContain(s);
  });
});
