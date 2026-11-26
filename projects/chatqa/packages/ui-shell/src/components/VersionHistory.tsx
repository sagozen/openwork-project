// Lịch sử phiên bản của một mục (FR-013) + hộp Khôi phục (FR-014). Ngăn kéo lịch sử chưa có khung pen (dựng từ token,
// đã báo designer); hộp Khôi phục theo khung "Hộp Khôi phục (Quản lý)": rộng 500, cảnh báo hổ phách, lý do bắt buộc.
import { useCallback, useEffect, useState } from 'react';
import { History, RotateCcw, X } from 'lucide-react';
import { driveApi, type ItemVersion } from '../sync/drive-api';
import { currentRev, driveCopy, driveErrorText, originLabel, replacedBy, restoreAccess, restoreProblem, sortVersions, versionChanges, vnClock } from '../sync/sync-view';
import { useAction } from '../lib/use-action';
import { fieldLabel } from './ConflictDialog';
import { Banner, Button, Dialog } from './ui';
import { cx } from './ui/cx';

const ORIGIN_TONE: Record<string, string> = {
  restore: 'bg-accent-soft text-accent',
  conflict_lost: 'bg-red-soft text-red',
  remove: 'bg-chip-neutral text-text-2',
  undo_remove: 'bg-green-soft text-green',
};

export interface VersionHistoryViewProps {
  title: string;
  versions: ItemVersion[];
  /** Mã người dùng hiện tại (bản của mình luôn khôi phục được). */
  me?: string;
  /** Có quyền lot.restore: khôi phục cả bản người khác tạo. */
  canRestoreOthers: boolean;
  loading?: boolean;
  error?: string;
  onPick: (v: ItemVersion) => void;
  onClose: () => void;
}

/** Ngăn kéo bên phải: bản mới nhất trước, nhãn nguồn gốc, lý do khôi phục; nút Khôi phục hoặc lý do bị tắt (E-012). */
export function VersionHistoryView({ title, versions, me, canRestoreOthers, loading, error, onPick, onClose }: VersionHistoryViewProps) {
  const list = sortVersions(versions);
  const cur = currentRev(versions);
  // Bản trước của mỗi bản (theo số), để hiện "sửa gì".
  const prev = (v: ItemVersion) => list.find((x) => x.rev < v.rev && x.origin !== 'conflict_lost');
  return (
    <aside role="dialog" aria-label="Lịch sử phiên bản" className="fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-full flex-col bg-surface leading-[normal] text-text shadow-dialog">
      <header className="flex h-[64px] shrink-0 items-center gap-[10px] px-[18px] shadow-[inset_0_-1px_0_var(--color-border)]">
        <span className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent">
          <History size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <h2 className="text-[14px]/[18px] font-bold">Lịch sử phiên bản</h2>
          <span className="truncate text-[11.5px]/[15px] text-text-3">{title}</span>
        </div>
        <button type="button" aria-label="Đóng" onClick={onClose} className="text-text-3">
          <X size={18} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && <Banner tone="red" className="m-[14px] w-auto">{error}</Banner>}
        {loading && !error && list.length === 0 && <p className="px-[18px] py-[40px] text-center text-[13px]/[18px] text-text-3">Đang tải...</p>}
        {!loading && !error && list.length <= 1 && <p className="px-[18px] py-[40px] text-center text-[13px]/[18px] text-text-3">Chưa có phiên bản cũ</p>}
        {list.length > 1 &&
          list.map((v) => {
            const access = restoreAccess(v, v.rev === cur, me, canRestoreOthers);
            const p = prev(v);
            const changes = p ? versionChanges(p.content, v.content).map((k) => fieldLabel(v.kind, k)) : [];
            return (
              <div key={`${v.rev}-${v.opId}`} data-rev={v.rev} className="flex flex-col gap-[4px] px-[18px] py-[11px] shadow-[inset_0_-1px_0_var(--color-divider)]">
                <div className="flex items-center gap-[6px]">
                  <span className="text-[12px]/[15px] font-bold">v{v.rev}</span>
                  <span className={cx('rounded-[4px] px-[6px] py-px text-[10px]/[13px] font-bold whitespace-nowrap', ORIGIN_TONE[v.origin] ?? 'bg-blue-soft text-blue')}>{originLabel(v.origin)}</span>
                  {v.rev === cur && <span className="text-[10.5px]/[13px] font-semibold text-green">bản hiện hành</span>}
                  <span className="flex-1" />
                  {access && (
                    <Button size="xs" variant="secondary" icon={<RotateCcw size={12} />} disabled={!access.allowed} title={access.hint ? driveCopy(access.hint) : undefined} onClick={() => onPick(v)}>
                      Khôi phục
                    </Button>
                  )}
                </div>
                <span className="text-[11px]/[14px] text-text-3">
                  {v.actorName || v.actorUserId} · {vnClock(v.at)}
                </span>
                {changes.length > 0 && <span className="text-[11px]/[15px] text-text-2">Đổi: {changes.join(', ')}</span>}
                {v.origin === 'restore' && v.reason && <span className="text-[11px]/[15px] text-text-2">Lý do: {v.reason}</span>}
                {access?.hint && <span className="text-[10.5px]/[14px] text-text-3">{driveCopy(access.hint)}</span>}
              </div>
            );
          })}
      </div>
    </aside>
  );
}

