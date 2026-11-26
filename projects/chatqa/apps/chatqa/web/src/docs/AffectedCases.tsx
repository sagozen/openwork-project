// Khối "Ca bị ảnh hưởng": ca có yêu cầu đã sửa hoặc bị xoá từ lần sinh/xác nhận gần nhất. Sinh lại chỉ gọi AI cho các yêu
// cầu đã đổi (giữ mã TC-… của ca); "Đã xem, giữ nguyên" xác nhận ca vẫn đúng mà không gọi AI.
import { Check, RefreshCw } from 'lucide-react';
import { Button } from '@shell/components/ui';
import { Card, Muted } from '../chat/components/shared';
import type { AffectedCase } from '../testing/bridge';
import { regenReqs } from './docs-api';

export function AffectedCases({
  cases,
  busy,
  onRegenerate,
  onAck,
}: {
  cases: AffectedCase[];
  /** Ca đang xác nhận (khoá nút của ca đó). */
  busy?: string;
  /** Không có (thiếu quyền chạy flow) = không hiện nút. */
  onRegenerate?: (reqs: string[]) => void;
  onAck?: (caseId: string) => void;
}) {
  if (cases.length === 0) return null;
  const reqs = regenReqs(cases);
  return (
    <Card
      title={`Ca bị ảnh hưởng · ${cases.length}`}
      tone="warn"
      aside={
        onRegenerate &&
        reqs.length > 0 && (
          <Button size="xs" icon={<RefreshCw size={13} />} onClick={() => onRegenerate(reqs)}>
            Sinh lại ca bị ảnh hưởng
          </Button>
        )
      }
    >
      <Muted>Các ca dưới đây nối với yêu cầu vừa sửa hoặc đã xoá. Sinh lại chỉ gọi AI cho các yêu cầu đã đổi; ca vẫn đúng thì bấm “Đã xem, giữ nguyên”.</Muted>
      <ul data-testid="affected-cases">
        {cases.map((c) => (
          <li key={c.caseId} className="flex flex-wrap items-center gap-[8px] border-t border-divider py-[6px] text-[12px]/[16px] first:border-t-0">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-text">{c.title || c.caseId}</span>
              <span className="block truncate font-mono text-[11px]/[14px] text-text-3">
                {c.caseId}
                {c.flow ? ` · ${c.flow}` : ''}
              </span>
            </span>
            {c.reqs.length > 0 && <span className="font-mono text-[11px]/[14px] text-amber">đã sửa {c.reqs.join(', ')}</span>}
            {(c.removed ?? []).length > 0 && <span className="font-mono text-[11px]/[14px] text-red">đã xoá {(c.removed ?? []).join(', ')}</span>}
            {onAck && (
              <Button size="xs" variant="secondary" disabled={busy === c.caseId} icon={<Check size={13} />} onClick={() => onAck(c.caseId)}>
                Đã xem, giữ nguyên
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
