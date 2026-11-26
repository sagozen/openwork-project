import { useEffect, useState, type CSSProperties } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { platform, isDesktop, type SyncStatus } from '../platform';
import { useSession } from '../lib/session';
import { useDriveSync } from '../sync/drive-sync';
import { syncView, type SyncTone, type SyncView } from '../sync/sync-view';
import { cx } from './ui/cx';
import { SyncPanel } from './SyncPanel';

/** Trạng thái hàng đợi đồng bộ trên máy (desktop: nghe sự kiện "sync:status" từ Go). */
export function useSyncStatus(): SyncStatus | null {
  const { state } = useSession();
  const [s, setS] = useState<SyncStatus | null>(state?.sync ?? null);
  useEffect(() => setS(state?.sync ?? null), [state?.sync]);
  useEffect(() => platform.onSyncStatus?.(setS), []);
  return s;
}

// Nền tối = thanh tiêu đề Windows (pill #16241D, chấm #34D399); nền sáng = thanh trên web và điện thoại.
const DARK_PILL: Record<SyncTone, string> = { ok: 'bg-sync-pill', busy: 'bg-sync-pill', offline: 'bg-sync-pill-offline', error: 'bg-sync-pill-offline', conflict: 'bg-sync-pill-offline' };
const DOT: Record<SyncTone, { dark: string; light: string }> = {
  ok: { dark: 'bg-sync-dot', light: 'bg-green' },
  busy: { dark: 'bg-sync-dot', light: 'bg-blue' },
  offline: { dark: 'bg-sync-dot-offline', light: 'bg-amber' },
  error: { dark: 'bg-red', light: 'bg-red' },
  conflict: { dark: 'bg-blue', light: 'bg-blue' },
};

/** Thanh tiêu đề Windows là vùng kéo cửa sổ: pill phải bấm được. */
const NO_DRAG = { '--wails-draggable': 'no-drag' } as CSSProperties;

/** Pill trạng thái đồng bộ: chữ đúng BR-007 (hoặc câu E-001), bấm để mở bảng đồng bộ. compact: chỉ chấm (đầu trang điện thoại
 * hẹp, giữ chỗ cho tiêu đề); chữ vẫn ở aria-label và title, bấm vẫn mở bảng đồng bộ. */
export function SyncBadgeView({ view, surface = 'dark', expanded, compact, onClick }: { view: SyncView; surface?: 'dark' | 'light'; expanded?: boolean; compact?: boolean; onClick?: () => void }) {
  const dark = surface === 'dark';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={`Trạng thái đồng bộ: ${view.text}`}
      title={view.detail || view.text}
      data-sync-state={view.state}
      className={cx(
        'flex h-[26px] max-w-[420px] min-w-0 items-center gap-[6px] rounded-full',
        compact ? 'w-[26px] shrink-0 justify-center' : 'shrink px-[10px]',
        dark ? cx(DARK_PILL[view.tone], 'text-sync-text') : 'stroke-in bg-surface text-text-2',
      )}
      style={dark ? NO_DRAG : undefined}
    >
      {view.tone === 'busy' ? (
        <RefreshCw size={11} className={cx('shrink-0', view.state === 'syncing' && 'animate-spin')} />
      ) : (
        <span className={cx('h-[7px] w-[7px] shrink-0 rounded-full', DOT[view.tone][dark ? 'dark' : 'light'])} />
      )}
      {!compact && <span className="min-w-0 truncate text-[11px]/[14px] whitespace-nowrap">{view.text}</span>}
    </button>
  );
}

/** Thanh trạng thái đồng bộ trên mọi màn chính (thanh tiêu đề Windows, thanh trên web, đầu trang điện thoại). */
export function SyncBadge({ surface = 'dark', compact }: { surface?: 'dark' | 'light'; compact?: boolean }) {
  const sync = useDriveSync();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open]);
  if (!sync?.status) return null;
  return (
    <>
      <SyncBadgeView view={syncView(sync.status)} surface={surface} expanded={open} compact={compact} onClick={() => setOpen((o) => !o)} />
      {open && (
        <>
          <button type="button" aria-label="Đóng bảng đồng bộ" tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <SyncPanel className={cx('fixed right-[12px] z-[45]', surface === 'dark' ? 'top-[46px]' : 'top-[60px]')} onClose={() => setOpen(false)} />
        </>
      )}
    </>
  );
}

/** PWA: báo đang xem dữ liệu đã lưu khi mất mạng. */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online || isDesktop) return null;
  return (
    <div className="flex items-center gap-2 bg-slate-800 px-4 py-2 text-xs text-white">
      <CloudOff size={14} /> Mất mạng - đang hiện dữ liệu đã tải lần cuối.
    </div>
  );
}