export interface RestoreDialogProps {
  version: ItemVersion;
  /** Bản mới hơn của người khác sẽ bị thay (cảnh báo trước khi khôi phục). */
  replaces: { name: string; at: number } | null;
  reason: string;
  onReason: (v: string) => void;
  /** Đã bấm Khôi phục mà lý do rỗng. */
  showProblem?: boolean;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
  overlay?: boolean;
}

export function RestoreDialog({ version, replaces, reason, onReason, showProblem, busy, error, onCancel, onConfirm, overlay }: RestoreDialogProps) {
  const problem = showProblem ? restoreProblem(reason) : null;
  return (
    <Dialog
      width={500}
      gap={14}
      overlay={overlay}
      icon={<RotateCcw size={18} />}
      title={`Khôi phục v${version.rev}?`}
      subtitle={`Nội dung v${version.rev} sẽ được lưu thành bản mới và trở thành bản hiện hành. Các bản sau vẫn còn trong lịch sử.`}
      onClose={busy ? undefined : onCancel}
      actions={
        <>
          <Button size="dialog" variant="secondary" disabled={busy} onClick={onCancel}>
            Huỷ
          </Button>
          <Button size="dialog" loading={busy} onClick={onConfirm}>
            {busy ? 'Đang khôi phục…' : `Khôi phục v${version.rev}`}
          </Button>
        </>
      }
    >
      {replaces && <Banner tone="amber">{driveCopy('restore_replaces', { name: replaces.name, at: replaces.at })}</Banner>}
      <label className="flex flex-col gap-[6px]">
        <span className="text-[12px]/[15px] font-semibold text-text">
          Lý do khôi phục <span className="font-bold text-red">*</span>
        </span>
        <textarea
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          rows={3}
          aria-invalid={!!problem}
          className={cx('stroke-in min-h-[64px] w-full resize-y rounded-[8px] bg-surface px-[12px] py-[9px] text-[12px]/[17px] text-text outline-none', problem ? '[--stroke-c:var(--color-red)]' : 'focus:[--stroke-c:var(--color-accent)]')}
        />
        <span className={cx('text-[11px]/[14px]', problem ? 'font-semibold text-red' : 'text-text-3')}>{problem ? driveCopy(problem) : 'Bắt buộc. Lý do ghi vào lịch sử phiên bản.'}</span>
      </label>
      {error && <Banner tone="red">{error}</Banner>}
    </Dialog>
  );
}

/** Lịch sử + khôi phục gắn với drive.Service. Khôi phục xong thì gọi onRestored để màn tải lại mục. */
export function VersionHistory({ kind, itemId, title, me, canRestoreOthers, onClose, onRestored }: { kind: string; itemId: string; title: string; me?: string; canRestoreOthers: boolean; onClose: () => void; onRestored?: () => void }) {
  const [versions, setVersions] = useState<ItemVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<ItemVersion | null>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [replaces, setReplaces] = useState<{ name: string; at: number } | null>(null);
  /** Go đã trả cảnh báo thay bản của người khác: lần bấm sau là xác nhận. */
  const [confirming, setConfirming] = useState(false);
  const [restoreError, setRestoreError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setVersions(await driveApi.listVersions(kind, itemId));
      setError('');
    } catch (e) {
      setError(driveErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [kind, itemId]);
  useEffect(() => void load(), [load]);

  function pick(v: ItemVersion) {
    const r = replacedBy(versions, v, me);
    setPicked(v);
    setReason('');
    setTried(false);
    setConfirming(false);
    setRestoreError('');
    setReplaces(r ? { name: r.actorName || r.actorUserId, at: r.at } : null);
  }

  // Khôi phục chỉ gửi một lần; đang gửi thì không đóng hộp / ngăn kéo (kết quả hoặc lỗi phải hiện được).
  const [confirm, busy] = useAction(async () => {
    if (!picked) return;
    setTried(true);
    if (restoreProblem(reason)) return;
    setRestoreError('');
    try {
      const res = await driveApi.restore({ kind, id: itemId, rev: picked.rev, opId: picked.opId, reason: reason.trim(), confirm: confirming || !!replaces });
      if (!res.restored && res.replaces) {
        // Lịch sử trên máy chưa thấy bản đó: hiện cảnh báo, bấm lần nữa mới khôi phục.
        setReplaces(res.replaces);
        setConfirming(true);
        return;
      }
      setPicked(null);
      await load();
      onRestored?.();
    } catch (e) {
      setRestoreError(driveErrorText(e));
    }
  });
  const close = () => !busy && onClose();

  return (
    <>
      <button type="button" aria-label="Đóng lịch sử" tabIndex={-1} className="fixed inset-0 z-40 cursor-default bg-overlay" onClick={close} />
      <VersionHistoryView title={title} versions={versions} me={me} canRestoreOthers={canRestoreOthers} loading={loading} error={error} onPick={pick} onClose={close} />
      {picked && (
        <RestoreDialog
          version={picked}
          replaces={replaces}
          reason={reason}
          onReason={setReason}
          showProblem={tried}
          busy={busy}
          error={restoreError}
          onCancel={() => setPicked(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </>
  );
}
