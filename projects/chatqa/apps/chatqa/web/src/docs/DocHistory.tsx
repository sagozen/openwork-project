// Tab "Lịch sử" của một tài liệu: các bản (mới nhất trước), diff theo dòng giữa hai bản do Go tính (test.Service.DocDiff),
// "Khôi phục bản này" = lưu nội dung bản cũ thành bản mới (lịch sử không bị ghi đè).
import { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button, cx } from '@shell/components/ui';
import { useToast } from '@shell/components/overlays/ToastHost';
import { Muted } from '../chat/components/shared';
import { testApi, type Doc, type Revision } from '../testing/bridge';
import { diffLines, docErrorText, type DiffKind } from './docs-api';

const LINE_TONE: Record<DiffKind, string> = { add: 'bg-green-soft text-green', del: 'bg-red-soft text-red', same: 'text-text-2' };
const MARK: Record<DiffKind, string> = { add: '+', del: '-', same: ' ' };
const select = 'stroke-in h-[30px] rounded-[6px] bg-surface px-[8px] text-[12px]/[15px] text-text';

const when = (iso: string) => (iso ? new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '');

/** Diff theo dòng: dòng thêm xanh (+), dòng bỏ đỏ (-), dòng giữ nguyên xám. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diffLines(diff);
  if (lines.every((l) => l.kind === 'same')) return <Muted>Hai bản giống nhau.</Muted>;
  return (
    <pre className="max-h-[420px] overflow-auto rounded-[8px] bg-muted-box p-[8px] font-mono text-[11px]/[15px]" data-testid="doc-diff">
      {lines.map((l, i) => (
        <span key={i} className={cx('block whitespace-pre-wrap', LINE_TONE[l.kind])} data-kind={l.kind}>
          {MARK[l.kind]} {l.text || ' '}
        </span>
      ))}
    </pre>
  );
}

/** Rev dùng cho Go: bản đang dùng gọi bằng 0 (DocDiff/DocRevision). */
const goRev = (r: Revision) => (r.current ? 0 : r.rev);

export interface DocHistoryViewProps {
  revs: Revision[];
  /** Rev theo số của bản (không phải 0). */
  from: number;
  to: number;
  diff: string | null;
  error?: string;
  restoring?: number;
  onPick?: (from: number, to: number) => void;
  /** Không có (thiếu quyền chạy flow) = không hiện nút khôi phục. */
  onRestore?: (rev: number) => void;
}

export function DocHistoryView({ revs, from, to, diff, error, restoring, onPick, onRestore }: DocHistoryViewProps) {
  if (revs.length === 0) return <Muted>Tài liệu chưa có lịch sử.</Muted>;
  const opt = (r: Revision) => (
    <option key={r.rev} value={r.rev}>
      Bản {r.rev}
      {r.current ? ' (đang dùng)' : ''} · {when(r.at)}
    </option>
  );
  return (
    <div className="flex flex-col gap-[10px]" data-testid="doc-history">
      <ul>
        {revs.map((r) => (
          <li key={r.rev} className="flex items-center gap-[8px] border-t border-divider py-[5px] text-[12px]/[16px] first:border-t-0">
            <span className="font-mono font-semibold text-text">Bản {r.rev}</span>
            {r.current && <span className="rounded-[5px] bg-accent-soft px-[6px] py-px text-[10.5px]/[14px] font-semibold text-accent-ink">đang dùng</span>}
            <span className="min-w-0 flex-1 truncate text-text-3">
              {when(r.at)} · {r.size.toLocaleString('vi-VN')} byte
            </span>
            {onRestore && !r.current && (
              <Button size="xs" variant="secondary" disabled={restoring !== undefined} icon={<RotateCcw size={13} />} onClick={() => onRestore(r.rev)}>
                {restoring === r.rev ? 'Đang khôi phục…' : 'Khôi phục bản này'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {revs.length > 1 && (
        <>
          <div className="flex flex-wrap items-center gap-[8px] text-[12px]/[15px] text-text-2">
            <span>So bản</span>
            <select aria-label="Bản cũ" className={select} value={from} onChange={(e) => onPick?.(Number(e.target.value), to)}>
              {revs.map(opt)}
            </select>
            <span>với</span>
            <select aria-label="Bản mới" className={select} value={to} onChange={(e) => onPick?.(from, Number(e.target.value))}>
              {revs.map(opt)}
            </select>
          </div>
          {error ? <p className="text-[12px]/[16px] text-red">{error}</p> : diff === null ? <Muted>Đang tính diff…</Muted> : <DiffView diff={diff} />}
        </>
      )}
    </div>
  );
}

/** Lịch sử nối với Go; khôi phục xong gọi onRestored với bản mới để trang cập nhật trình soạn thảo và ca bị ảnh hưởng. */
export function DocHistory({ app, docId, rev, onRestored }: { app: string; docId: string; rev: number; onRestored?: (d: Doc) => void }) {
  const { show } = useToast();
  const [revs, setRevs] = useState<Revision[]>([]);
  const [pick, setPick] = useState<{ from: number; to: number }>({ from: 0, to: 0 });
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState<number>();

  // rev đổi (vừa lưu/khôi phục) thì đọc lại; mặc định so bản trước với bản đang dùng.
  useEffect(() => {
    let live = true;
    testApi.docHistory(app, docId).then(
      (list) => {
        if (!live) return;
        setRevs(list);
        setPick({ from: list[1]?.rev ?? list[0]?.rev ?? 0, to: list[0]?.rev ?? 0 });
        setError('');
      },
      (e) => live && setError(docErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [app, docId, rev]);

  const revOf = useCallback((n: number) => revs.find((r) => r.rev === n), [revs]);
  useEffect(() => {
    const a = revOf(pick.from);
    const b = revOf(pick.to);
    if (!a || !b || revs.length < 2) return;
    let live = true;
    setDiff(null);
    testApi.docDiff(app, docId, goRev(a), goRev(b)).then(
      (d) => {
        if (!live) return;
        setDiff(d);
        setError('');
      },
      (e) => live && setError(docErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [app, docId, pick, revOf, revs.length]);

  const restore = async (n: number) => {
    setRestoring(n);
    try {
      const text = await testApi.docRevision(app, docId, n);
      const saved = await testApi.saveDoc(app, docId, text);
      void testApi.track('docs_restore', { app, doc: docId, from: n, rev: saved.rev });
      show(`Đã khôi phục bản ${n} thành bản ${saved.rev}.`);
      onRestored?.(saved);
    } catch (e) {
      show(docErrorText(e));
    } finally {
      setRestoring(undefined);
    }
  };
  if (error && revs.length === 0) return <p className="text-[12px]/[16px] text-red">{error}</p>;
  return (
    <DocHistoryView
      revs={revs}
      from={pick.from}
      to={pick.to}
      diff={diff}
      error={error}
      restoring={restoring}
      onPick={(from, to) => setPick({ from, to })}
      onRestore={onRestored ? (n) => void restore(n) : undefined}
    />
  );
}
