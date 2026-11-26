// Phần dùng chung của các component chat: khung thẻ, nhãn trạng thái, định dạng.
import type { ReactNode } from 'react';
import { cx } from '@shell/components/ui/cx';

/** Hành động từ nút trên component; mỗi hành động là một lần gọi tool, được ghi như mọi lệnh khác. */
export interface ChatActions {
  runTool: (tool: string, args: Record<string, unknown>) => void;
  confirmChat: (token: string) => void;
  /** Mở máy ở màn hình trực tiếp (khung giữa); không có = không hiện nút. */
  openLive?: (deviceId: string) => void;
  /** Mở thư mục lượt chạy hoặc evidence.html trên máy (báo cáo không gửi đi đâu); không có = không hiện nút. */
  openRun?: (runId: string, what: 'folder' | 'report') => void;
  /** Mở Cài đặt › Kiểm thử (cài bộ chạy trình duyệt) từ máy web chưa dùng được; không có = không hiện nút. */
  openSettings?: () => void;
}

export const noActions: ChatActions = { runTool: () => undefined, confirmChat: () => undefined };

export function Card({ title, aside, children, tone }: { title: string; aside?: ReactNode; children: ReactNode; tone?: 'error' | 'warn' }) {
  return (
    <section
      className={cx(
        'stroke-in flex flex-col gap-[8px] rounded-[10px] px-[12px] py-[10px]',
        tone === 'error' ? 'bg-red-soft' : tone === 'warn' ? 'bg-amber-soft' : 'bg-surface',
      )}
    >
      <header className="flex items-center gap-[8px]">
        <h3 className="min-w-0 flex-1 truncate text-[12.5px]/[16px] font-semibold text-text">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

const STATE_TONE: Record<string, string> = {
  ready: 'bg-green-soft text-green',
  passed: 'bg-green-soft text-green',
  connected: 'bg-accent-soft text-accent-ink',
  running: 'bg-accent-soft text-accent-ink',
  busy: 'bg-accent-soft text-accent-ink',
  preparing: 'bg-accent-soft text-accent-ink',
  unhealthy: 'bg-amber-soft text-amber',
  canceled: 'bg-chip-neutral text-text-2',
  disconnected: 'bg-chip-neutral text-text-3',
  failed: 'bg-red-soft text-red',
  error: 'bg-red-soft text-red',
  ok: 'bg-green-soft text-green',
  pending: 'bg-accent-soft text-accent-ink',
  dead: 'bg-red-soft text-red',
};

const STATE_LABEL: Record<string, string> = {
  ready: 'Sẵn sàng',
  connected: 'Đã cắm',
  preparing: 'Đang chuẩn bị',
  busy: 'Đang chạy',
  unhealthy: 'Chưa dùng được',
  disconnected: 'Đã rút',
  running: 'Đang chạy',
  passed: 'Đạt',
  failed: 'Lỗi',
  canceled: 'Đã dừng',
  error: 'Không chạy được',
  ok: 'Đã gửi',
  pending: 'Chờ gửi',
  dead: 'Bỏ sau nhiều lần thử',
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span className={cx('shrink-0 rounded-[5px] px-[6px] py-px text-[10.5px]/[14px] font-semibold', STATE_TONE[state] ?? 'bg-chip-neutral text-text-2')}>
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

export const pct = (r: number) => `${Math.round(r * 100)}%`;
export const vnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')} đ`;
export const timeOf = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '');

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-[12px]/[16px] text-text-3">{children}</p>;
}
