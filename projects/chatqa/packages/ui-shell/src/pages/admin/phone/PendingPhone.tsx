import { Check, CircleAlert, Loader2, WifiOff } from 'lucide-react';
import type { PendingOp } from '../admin-api';
import { fmtShort } from '../format';
import { opText, reasonText, type Decision } from '../pending-format';
import { PhoneCard } from './parts';

/** Chờ công nhận trên điện thoại (dzwgv): lời giải thích + mỗi thao tác một thẻ với Bỏ / Công nhận. */
export function PendingPhone({ ops, busy, onDecide }: { ops: PendingOp[]; /** Thao tác đang được quyết: id -> Bỏ / Công nhận. */ busy: Partial<Record<string, Decision>>; onDecide: (op: PendingOp, d: Decision) => void }) {
  return (
    <>
      <div className="flex w-full items-start gap-[8px] rounded-[10px] bg-amber-soft p-[12px]">
        <WifiOff size={14} className="mt-[1.5px] shrink-0 text-amber" />
        <p className="min-w-0 flex-1 text-[12px]/[17px] text-[#7C3A06]">Thao tác offline của tài khoản bị khoá hoặc hạ quyền khi máy mất mạng. Chưa áp cho tới khi Công nhận.</p>
      </div>
      {ops.map((op) => {
        const act = opText(op.op);
        const why = reasonText(op.reason);
        return (
          <PhoneCard key={op.id} className="gap-[6px] px-[14px] py-[12px]">
            <div className="flex items-center">
              <span className="min-w-0 flex-1 text-[13.5px] font-bold">{act.name}</span>
              <span className="font-mono text-[11px] text-text-3">{fmtShort(op.device_time)}</span>
            </div>
            <p className="text-[12px] text-text-2">{[op.user_name, op.device_name, act.object].filter(Boolean).join(' · ')}</p>
            <div className="flex gap-[6px]">
              <CircleAlert size={12} className="mt-[2px] shrink-0 text-amber" />
              <span className="min-w-0 flex-1 text-[11.5px] text-amber">{why.text}</span>
            </div>
            <div className="flex gap-[8px] pt-[4px]">
              <button type="button" disabled={!!busy[op.id]} aria-busy={busy[op.id] === 'drop' || undefined} onClick={() => onDecide(op, 'drop')} className="stroke-in flex h-[34px] flex-1 items-center justify-center rounded-[8px] bg-surface text-[12.5px] font-semibold disabled:opacity-50">
                {busy[op.id] === 'drop' ? 'Đang bỏ…' : 'Bỏ'}
              </button>
              <button type="button" disabled={!!busy[op.id]} aria-busy={busy[op.id] === 'accept' || undefined} onClick={() => onDecide(op, 'accept')} className="flex h-[34px] flex-1 items-center justify-center gap-[6px] rounded-[8px] bg-green text-[12.5px] font-semibold text-white disabled:opacity-50">
                {busy[op.id] === 'accept' ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} />}
                {busy[op.id] === 'accept' ? 'Đang công nhận…' : 'Công nhận'}
              </button>
            </div>
          </PhoneCard>
        );
      })}
      {!ops.length && <p className="text-[12px]/[17px] text-text-3">Không có thao tác nào cần công nhận.</p>}
    </>
  );
}
