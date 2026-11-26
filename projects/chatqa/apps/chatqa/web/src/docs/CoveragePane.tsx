// Tab "Độ phủ": mỗi yêu cầu ↔ các ca kiểm chứng nó ↔ kết quả chạy gần nhất của flow từng ca (đạt / lỗi / chưa chạy), nhãn "cần
// xem lại", yêu cầu chưa có ca và ca chưa truy vết. Chọn nhiều yêu cầu rồi "Sinh ca kiểm thử"; sửa tay mã yêu cầu của ca.
// Không phân trang: lọc theo tài liệu và trạng thái.
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Sparkles } from 'lucide-react';
import { Button, Checkbox, cx } from '@shell/components/ui';
import { useToast } from '@shell/components/overlays/ToastHost';
import { Card, Muted } from '../chat/components/shared';
import { testApi, type CaseRef, type Coverage } from '../testing/bridge';
import { caseRunState, COVERAGE_STATUS, docErrorText, filterCoverage, parseReqList, RUN_STATE_LABEL, type CoverageStatus, type RunState } from './docs-api';

const RUN_TONE: Record<RunState, string> = { passed: 'bg-green-soft text-green', failed: 'bg-red-soft text-red', never: 'bg-chip-neutral text-text-2' };
const select = 'stroke-in h-[30px] rounded-[6px] bg-surface px-[8px] text-[12px]/[15px] text-text';

/** Mã yêu cầu hiện có của ca (từ các dòng của ma trận). */
export const caseReqs = (cov: Pick<Coverage, 'reqs'>, caseId: string) => cov.reqs.filter((r) => r.cases.some((c) => c.id === caseId)).map((r) => r.id);

function RunBadge({ c }: { c: CaseRef }) {
  const s = caseRunState(c);
  return (
    <span className={cx('shrink-0 rounded-[5px] px-[6px] py-px text-[10.5px]/[14px] font-semibold', RUN_TONE[s])} data-run={s} title={c.last ? `lượt ${c.last.runId}` : undefined}>
      {RUN_STATE_LABEL[s]}
    </span>
  );
}

