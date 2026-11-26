import { useEffect, useMemo, useState } from 'react';
import { Check, EyeOff, GitCompareArrows, Info, Lock, RefreshCw, RotateCcw, ToggleRight } from 'lucide-react';
import { Button, Dialog } from '../../components/ui';
import { adminApi } from './admin-api';
import { adminErrorText, toAdminError, writeOnline } from './admin-error';
import { demoFlag, demoState } from '../../lib/demo';
import { useAction } from '../../lib/use-action';
import { MATRIX_FOOTNOTE, MATRIX_PRODUCT, matrixColumns } from './matrix-copy';
import { PRODUCT } from '@product/product';
import { changesOf, draftFrom, isLocked, saveBody, toggled, type Cells } from './matrix-draft';
import { usePhoneLayout } from './admin-context';
import { AdminPage, ErrorBanner } from './parts';
import { MatrixCard } from './MatrixCard';
import { MatrixPhone } from './phone/MatrixPhone';
import { PhoneAdminPage } from './phone/parts';
import { useResource } from './use-resource';
import { useUnsavedGuard } from './use-unsaved-guard';

const LEGEND = [
  { icon: <ToggleRight size={13} className="text-green" />, text: 'Công tắc: bật/tắt quyền cho cả vai' },
  { icon: <Lock size={13} />, text: 'Ô khoá: cố định, không đổi được' },
  { icon: <EyeOff size={13} className="text-accent" />, text: 'Vipo không có trong bảng, chỉ có màn Gửi yêu cầu' },
];

