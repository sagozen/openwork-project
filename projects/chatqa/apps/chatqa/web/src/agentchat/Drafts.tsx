// Bản nháp sửa flow của FlowFixer: danh sách, xem diff và lý do, "Áp dụng" (ghi flow qua test_apply_repair, luôn hỏi
// duyệt theo chính sách của Go trước khi ghi) hoặc "Bỏ". FlowFixer không bao giờ tự ghi flow.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff, ShieldAlert } from 'lucide-react';
import { ApiError } from '@shell/platform';
import { cx } from '@shell/components/ui/cx';
import { agentApi, onAgentEvent, type ApplyDraftResult, type FlowDraft } from './bridge';

export type DiffTone = 'add' | 'del' | 'same';

/** Tách diff của Go (mỗi dòng mở đầu "+ ", "- " hoặc "  ") thành dòng có sắc thái để tô màu. */
export function diffLines(diff: string): { tone: DiffTone; text: string }[] {
  return diff
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => {
      if (l.startsWith('+')) return { tone: 'add' as const, text: l.slice(2) };
      if (l.startsWith('-')) return { tone: 'del' as const, text: l.slice(2) };
      return { tone: 'same' as const, text: l.slice(2) };
    });
}

const RISK_LABEL: Record<string, string> = { read: 'Chỉ đọc', run: 'Chạy trên thiết bị', write: 'Ghi dữ liệu', dangerous: 'Nguy hiểm' };

/** Hộp hỏi trước khi áp dụng: hậu quả và lý do chính sách đòi duyệt. */
export interface DraftConfirm {
  id: string;
  result: ApplyDraftResult;
}

