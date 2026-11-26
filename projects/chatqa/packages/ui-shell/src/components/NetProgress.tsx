import { cx } from './ui/cx';
import { useNetProgress } from '../lib/use-net-progress';

/**
 * Chi tiết thao tác mạng ngay cạnh nút đang chạy: việc đang làm, đếm (nếu có), thời gian đã chờ và còn lại.
 * `op` là khoá thao tác (trùng khoá phía Go); `active` thường là `busy` của useAction; `label` là nhãn dự phòng
 * khi chưa có tin từ Go. Không active thì không vẽ gì.
 */
export function NetProgress({ op, active, label, className }: { op: string; active: boolean; label: string; className?: string }) {
  const v = useNetProgress(op, active, label);
  if (!v) return null;
  const detail = [v.count, v.time].filter(Boolean).join(' · ');
  return (
    <div role="status" aria-live="polite" className={cx('flex min-w-[200px] max-w-[360px] flex-col gap-[4px] text-[11.5px]/[15px] text-text-2', className)}>
      <span className="font-semibold text-text">{v.label}…</span>
      {detail && <span className={v.slow ? 'text-amber' : undefined}>{detail}</span>}
      {v.note && <span className="text-amber">{v.note}</span>}
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-border" aria-hidden>
        <div
          className={cx('h-full rounded-full bg-accent transition-[width] duration-500', v.fraction === null && 'w-full animate-pulse')}
          style={v.fraction === null ? undefined : { width: `${Math.round(v.fraction * 100)}%` }}
        />
      </div>
    </div>
  );
}