/** Một ca: tiêu đề, mã, flow, nhãn cần xem lại, kết quả gần nhất; sửa mã yêu cầu ngay trên dòng. */
function CaseLine({
  c,
  reqs,
  editing,
  onEdit,
  onSave,
  onCancel,
}: {
  c: CaseRef;
  reqs: string[];
  editing?: boolean;
  onEdit?: () => void;
  onSave?: (reqs: string[]) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(reqs.join(', '));
  return (
    <div className="flex flex-col gap-[4px] py-[3px]" data-testid="coverage-case">
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="min-w-0 flex-1 truncate text-text" title={c.title}>
          {c.title || c.id}
        </span>
        {c.stale && <span className="shrink-0 rounded-[5px] bg-amber-soft px-[6px] py-px text-[10.5px]/[14px] font-semibold text-amber">cần xem lại</span>}
        <RunBadge c={c} />
        {onEdit && !editing && (
          <Button size="xs" variant="secondary" icon={<Pencil size={12} />} onClick={onEdit}>
            Sửa mã
          </Button>
        )}
      </div>
      <span className="truncate font-mono text-[11px]/[14px] text-text-3">
        {c.id}
        {c.flow ? ` · ${c.flow}` : ' · chưa có flow'}
      </span>
      {editing && (
        <div className="flex flex-wrap items-center gap-[6px]">
          <input
            aria-label={`Mã yêu cầu của ca ${c.id}`}
            className={cx(select, 'min-w-[200px] flex-1 font-mono')}
            placeholder="REQ-012, AC-03 (để trống = bỏ truy vết)"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button size="xs" onClick={() => onSave?.(parseReqList(text))}>
            Lưu
          </Button>
          <Button size="xs" variant="secondary" onClick={onCancel}>
            Huỷ
          </Button>
        </div>
      )}
    </div>
  );
}

export interface CoverageViewProps {
  cov: Coverage;
  docFilter?: string;
  statusFilter?: CoverageStatus;
  onFilter?: (doc: string, status: CoverageStatus) => void;
  /** Mã yêu cầu đang chọn để sinh ca. */
  selected?: string[];
  onToggle?: (req: string, on: boolean) => void;
  /** Không có (thiếu quyền chạy flow) = không hiện chọn/sinh/sửa. */
  onGenerate?: (reqs: string[]) => void;
  /** Dòng ca đang sửa mã (khoá "yêu cầu/ca", hoặc mã ca ở phần chưa truy vết): một ca có thể nằm dưới nhiều yêu cầu. */
  editing?: string;
  onEdit?: (lineKey: string) => void;
  onSaveReqs?: (caseId: string, reqs: string[]) => void;
  onCancelEdit?: () => void;
}

export function CoverageView({
  cov,
  docFilter = '',
  statusFilter = '',
  onFilter,
  selected = [],
  onToggle,
  onGenerate,
  editing,
  onEdit,
  onSaveReqs,
  onCancelEdit,
}: CoverageViewProps) {
  const docs = [...new Set(cov.reqs.map((r) => r.doc))].sort();
  const rows = filterCoverage(cov.reqs, docFilter, statusFilter);
  const editable = !!onGenerate;
  const caseLine = (c: CaseRef, key: string) => (
    <CaseLine
      key={key}
      c={c}
      reqs={caseReqs(cov, c.id)}
      editing={editing === key}
      onEdit={editable && onEdit ? () => onEdit(key) : undefined}
      onSave={(reqs) => onSaveReqs?.(c.id, reqs)}
      onCancel={onCancelEdit}
    />
  );
  const noCase = cov.reqs.filter((r) => r.cases.length === 0).length;
  return (
    <div className="flex flex-col gap-[10px]" data-testid="coverage">
      {cov.duplicates.length > 0 && (
        <Card title="Mã yêu cầu bị trùng" tone="warn">
          <Muted>
            Các mã <span className="font-mono">{cov.duplicates.join(', ')}</span> có ở nhiều tài liệu; không sinh ca được cho các mã này tới khi đổi mã ở một bên.
          </Muted>
        </Card>
      )}
      <Card
        title={`Độ phủ · ${cov.reqs.length} yêu cầu${noCase ? `, ${noCase} chưa có ca` : ''}`}
        aside={
          onGenerate && (
            <Button size="xs" disabled={selected.length === 0} icon={<Sparkles size={13} />} onClick={() => onGenerate(selected)}>
              Sinh ca kiểm thử{selected.length ? ` (${selected.length})` : ''}
            </Button>
          )
        }
      >
        {cov.reqs.length === 0 ? (
          <Muted>Chưa có yêu cầu nào. Thêm tài liệu và gắn mã cho từng mục ở tab Tài liệu.</Muted>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-[8px]">
              <select aria-label="Lọc theo tài liệu" className={select} value={docFilter} onChange={(e) => onFilter?.(e.target.value, statusFilter)}>
                <option value="">Mọi tài liệu</option>
                {docs.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <select aria-label="Lọc theo trạng thái" className={select} value={statusFilter} onChange={(e) => onFilter?.(docFilter, e.target.value as CoverageStatus)}>
                {COVERAGE_STATUS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span className="text-[11.5px]/[15px] text-text-3">{rows.length} dòng</span>
            </div>
            {rows.length === 0 ? (
              <Muted>Không có yêu cầu nào khớp bộ lọc.</Muted>
            ) : (
              <table className="w-full text-[12px]/[16px]">
                <thead>
                  <tr className="text-left text-[11px]/[14px] text-text-3">
                    {editable && <th className="w-[24px] pb-[4px] font-normal" />}
                    <th className="pb-[4px] pr-[8px] font-normal">Yêu cầu</th>
                    <th className="pb-[4px] font-normal">Ca kiểm thử · kết quả gần nhất</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-divider align-top" data-testid="coverage-row">
                      {editable && (
                        <td className="py-[6px]">
                          <Checkbox checked={selected.includes(r.id)} onChange={(on) => onToggle?.(r.id, on)} />
                        </td>
                      )}
                      <td className="max-w-[240px] py-[6px] pr-[8px]">
                        <span className="block font-mono font-semibold text-text">{r.id}</span>
                        <span className="block truncate text-text-2" title={r.title}>
                          {r.title}
                        </span>
                        <span className="block font-mono text-[11px]/[14px] text-text-3">{r.doc}</span>
                      </td>
                      <td className="py-[6px]">
                        {r.cases.length === 0 ? <span className="text-amber">Chưa có ca kiểm thử</span> : r.cases.map((c) => caseLine(c, `${r.id}/${c.id}`))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Card>
      <Card title={`Ca chưa truy vết · ${cov.untraced.length}`}>
        {cov.untraced.length === 0 ? (
          <Muted>Mọi ca đều nối với yêu cầu.</Muted>
        ) : (
          <>
            <Muted>Ca sinh từ tài liệu tự do (không có mã yêu cầu). Sửa mã để nối ca với yêu cầu, hoặc sinh lại từ yêu cầu.</Muted>
            <div className="text-[12px]/[16px]" data-testid="untraced">
              {cov.untraced.map((c) => caseLine(c, c.id))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/** Tab Độ phủ nối với Go: đọc ma trận, sửa mã yêu cầu của ca, chuyển các mã đã chọn cho form sinh ca. */
export function CoveragePane({ app, reload, onGenerate }: { app: string; reload?: number; onGenerate?: (reqs: string[]) => void }) {
  const { show } = useToast();
  const [cov, setCov] = useState<Coverage | null>(null);
  const [error, setError] = useState('');
  const [doc, setDoc] = useState('');
  const [status, setStatus] = useState<CoverageStatus>('');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState('');
  const load = useCallback(async () => {
    try {
      setCov(await testApi.coverage(app));
      setError('');
    } catch (e) {
      setError(docErrorText(e));
    }
  }, [app]);
  useEffect(() => {
    setSelected([]);
    setEditing('');
    void load();
  }, [load, reload]);
  const saveReqs = async (caseId: string, reqs: string[]) => {
    try {
      await testApi.setCaseReqs(app, caseId, reqs);
      void testApi.track('docs_case_reqs', { app, reqs: reqs.length });
      show(reqs.length ? `Đã nối ca ${caseId} với ${reqs.join(', ')}.` : `Đã bỏ truy vết ca ${caseId}.`);
      setEditing('');
      await load();
    } catch (e) {
      show(docErrorText(e));
    }
  };
  if (error) return <p className="text-[12px]/[16px] text-red">{error}</p>;
  if (!cov) return <Muted>Đang tải độ phủ…</Muted>;
  return (
    <CoverageView
      cov={cov}
      docFilter={doc}
      statusFilter={status}
      onFilter={(d, s) => {
        setDoc(d);
        setStatus(s);
      }}
      selected={selected}
      onToggle={(r, on) => setSelected((o) => (on ? [...o, r] : o.filter((x) => x !== r)))}
      onGenerate={onGenerate}
      editing={editing}
      onEdit={setEditing}
      onSaveReqs={(id, reqs) => void saveReqs(id, reqs)}
      onCancelEdit={() => setEditing('')}
    />
  );
}
