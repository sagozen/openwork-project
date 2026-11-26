// Bước cần người của pipeline (RequestInput), hai dạng:
// - bước duyệt: danh sách flow tạo/đổi dữ liệu để tick, các flow vẫn chạy, ghi chú, rồi gửi {approved_flows, note};
// - bước lưu trí nhớ: các mục Triage đề xuất (lỗi đã biết) để tick, rồi gửi {approved_memories, note}.
// Mặc định không tick gì: chỉ chạy flow hay lưu mục người duyệt chọn.
import { useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { cx } from '@shell/components/ui/cx';
import type { RequestMsg } from './state';

export type ApprovalAnswer = { approved_flows: string[]; note?: string } | { approved_memories: string[]; note?: string };

/** Yêu cầu là bước lưu trí nhớ (có mục đề xuất, không có flow). */
export const isMemoryRequest = (msg: RequestMsg) => (msg.payload?.memories.length ?? 0) > 0 && (msg.payload?.flows.length ?? 0) === 0;

/** Câu trả lời gửi về Go: chỉ giữ các mã có trong yêu cầu, ghi chú rỗng thì bỏ. */
export function approvalAnswer(msg: RequestMsg, picked: string[], note: string): ApprovalAnswer {
  const memory = isMemoryRequest(msg);
  const keys = new Set(memory ? (msg.payload?.memories ?? []).map((m) => m.key) : (msg.payload?.flows ?? []).map((f) => f.key));
  const kept = picked.filter((k) => keys.has(k));
  const out: ApprovalAnswer = memory ? { approved_memories: kept } : { approved_flows: kept };
  if (note.trim()) out.note = note.trim();
  return out;
}

const DONE_LABEL: Record<RequestMsg['status'], string> = { open: '', answered: 'Đã gửi câu trả lời', closed: 'Đã trả lời' };

export function ApprovalForm({ msg, disabled, onSubmit }: { msg: RequestMsg; disabled?: boolean; onSubmit: (answer: ApprovalAnswer) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const open = msg.status === 'open';
  const memory = isMemoryRequest(msg);
  const flows = msg.payload?.flows ?? [];
  const memories = msg.payload?.memories ?? [];
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const titleId = `approval-${msg.id}`;
  return (
    <form
      aria-labelledby={titleId}
      data-testid="approval-form"
      data-status={msg.status}
      onSubmit={(e) => {
        e.preventDefault();
        if (open) onSubmit(approvalAnswer(msg, picked, note));
      }}
      className={cx('flex max-w-[90%] flex-col gap-[6px] rounded-[10px] border px-[12px] py-[10px]', open ? 'border-amber bg-amber-soft' : 'border-border bg-muted-box')}
    >
      <h3 id={titleId} className="flex items-center gap-[6px] text-[13px]/[18px] font-semibold text-text">
        <ClipboardCheck size={15} className={open ? 'text-amber' : 'text-text-3'} aria-hidden />
        {open ? (memory ? 'Pipeline chờ duyệt lưu trí nhớ' : 'Pipeline chờ duyệt') : `${memory ? 'Lưu trí nhớ' : 'Bước duyệt'} · ${DONE_LABEL[msg.status]}`}
      </h3>
      {msg.text && <p className="whitespace-pre-wrap text-[12.5px]/[17px] text-text">{msg.text}</p>}
      {flows.length > 0 && (
        <fieldset disabled={!open || disabled} className="flex flex-col gap-[3px]">
          <legend className="mb-[2px] text-[12px]/[16px] text-text-3">Flow tạo hoặc đổi dữ liệu: chọn flow được chạy</legend>
          {flows.map((f) => (
            <label key={f.key} className="flex items-start gap-[6px] text-[12.5px]/[17px]">
              <input type="checkbox" checked={picked.includes(f.key)} onChange={() => toggle(f.key)} className="mt-[3px]" />
              <span>
                <span className="font-mono">{f.key}</span>
                {f.reason && <span className="text-text-3"> · {f.reason}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {memory && (
        <fieldset disabled={!open || disabled} className="flex flex-col gap-[3px]">
          <legend className="mb-[2px] text-[12px]/[16px] text-text-3">Triage đề xuất lưu: chọn mục được lưu vào trí nhớ QA</legend>
          {memories.map((m) => (
            <label key={m.key} className="flex items-start gap-[6px] text-[12.5px]/[17px]">
              <input type="checkbox" checked={picked.includes(m.key)} onChange={() => toggle(m.key)} className="mt-[3px]" />
              <span>{m.text}</span>
            </label>
          ))}
        </fieldset>
      )}
      {(msg.payload?.others.length ?? 0) > 0 && (
        <p className="text-[12px]/[16px] text-text-3" data-testid="approval-others">
          Vẫn chạy (không đổi dữ liệu): {msg.payload?.others.join(', ')}
        </p>
      )}
      {open && (
        <>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={disabled}
            aria-label="Ghi chú cho lần duyệt"
            placeholder="Ghi chú (không bắt buộc)"
            className="rounded-[6px] border border-border bg-surface px-[8px] py-[4px] text-[12.5px]/[17px]"
          />
          <div className="flex gap-[8px] pt-[2px]">
            <button
              type="submit"
              disabled={disabled}
              className="rounded-[7px] bg-accent px-[12px] py-[4px] text-[12.5px]/[17px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {memory
                ? picked.length > 0
                  ? `Lưu ${picked.length} mục đã chọn`
                  : 'Không lưu mục nào'
                : picked.length > 0
                  ? `Chạy ${picked.length} flow đã chọn`
                  : 'Không chạy flow dữ liệu'}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
