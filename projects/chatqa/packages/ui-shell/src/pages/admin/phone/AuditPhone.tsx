import { ArrowRight } from 'lucide-react';
import { Tag } from '../../../components/ui';
import type { AuditRow } from '../audit-format';
import { Dropdown } from '../parts';
import { PhoneFilter } from './parts';

type Opt<K extends string> = { key: K; label: string }[];

/** Ô lọc nhật ký trên điện thoại (aU3zY): chỉ hiện giá trị, cao 30, chữ 11.5. */
function Chip<K extends string>({ options, value, onChange, empty }: { options: Opt<K>; value: K; onChange: (k: K) => void; empty: string }) {
  const cur = options.find((o) => o.key === value);
  return <Dropdown align="left" options={options} value={value} onChange={onChange} trigger={(_, toggle) => <PhoneFilter value={!cur || cur.label === 'Tất cả' ? empty : cur.label} onClick={toggle} compact />} />;
}

export interface AuditPhoneProps {
  rows: AuditRow[];
  persons: Opt<string>;
  actions: Opt<string>;
  ranges: Opt<string>;
  user: string;
  action: string;
  range: string;
  rangeLabel: string;
  onUser: (k: string) => void;
  onAction: (k: string) => void;
  onRange: (k: string) => void;
  page: number;
  pages: number;
  onPage: (n: number) => void;
  /** Đang tải trang / bộ lọc mới (chưa có dòng nào thì hiện "Đang tải..." thay vì "Không có thao tác"). */
  loading?: boolean;
}

/** Nhật ký quản trị trên điện thoại (aU3zY): mỗi dòng một thẻ, Trước → Sau. Chỉ xem. */
export function AuditPhone(p: AuditPhoneProps) {
  return (
    <>
      <div className="flex w-full gap-[6px]">
        <Chip options={p.persons} value={p.user} onChange={p.onUser} empty="Người" />
        <Chip options={p.actions} value={p.action} onChange={p.onAction} empty="Thao tác" />
        <PhoneRange options={p.ranges} value={p.range} label={p.rangeLabel} onChange={p.onRange} />
      </div>
      {p.rows.map((r) => (
        <div key={r.id} className="stroke-in flex w-full flex-col gap-[5px] rounded-[12px] bg-surface px-[14px] py-[11px] leading-[normal]">
          <div className="flex items-center">
            <span className="min-w-0 flex-1 text-[13px] font-bold">{r.action}</span>
            <span className="font-mono text-[11px] text-text-3">{r.time}</span>
          </div>
          <div className="flex items-center gap-[6px]">
            <span className="text-[12px] text-text-2">{r.actor.name}</span>
            {r.actor.deployer && <Tag kind="deployer" />}
            {r.actor.locked && !r.actor.deployer && <Tag kind="locked" />}
            {r.actor.outside && <span className="inline-flex h-[13px] items-center rounded-[4px] bg-text px-[5px] text-[9px] font-semibold text-white">Ngoài app</span>}
            <span className="min-w-0 truncate font-mono text-[11px] text-text-3">→ {r.object.text}</span>
          </div>
          <div className="flex items-center gap-[6px]">
            <span className="text-[12px] text-text-3">{r.before}</span>
            <ArrowRight size={12} className="shrink-0 text-text-3" />
            <span className="text-[12px] font-semibold">{r.after}</span>
          </div>
        </div>
      ))}
      {!p.rows.length && <p className="text-[12px] text-text-3">{p.loading ? 'Đang tải...' : 'Không có thao tác nào khớp bộ lọc.'}</p>}
      {p.pages > 1 && (
        <div className="flex items-center justify-center gap-[10px] text-[12px] text-text-2">
          <button type="button" disabled={p.page <= 1} onClick={() => p.onPage(p.page - 1)} className="stroke-in h-[30px] rounded-[8px] bg-surface px-[12px] font-semibold disabled:opacity-50">
            Trang trước
          </button>
          <span>
            {p.page} / {p.pages}
          </span>
          <button type="button" disabled={p.page >= p.pages} onClick={() => p.onPage(p.page + 1)} className="stroke-in h-[30px] rounded-[8px] bg-surface px-[12px] font-semibold disabled:opacity-50">
            Trang sau
          </button>
        </div>
      )}
      <p className="text-[12px] text-text-3">Chỉ xem: không sửa, không xoá.</p>
    </>
  );
}

function PhoneRange({ options, value, label, onChange }: { options: Opt<string>; value: string; label: string; onChange: (k: string) => void }) {
  return <Dropdown align="left" options={options} value={value} onChange={onChange} trigger={(_, toggle) => <PhoneFilter value={label} onClick={toggle} compact />} />;
}
