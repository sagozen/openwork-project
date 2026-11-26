// Hộp duyệt một thao tác của agent (ADK tool confirmation): việc gì, tool nào, tham số (đã che bí mật), hậu quả theo
// mức rủi ro, rồi Đồng ý / Từ chối. Từ chối thì agent làm tiếp mà không chạy tool.
import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { cx } from '@shell/components/ui/cx';
import type { ConfirmMsg } from './state';

const RISK_LABEL: Record<string, string> = {
  read: 'Chỉ đọc',
  run: 'Chạy trên thiết bị',
  write: 'Ghi dữ liệu',
  dangerous: 'Nguy hiểm',
};

const DONE_LABEL: Record<ConfirmMsg['status'], string> = {
  open: '',
  approved: 'Đã đồng ý',
  rejected: 'Đã từ chối',
  closed: 'Đã trả lời hoặc đã bỏ',
};

const LONG_TEXT = 100;

// Phân tích chuỗi tham số JSON thành các dòng đáng xem: bỏ giá trị rỗng (null, "", [], {}) vì không mang thông tin.
// Không phải JSON object (vd. bị cắt giữa chừng) thì trả null để hiện raw.
function parseArgs(raw: string): [string, unknown][] | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return Object.entries(v).filter(([, x]) => {
      if (x === null || x === '') return false;
      if (Array.isArray(x)) return x.length > 0;
      if (typeof x === 'object') return Object.keys(x as object).length > 0;
      return true;
    });
  } catch {
    return null;
  }
}

function ArgValue({ value }: { value: unknown }) {
  const [full, setFull] = useState(false);
  if (typeof value !== 'string' && typeof value !== 'object') return <span className="font-mono">{String(value)}</span>;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const long = text.length > LONG_TEXT || text.includes('\n');
  if (!long) return <span className="break-words">{text}</span>;
  const lines = text.split('\n');
  return (
    <div>
      <pre className={cx('whitespace-pre-wrap break-words rounded-[6px] bg-surface px-[8px] py-[5px] font-mono text-[11.5px]/[16px]', !full && 'line-clamp-3')}>{text}</pre>
      <button type="button" onClick={() => setFull(!full)} className="text-[11.5px] text-accent hover:underline">
        {full ? 'Thu gọn' : `Xem đầy đủ (${lines.length} dòng)`}
      </button>
    </div>
  );
}

function ArgsView({ raw }: { raw: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const rows = parseArgs(raw);
  return (
    <div data-testid="confirm-args">
      {rows && !showRaw ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-[8px] gap-y-[3px] text-text-2">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-3">{k}</dt>
              <dd className="min-w-0 text-text">
                <ArgValue value={v} />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap break-all font-mono text-text-2" data-testid="confirm-args-raw">{raw}</pre>
      )}
      {rows && (
        <button type="button" onClick={() => setShowRaw(!showRaw)} className="mt-[3px] text-[11.5px] text-accent hover:underline">
          {showRaw ? 'Ẩn raw' : 'Xem raw'}
        </button>
      )}
    </div>
  );
}

export function ConfirmDialog({ msg, disabled, onAnswer }: { msg: ConfirmMsg; disabled?: boolean; onAnswer: (approved: boolean) => void }) {
  const open = msg.status === 'open';
  const titleId = `confirm-${msg.id}`;
  return (
    <section
      role={open ? 'alertdialog' : 'group'}
      aria-labelledby={titleId}
      data-testid="confirm-dialog"
      data-status={msg.status}
      className={cx('flex max-w-[90%] flex-col gap-[6px] rounded-[10px] border px-[12px] py-[10px]', open ? 'border-amber bg-amber-soft' : 'border-border bg-muted-box')}
    >
      <h3 id={titleId} className="flex items-center gap-[6px] text-[13px]/[18px] font-semibold text-text">
        <ShieldAlert size={15} className={open ? 'text-amber' : 'text-text-3'} aria-hidden />
        {open ? 'Cần duyệt trước khi chạy' : `Yêu cầu duyệt · ${DONE_LABEL[msg.status]}`}
      </h3>
      {msg.text && <p className="whitespace-pre-wrap text-[12.5px]/[17px] text-text">{msg.text}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-[8px] gap-y-[3px] text-[12px]/[16px]">
        <dt className="text-text-3">Tool</dt>
        <dd className="font-mono text-text">{msg.tool || '?'}</dd>
        {msg.args && (
          <>
            <dt className="text-text-3">Tham số</dt>
            <dd className="min-w-0">
              <ArgsView raw={msg.args} />
            </dd>
          </>
        )}
        {(msg.risk || msg.consequence) && (
          <>
            <dt className="text-text-3">Hậu quả</dt>
            <dd className="text-text-2">
              {msg.risk && <span className="mr-[6px] rounded-[4px] bg-surface px-[5px] font-semibold">{RISK_LABEL[msg.risk] ?? msg.risk}</span>}
              {msg.consequence}
            </dd>
          </>
        )}
      </dl>
      {open && (
        <div className="flex gap-[8px] pt-[2px]">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAnswer(true)}
            className="rounded-[7px] bg-accent px-[12px] py-[4px] text-[12.5px]/[17px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Đồng ý
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAnswer(false)}
            className="rounded-[7px] border border-border bg-surface px-[12px] py-[4px] text-[12.5px]/[17px] font-semibold text-text disabled:cursor-not-allowed disabled:opacity-60"
          >
            Từ chối
          </button>
        </div>
      )}
    </section>
  );
}
