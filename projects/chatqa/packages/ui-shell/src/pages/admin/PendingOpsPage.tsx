import { useEffect, useRef, useState } from 'react';
import { Check, CircleArrowDown, Loader2, Lock, Monitor, WifiOff } from 'lucide-react';
import { Avatar } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import { adminApi, type AdminUser, type PendingOp } from './admin-api';
import { toAdminError, writeOnline } from './admin-error';
import { useAdmin, usePhoneLayout } from './admin-context';
import { fmtShort } from './format';
import { AdminPage, avatarTone, ErrorBanner } from './parts';
import { PendingPhone } from './phone/PendingPhone';
import { PhoneAdminPage } from './phone/parts';
import { afterDecision, isAlreadyDecided, oldestText, opText, pendingTitle, reasonText, type Decision } from './pending-format';
import { useResource } from './use-resource';

const HEAD = 'text-[9px]/[11px] font-bold tracking-[0.5px] text-text-3';
const REASON_ICON = { demoted: <CircleArrowDown size={13} className="text-amber" />, locked: <Lock size={13} className="text-amber" />, device: <Monitor size={13} className="text-amber" /> };

export default function PendingOpsPage() {
  const { setPending } = useAdmin();
  const phone = usePhoneLayout();
  const res = useResource(async () => {
    const [ops, users] = await Promise.all([adminApi.pendingOps('pending'), adminApi.users().catch(() => [] as AdminUser[])]);
    return { ops, users };
  });
  const [error, setError] = useState<unknown>(null);
  // Thao tác đang được quyết (id -> Bỏ / Công nhận). Nhiều dòng quyết song song được; một dòng chỉ gửi một lần.
  // Ref chặn hai cú bấm rơi vào cùng một khung hình, state để vẽ nút.
  const [busy, setBusy] = useState<Record<string, Decision>>({});
  const inFlight = useRef(new Set<string>());
  const ops = res.data?.ops ?? [];

  useEffect(() => {
    if (res.data) setPending(res.data.ops.length);
  }, [res.data, setPending]);

  async function decide(op: PendingOp, decision: Decision) {
    if (inFlight.current.has(op.id)) return;
    inFlight.current.add(op.id);
    setBusy((b) => ({ ...b, [op.id]: decision }));
    setError(null);
    try {
      await writeOnline(() => adminApi.decidePending(op.id, decision));
      res.set((cur) => (cur ? { ...cur, ops: afterDecision(cur.ops, op.id) } : cur));
    } catch (e) {
      // Người khác vừa quyết xong: dòng này không còn chờ nữa, bỏ khỏi danh sách.
      if (isAlreadyDecided(e)) res.set((cur) => (cur ? { ...cur, ops: afterDecision(cur.ops, op.id) } : cur));
      else setError(toAdminError(e));
    } finally {
      inFlight.current.delete(op.id);
      setBusy(({ [op.id]: _done, ...rest }) => rest);
    }
  }

  if (phone) {
    return (
      <PhoneAdminPage title="Chờ công nhận" error={res.error ?? error}>
        {!res.data && res.loading && <p className="py-16 text-center text-sm text-text-3">Đang tải...</p>}
        {res.data && <PendingPhone ops={ops} busy={busy} onDecide={(op, d) => void decide(op, d)} />}
      </PhoneAdminPage>
    );
  }

  return (
    <AdminPage tab="pending" crumb="Cài đặt › Chờ công nhận · chỉ Admin" title="Thao tác chờ admin công nhận">
      <ErrorBanner error={res.error ?? error} />
      {!res.data && res.loading && <p className="py-16 text-center text-sm text-text-3">Đang tải...</p>}
      {res.data && (
        <>
          <div className="stroke-in flex w-full gap-[10px] rounded-[10px] bg-amber-soft px-[14px] py-[12px] [--stroke-c:var(--color-line-amber)]">
            <WifiOff size={16} className="mt-[1.5px] shrink-0 text-amber" />
            <p className="min-w-0 flex-1 text-[12.5px]/[19px] text-[#7C3A06]">
              Đây là các thao tác ghi trên máy khi mất mạng, của tài khoản bị khoá hoặc hạ quyền trong lúc máy mất mạng. Các thao tác này chưa áp vào dữ liệu chung cho tới khi admin Công nhận. Bỏ thì thao tác không được áp và người làm nhận thông báo ở lần kết nối tới.
            </p>
          </div>
          <div className="stroke-in flex w-full flex-col overflow-hidden rounded-[12px] bg-surface">
            <div className="flex h-[40px] items-center gap-[8px] px-[18px] py-[12px] shadow-[inset_0_-1px_0_var(--color-border)]">
              <span className="min-w-0 flex-1 text-[13px] font-bold text-text">{pendingTitle(ops.length)}</span>
              {ops.length > 0 && <span className="text-[11.5px] whitespace-nowrap text-text-3">{oldestText(ops)}</span>}
            </div>
            <div className="flex h-[29px] items-center gap-[14px] bg-table-head px-[18px] py-[9px] shadow-[inset_0_-1px_0_var(--color-border)]">
              <span className={cx('w-[170px] shrink-0', HEAD)}>NGƯỜI</span>
              <span className={cx('w-[120px] shrink-0', HEAD)}>MÁY</span>
              <span className={cx('min-w-0 flex-1', HEAD)}>THAO TÁC</span>
              <span className={cx('w-[120px] shrink-0', HEAD)}>GIỜ GHI TRÊN MÁY</span>
              <span className={cx('w-[260px] shrink-0', HEAD)}>LÝ DO CHỜ</span>
              <span className="w-[170px] shrink-0" />
            </div>
            {ops.map((op) => {
              const user = res.data!.users.find((u) => u.id === op.user_id);
              const name = op.user_name ?? user?.display_name ?? '—';
              const act = opText(op.op);
              const why = reasonText(op.reason);
              return (
                <div key={op.id} className="flex items-center gap-[14px] px-[18px] py-[12px] shadow-[inset_0_-1px_0_var(--color-divider)]">
                  <div className="flex w-[170px] shrink-0 items-center gap-[8px]">
                    <Avatar initials={name.split(/\s+/).slice(-2).map((w) => w[0]).join('').toUpperCase()} tone={op.user_locked ? 'locked' : user ? avatarTone(user) : 'staff'} size={26} />
                    <div className="flex min-w-0 flex-col gap-px">
                      <span className="truncate text-[12.5px] font-semibold whitespace-nowrap text-text">{name}</span>
                      {op.user_locked && <span className="text-[10.5px] whitespace-nowrap text-text-3">Đã khoá</span>}
                    </div>
                  </div>
                  <span className="w-[120px] shrink-0 truncate font-mono text-[11.5px] text-text-2">{op.device_name ?? '—'}</span>
                  <div className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="text-[12.5px] font-semibold whitespace-nowrap text-text">{act.name}</span>
                    {act.object && <span className="text-[11px] whitespace-nowrap text-text-3">{act.object}</span>}
                  </div>
                  <span className="w-[120px] shrink-0 font-mono text-[11.5px] text-text-2">{fmtShort(op.device_time)}</span>
                  <div className="flex w-[260px] shrink-0 gap-[6px]">
                    <span className="mt-[1.5px] flex shrink-0">{REASON_ICON[why.icon]}</span>
                    <span className="min-w-0 flex-1 text-[11.5px]/[16px] text-text-2">{why.text}</span>
                  </div>
                  <div className="flex w-[170px] shrink-0 justify-end gap-[8px]">
                    <button type="button" disabled={!!busy[op.id]} aria-busy={busy[op.id] === 'drop' || undefined} onClick={() => void decide(op, 'drop')} className="stroke-in flex h-[30px] items-center rounded-[7px] bg-surface px-[12px] text-[12px] font-semibold whitespace-nowrap text-text disabled:opacity-50">
                      {busy[op.id] === 'drop' ? 'Đang bỏ…' : 'Bỏ'}
                    </button>
                    <button type="button" disabled={!!busy[op.id]} aria-busy={busy[op.id] === 'accept' || undefined} onClick={() => void decide(op, 'accept')} className="flex h-[30px] items-center gap-[5px] rounded-[7px] bg-green px-[12px] text-[12px] font-semibold whitespace-nowrap text-white disabled:opacity-50">
                      {busy[op.id] === 'accept' ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} />}
                      {busy[op.id] === 'accept' ? 'Đang công nhận…' : 'Công nhận'}
                    </button>
                  </div>
                </div>
              );
            })}
            {!ops.length && <p className="px-[18px] py-[18px] text-[12px] text-text-3">Không có thao tác nào cần công nhận.</p>}
          </div>
        </>
      )}
    </AdminPage>
  );
}
