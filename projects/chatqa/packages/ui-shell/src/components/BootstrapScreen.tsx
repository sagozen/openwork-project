// Màn lấy dữ liệu từ Drive trên máy mới hoặc máy cài lại (FR-006): các bước, x/y, câu E-017, cảnh báo máy cũ E-011.
// Chưa có khung pen riêng: dựng từ token như thẻ đăng nhập.
import { Check, CloudDownload, TriangleAlert } from 'lucide-react';
import type { BootstrapProgress } from '../sync/drive-api';
import { useNetProgress } from '../lib/use-net-progress';
import { bootstrapText, driveCopy } from '../sync/sync-view';
import { Banner, Button } from './ui';
import { cx } from './ui/cx';

/** Bước 1 (phần tối thiểu để làm việc) và bước 2 (3 tháng gần nhất); ảnh và dữ liệu cũ hơn tải khi mở tới. */
const STAGES = [
  { stage: 1, label: 'Cấu hình, biểu thuế, quy tắc, bài học AI, kho kết quả' },
  { stage: 2, label: 'Dữ liệu 3 tháng gần nhất' },
];

export function BootstrapScreen({ progress, onDismiss, overlay = true }: { progress: BootstrapProgress; /** Chỉ khi đã có phần tối thiểu (bước 2 trở đi) mới cho làm việc tiếp. */ onDismiss?: () => void; overlay?: boolean }) {
  const msg = bootstrapText(progress);
  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  // Thời gian đã chờ và còn lại của giai đoạn đang chạy (Go đếm tệp theo giai đoạn, thao tác drive.bootstrap).
  const net = useNetProgress('drive.bootstrap', progress.running, 'Đang lấy dữ liệu từ Drive');
  const panel = (
    <section role="dialog" aria-label="Lấy dữ liệu từ Drive công ty" className="stroke-in flex w-[460px] max-w-[calc(100vw-24px)] flex-col gap-[16px] rounded-[14px] bg-surface p-[24px] leading-[normal] text-text shadow-dialog">
      <div className="flex items-center gap-[12px]">
        <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent">
          <CloudDownload size={20} />
        </span>
        <h2 className="text-[16px]/[20px] font-bold">Lấy dữ liệu từ Drive công ty</h2>
      </div>
      <ol className="flex flex-col gap-[10px]">
        {STAGES.map((s) => {
          const done = progress.stage > s.stage;
          const active = progress.stage === s.stage;
          return (
            <li key={s.stage} data-stage={s.stage} className="flex flex-col gap-[6px]">
              <div className="flex items-center gap-[8px]">
                <span className={cx('flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full text-[10px]/[12px] font-bold', done ? 'bg-green-soft text-green' : active ? 'bg-accent text-white' : 'bg-chip-neutral text-text-3')}>
                  {done ? <Check size={11} /> : s.stage}
                </span>
                <span className={cx('min-w-0 flex-1 text-[12.5px]/[16px]', active ? 'font-semibold' : 'text-text-2')}>{s.label}</span>
                {active && progress.total > 0 && (
                  <span className="font-mono text-[11.5px]/[15px] text-text-2">
                    {progress.done}/{progress.total}
                  </span>
                )}
              </div>
              {active && (
                <div className="ml-[28px] h-[4px] rounded-[2px] bg-blue-soft">
                  <div className="h-[4px] rounded-[2px] bg-blue" style={{ width: `${pct}%` }} />
                </div>
              )}
              {active && net && (net.time || net.note) && (
                <span role="status" aria-live="polite" className={cx('ml-[28px] text-[11.5px]/[15px]', net.slow || net.note ? 'text-amber' : 'text-text-2')}>
                  {[net.time, net.note].filter(Boolean).join(' · ')}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {msg && <Banner tone="amber">{msg}</Banner>}
      {progress.previousDevice && progress.previousDevice.lastSyncAt > 0 && (
        <Banner tone="amber" icon={<TriangleAlert size={16} />}>
          {driveCopy('previous_device_unsynced', { at: progress.previousDevice.lastSyncAt })}
        </Banner>
      )}
      {onDismiss && progress.stage >= 2 && (
        <div className="flex justify-end">
          <Button size="dialog" variant="secondary" onClick={onDismiss}>
            Đóng
          </Button>
        </div>
      )}
    </section>
  );
  if (!overlay) return panel;
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg">{panel}</div>;
}