export default function RoleMatrixPage() {
  const phone = usePhoneLayout();
  const [role, setRole] = useState<string>(import.meta.env.DEV && demoFlag('role-leader') ? 'leader' : 'manager');
  const res = useResource(() => adminApi.matrix());
  const saved = res.data;
  const [draft, setDraft] = useState<Cells>({});
  const [error, setError] = useState<unknown>(null);
  const [pendingWrite, setPendingWrite] = useState<'save' | 'reset' | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // Bản mới tải về (mở màn, "Tải lại", sau khi lưu) thành bản nháp mới.
  useEffect(() => {
    if (!saved) return;
    let d = draftFrom(saved);
    if (import.meta.env.DEV && !MATRIX_PRODUCT) {
      // chỉ bản dev: trạng thái minh hoạ cho bộ so ảnh (khối này bị loại khi đóng gói)
      const demo = demoState();
      if (demo === 'dirty' || demo === 'conflict') {
        d = toggled(toggled(d, 'leader', 'approve.unlock_item'), 'leader', 'lot.restore');
        if (demo === 'conflict') setError({ code: 'matrix_conflict', params: { by: 'Nguyễn Quốc Bảo', at: Date.UTC(2026, 10, 11, 7, 32) / 1000 } });
      }
    }
    setDraft(d);
  }, [saved]);

  const changes = useMemo(() => (saved && Object.keys(draft).length ? changesOf(saved, draft) : []), [saved, draft]);
  const dirty = useMemo(() => new Set(changes.map((c) => `${c.role}.${c.perm}`)), [changes]);
  const conflict = (error as { code?: string } | null)?.code === 'matrix_conflict';
  const { leave, dialog } = useUnsavedGuard(changes.length > 0, changes.length);

  // Lưu và Về mặc định dùng chung một cờ: lần ghi thứ hai cùng phiên bản sẽ bị máy chủ coi là xung đột (E-023), nên chặn hẳn.
  const [write, busy] = useAction(async (kind: 'save' | 'reset') => {
    if (!saved) return;
    if (kind === 'reset') setConfirmReset(false);
    setPendingWrite(kind);
    setError(null);
    try {
      if (kind === 'save') {
        const body = saveBody(saved, draft);
        res.set(await writeOnline(() => adminApi.saveMatrix(body.version, body.cells)));
      } else {
        res.set(await writeOnline(() => adminApi.resetMatrix(saved.version, MATRIX_PRODUCT)));
      }
    } catch (e) {
      setError(toAdminError(e));
    } finally {
      setPendingWrite(null);
    }
  });
  const save = () => write('save');
  const reset = () => write('reset');
  // Đang lưu thì không cho bật/tắt ô: bản nháp sẽ được thay bằng bản máy chủ trả về.
  const locked = conflict || busy;

  const reload = async () => {
    setError(null);
    await res.reload();
  };

  const resetDialog =
    confirmReset ? (
      <Dialog
        variant="compact"
        tone="amber"
        icon={<RotateCcw size={18} />}
        title="Về bảng quyền mặc định?"
        actions={
          <>
            <Button variant="secondary" size="dialog" onClick={() => setConfirmReset(false)}>
              Hủy
            </Button>
            <Button size="dialog" loading={pendingWrite === 'reset'} onClick={() => void reset()}>
              Về mặc định
            </Button>
          </>
        }
      >
        Mọi ô trả về bảng BR-002 ngay khi bấm và áp cho mọi người cùng vai từ lúc này, máy có mạng nhận trong tối đa 15 phút.
        {MATRIX_PRODUCT ? ` Chỉ quyền của ${PRODUCT.name} trở về mặc định.` : ''}
        {changes.length > 0 ? ` ${changes.length} thay đổi chưa lưu cũng sẽ mất.` : ''}
      </Dialog>
    ) : null;

  if (phone) {
    const setGroup = (r: string, perms: string[], to: boolean) => setDraft((d) => perms.reduce((acc, perm) => (!isLocked(r, perm) && acc[r][perm] !== to ? toggled(acc, r, perm) : acc), d));
    return (
      <PhoneAdminPage title="Bảng quyền theo vai" body="gap-[8px] p-[16px]" error={res.error ?? error}>
        {saved && Object.keys(draft).length > 0 && (
          <>
            <MatrixPhone role={role} onRole={setRole} groups={matrixColumns(draft, MATRIX_PRODUCT).flat()} draft={draft} dirty={dirty} onToggle={(r, perm) => !locked && setDraft((d) => toggled(d, r, perm))} onToggleGroup={(r, perms, to) => !locked && setGroup(r, perms, to)} disabled={locked} />
            <div className="flex gap-[10px]">
              <Button variant="secondary" size="lg" className="flex-1 !h-[44px] !rounded-[10px] !text-[14px]/[18px]" disabled={busy} loading={pendingWrite === 'reset'} onClick={() => setConfirmReset(true)}>
                {pendingWrite === 'reset' ? 'Đang đặt lại…' : 'Về mặc định'}
              </Button>
              <Button size="lg" className="flex-1 !h-[44px] !rounded-[10px] !text-[14px]/[18px] disabled:!bg-accent disabled:!text-white disabled:opacity-[0.45]" disabled={!changes.length || conflict || busy} loading={pendingWrite === 'save'} onClick={() => void save()}>
                {pendingWrite === 'save' ? 'Đang lưu…' : changes.length ? `Lưu (${changes.length})` : 'Lưu'}
              </Button>
            </div>
            {conflict && (
              <Button variant="secondary" loading={res.loading} onClick={() => void reload()} icon={<RefreshCw size={14} />}>
                Tải lại
              </Button>
            )}
          </>
        )}
        {!saved && res.loading && <p className="py-16 text-center text-sm text-text-3">Đang tải...</p>}
        {dialog}
        {resetDialog}
      </PhoneAdminPage>
    );
  }

  return (
    <AdminPage
      tab="matrix"
      onNavigate={leave}
      crumb="Cài đặt › Bảng quyền theo vai · áp cho mọi app"
      title="Bảng quyền theo vai"
      actions={
        <>
          <Button variant="secondary" icon={<RotateCcw size={15} />} disabled={!saved || busy} loading={pendingWrite === 'reset'} onClick={() => setConfirmReset(true)}>
            {pendingWrite === 'reset' ? 'Đang đặt lại…' : 'Về mặc định'}
          </Button>
          <Button icon={<Check size={15} />} disabled={!changes.length || conflict || busy} loading={pendingWrite === 'save'} onClick={() => void save()} className="disabled:!bg-accent disabled:!text-white disabled:opacity-[0.45]">
            {pendingWrite === 'save' ? 'Đang lưu…' : 'Lưu'}
          </Button>
        </>
      }
    >
      <ErrorBanner error={res.error} />
      {!saved && res.loading && <p className="py-16 text-center text-sm text-text-3">Đang tải...</p>}
      {saved && (
        <>
          {conflict ? (
            <div className="stroke-in flex w-full items-center gap-[10px] rounded-[10px] bg-red-soft py-[10px] pr-[10px] pl-[14px] [--stroke-c:var(--color-line-red)]" role="alert">
              <GitCompareArrows size={16} className="shrink-0 text-red" />
              <p className="min-w-0 flex-1 text-[13px] font-semibold text-red">{adminErrorText(error)}</p>
              <button type="button" disabled={res.loading} onClick={() => void reload()} className="flex h-[32px] shrink-0 items-center gap-[6px] rounded-[7px] bg-red px-[12px] text-[12px] font-semibold whitespace-nowrap text-white disabled:opacity-60">
                <RefreshCw size={13} className={res.loading ? 'animate-spin' : undefined} />
                Tải lại
              </button>
            </div>
          ) : (
            <>
              <ErrorBanner error={error} />
              <div className="flex w-full flex-wrap items-center gap-x-[16px] gap-y-[6px]">
                {LEGEND.filter((l) => !MATRIX_PRODUCT || !l.text.startsWith('Vipo')).map((l) => (
                  <span key={l.text} className="flex items-center gap-[6px] text-[12px] whitespace-nowrap text-text-2">
                    <span className="flex text-text-3">{l.icon}</span>
                    {l.text}
                  </span>
                ))}
                <span className="h-px min-w-0 flex-1" />
                {changes.length > 0 && <span className="rounded-[6px] bg-amber-soft px-[9px] py-[4px] text-[11px] font-bold whitespace-nowrap text-amber">{changes.length} thay đổi chưa lưu</span>}
              </div>
            </>
          )}
          <div className="grid min-h-0 w-full flex-1 grid-cols-[repeat(auto-fit,minmax(min(100%,440px),1fr))] content-start items-start gap-[16px]">
            {matrixColumns(draft, MATRIX_PRODUCT).map((groups) => (
              <MatrixCard key={groups[0]} groups={groups} draft={draft} dirty={dirty} onToggle={(role, perm) => !locked && setDraft((d) => toggled(d, role, perm))} />
            ))}
          </div>
          {!conflict && (
            <div className="flex w-full items-center gap-[8px]">
              <Info size={13} className="shrink-0 text-text-3" />
              <p className="text-[12px] text-text-3">{MATRIX_FOOTNOTE}</p>
            </div>
          )}
        </>
      )}
      {dialog}
      {resetDialog}
    </AdminPage>
  );
}