export function DraftsView({
  drafts,
  openId,
  confirm,
  busy,
  error,
  expanded,
  onToggle,
  onOpen,
  onApply,
  onConfirm,
  onCancel,
  onDiscard,
}: {
  drafts: FlowDraft[];
  openId: string;
  confirm: DraftConfirm | null;
  busy: boolean;
  error: string;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
  onApply: (id: string) => void;
  onConfirm: (id: string) => void;
  onCancel: () => void;
  onDiscard: (id: string) => void;
}) {
  if (drafts.length === 0) return null;
  const waiting = drafts.filter((d) => d.valid && !d.applied).length;
  return (
    <section className="border-b border-border px-[12px] py-[6px] text-[12px]/[16px]" data-testid="drafts" aria-label="Bản nháp sửa flow">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex items-center gap-[5px] font-semibold text-text">
        {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        <FileDiff size={13} className="text-accent" aria-hidden />
        Bản nháp sửa flow ({drafts.length}){waiting > 0 && <span className="rounded-[4px] bg-accent-soft px-[5px] text-accent">{waiting} chờ duyệt</span>}
      </button>
      {expanded && (
        <ul className="mt-[6px] flex max-h-[320px] flex-col gap-[6px] overflow-y-auto">
          {drafts.map((d) => {
            const open = d.id === openId;
            const asking = confirm?.id === d.id ? confirm.result : null;
            return (
              <li key={d.id} className="rounded-[8px] border border-border bg-surface px-[8px] py-[6px]" data-testid="draft" data-valid={d.valid} data-applied={d.applied}>
                <button type="button" onClick={() => onOpen(open ? '' : d.id)} aria-expanded={open} className="flex w-full items-center gap-[6px] text-left">
                  <span className="font-mono text-text">
                    {d.app}/{d.flow}
                  </span>
                  {d.applied ? (
                    <span className="rounded-[4px] bg-green-soft px-[5px] text-green">Đã áp dụng</span>
                  ) : d.valid ? (
                    <span className="rounded-[4px] bg-accent-soft px-[5px] text-accent">Hợp lệ</span>
                  ) : (
                    <span className="rounded-[4px] bg-red-soft px-[5px] text-red">Không hợp lệ</span>
                  )}
                  <span className="ml-auto text-text-3">{new Date(d.createdAt).toLocaleString('vi-VN')}</span>
                </button>
                {open && (
                  <div className="mt-[6px] flex flex-col gap-[6px]">
                    <p className="whitespace-pre-wrap text-text-2">{d.reason}</p>
                    {!d.valid && (d.errors?.length ?? 0) > 0 && (
                      <ul className="list-disc pl-[16px] text-red" data-testid="draft-errors">
                        {d.errors?.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                    <pre className="max-h-[200px] overflow-auto rounded-[6px] bg-muted-box p-[6px] font-mono text-[11.5px]/[15px]" data-testid="draft-diff">
                      {diffLines(d.diff).map((l, i) => (
                        <div key={i} data-tone={l.tone} className={cx(l.tone === 'add' && 'bg-green-soft text-green', l.tone === 'del' && 'bg-red-soft text-red', l.tone === 'same' && 'text-text-2')}>
                          {l.tone === 'add' ? '+ ' : l.tone === 'del' ? '- ' : '  '}
                          {l.text}
                        </div>
                      ))}
                    </pre>
                    {asking ? (
                      <div role="alertdialog" aria-label="Duyệt áp dụng bản nháp" className="flex flex-col gap-[4px] rounded-[8px] border border-amber bg-amber-soft px-[8px] py-[6px]" data-testid="draft-confirm">
                        <p className="flex items-center gap-[5px] font-semibold text-text">
                          <ShieldAlert size={14} className="text-amber" aria-hidden />
                          Ghi đè {asking.flow || d.flow} bằng bản nháp?
                        </p>
                        <p className="text-text-2">
                          {asking.risk && <span className="mr-[6px] rounded-[4px] bg-surface px-[5px] font-semibold">{RISK_LABEL[asking.risk] ?? asking.risk}</span>}
                          {asking.consequence}
                        </p>
                        <div className="flex gap-[8px]">
                          <button type="button" disabled={busy} onClick={() => onConfirm(d.id)} className="rounded-[7px] bg-accent px-[12px] py-[3px] font-semibold text-white disabled:opacity-60">
                            Đồng ý áp dụng
                          </button>
                          <button type="button" disabled={busy} onClick={onCancel} className="rounded-[7px] border border-border bg-surface px-[12px] py-[3px] font-semibold text-text disabled:opacity-60">
                            Huỷ
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-[8px]">
                        <button
                          type="button"
                          disabled={busy || !d.valid || d.applied}
                          onClick={() => onApply(d.id)}
                          className="rounded-[7px] bg-accent px-[12px] py-[3px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Áp dụng
                        </button>
                        <button type="button" disabled={busy} onClick={() => onDiscard(d.id)} className="rounded-[7px] border border-border bg-surface px-[12px] py-[3px] font-semibold text-text disabled:opacity-60">
                          Bỏ
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-[4px] text-red" data-testid="draft-error">
          {error}
        </p>
      )}
    </section>
  );
}

const errText = (e: unknown) => (e instanceof ApiError ? `${e.code}${e.params && Object.keys(e.params).length ? `: ${JSON.stringify(e.params)}` : ''}` : e instanceof Error ? e.message : String(e));

/** Danh sách bản nháp trong khung chat agent; đọc lại sau mỗi lượt của agent. */
export function DraftsPanel() {
  const [drafts, setDrafts] = useState<FlowDraft[]>([]);
  const [openId, setOpenId] = useState('');
  const [confirm, setConfirm] = useState<DraftConfirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setDrafts(await agentApi.drafts());
    } catch {
      // đội agent chưa sẵn sàng: không có danh sách
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAgentEvent((ev) => {
      if (ev.kind === 'done') void refresh();
    });
  }, [refresh]);

  const run = async (id: string, confirmed: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await agentApi.applyDraft(id, confirmed);
      setConfirm(res.needsConfirm ? { id, result: res } : null);
      if (res.applied) await refresh();
    } catch (e) {
      setConfirm(null);
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await agentApi.discardDraft(id);
      if (openId === id) setOpenId('');
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DraftsView
      drafts={drafts}
      openId={openId}
      confirm={confirm}
      busy={busy}
      error={error}
      expanded={expanded}
      onToggle={() => setExpanded((x) => !x)}
      onOpen={(id) => {
        setOpenId(id);
        setConfirm(null);
      }}
      onApply={(id) => void run(id, false)}
      onConfirm={(id) => void run(id, true)}
      onCancel={() => setConfirm(null)}
      onDiscard={(id) => void discard(id)}
    />
  );
}
