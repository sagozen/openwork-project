// Màn gộp một xung đột đồng bộ: 3 cột chỉ đọc (Gốc / Của tôi / Của <tác giả>) và ô bản gộp điền sẵn bản Go gộp thử. Lưu bản
// gộp bị khoá khi còn dấu xung đột; lối tắt giữ bản của tôi / lấy bản của họ. Ảnh chỉ chọn một bản; flow của họ không qua
// kiểm tra an toàn thì chỉ giữ bản của tôi hoặc sửa bản gộp (Go kiểm lại mọi bản trước khi ghi). Mọi lựa chọn gửi kèm sha
// bản của họ đã hiện: bản đó đổi trong lúc xem thì Go từ chối, màn tải lại bản mới nhất.
import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Download, Upload } from 'lucide-react';
import { Button } from '@shell/components/ui';
import { Card, Muted } from '../chat/components/shared';
import { testApi } from '../testing/bridge';
import { CONFLICT_CHANGED, fileOfKey, hasConflictMarkers, KIND_LABEL, reasonLabel, syncErrorText, type ConflictView } from './sync-api';

export type MergeAction = 'merge' | 'mine' | 'theirs';

/** Gọi đúng hàm Go cho lựa chọn ở màn gộp (kèm sha bản của họ đã hiện): lưu bản gộp, giữ bản của tôi hoặc lấy bản của họ. */
export function applyMerge(action: MergeAction, view: Pick<ConflictView, 'key' | 'theirsSha256'>, merged = ''): Promise<void> {
  switch (action) {
    case 'merge':
      return testApi.syncResolve(view.key, merged, view.theirsSha256);
    case 'mine':
      return testApi.syncKeepMine(view.key, view.theirsSha256);
    case 'theirs':
      return testApi.syncTakeTheirs(view.key, view.theirsSha256);
  }
}

/** Lỗi do bản của họ vừa đổi sau khi mở màn gộp (cần tải lại xung đột). */
export const conflictChanged = (e: unknown) => (e as { code?: string } | null)?.code === CONFLICT_CHANGED;

/** Câu báo khi đã tự tải lại bản mới nhất của họ. */
export const changedText = (v: Pick<ConflictView, 'theirAuthor'>) =>
  `Bản của ${theirName(v)} vừa đổi sau khi bạn mở màn gộp. Đã tải lại bản mới nhất; xem lại rồi chọn lại.`;

/** Lựa chọn được phép: ảnh không gộp văn bản được; flow của họ không qua kiểm tra an toàn thì không lấy bản của họ. */
export const mergeRules = (v: Pick<ConflictView, 'binary' | 'reason'>) => ({ canMerge: !v.binary, canTakeTheirs: v.reason !== 'invalid_flow' });

const theirName = (v: Pick<ConflictView, 'theirAuthor'>) => v.theirAuthor || 'người khác';

function Column({ col, title, sub, text, empty }: { col: string; title: string; sub?: string; text: string; empty: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
      <p className="truncate text-[12px]/[15px] font-semibold text-text-2" title={sub ? `${title} · ${sub}` : title}>
        {title}
        {sub && <span className="font-normal text-text-3"> · {sub}</span>}
      </p>
      <pre
        data-col={col}
        className="max-h-[320px] min-h-[120px] overflow-auto rounded-[6px] bg-chip-neutral px-[8px] py-[6px] font-mono text-[11px]/[15px] whitespace-pre text-text-2"
      >
        {text === '' ? <span className="text-text-3 italic">{empty}</span> : text}
      </pre>
    </div>
  );
}

export function MergeView({
  view,
  draft,
  onDraft,
  onAction,
  busy,
  error,
}: {
  view: ConflictView;
  draft: string;
  onDraft?: (text: string) => void;
  /** Không có (thiếu quyền chạy flow) = chỉ xem. */
  onAction?: (action: MergeAction) => void;
  busy?: boolean;
  error?: string;
}) {
  const { canMerge, canTakeTheirs } = mergeRules(view);
  const marked = hasConflictMarkers(draft);
  const name = theirName(view);
  return (
    <div className="flex flex-col gap-[10px]" data-testid="merge-view">
      <p className="text-[12px]/[16px] text-text-2">
        <span className="font-mono">{fileOfKey(view.key, view.app)}</span> · {view.app} · {KIND_LABEL[view.kind] ?? view.kind}
        {view.conflicts > 0 && ` · ${view.conflicts} đoạn chưa gộp được`}
      </p>
      {view.reason && (
        <Card title={reasonLabel(view.reason)} tone="warn">
          {view.detail && <pre className="overflow-auto font-mono text-[11px]/[15px] whitespace-pre-wrap text-text-2">{view.detail}</pre>}
          <Muted>
            {view.reason === 'invalid_flow'
              ? 'Bản của họ không được ghi vào máy. Chỉ giữ được bản của tôi, hoặc sửa bản gộp cho qua kiểm tra rồi lưu.'
              : 'Bản của họ chưa qua kiểm tra; lấy bản của họ sẽ được kiểm lại trước khi ghi.'}
          </Muted>
        </Card>
      )}
      {view.binary ? (
        <Muted>
          Ảnh không gộp được: chọn giữ bản của tôi hoặc lấy bản của {name}.
          {view.mineDeleted && ' Máy này đã xoá ảnh.'}
          {view.theirsDeleted && ` ${name} đã xoá ảnh.`}
        </Muted>
      ) : (
        <div className="flex gap-[8px]">
          <Column col="base" title="Gốc" text={view.base} empty="(chưa có bản gốc)" />
          <Column col="mine" title="Của tôi" text={view.mineDeleted ? '' : view.mine} empty={view.mineDeleted ? '(đã xoá ở máy này)' : '(trống)'} />
          <Column
            col="theirs"
            title={`Của ${name}`}
            sub={view.theirDevice || undefined}
            text={view.theirsDeleted ? '' : view.theirs}
            empty={view.theirsDeleted ? `(${name} đã xoá)` : '(trống)'}
          />
        </div>
      )}
      {canMerge && (
        <label className="flex flex-col gap-[6px]">
          <span className="text-[12px]/[15px] font-semibold text-text-2">Bản gộp</span>
          <textarea
            className="stroke-in min-h-[220px] rounded-[8px] bg-surface px-[10px] py-[8px] font-mono text-[12px]/[17px] text-text"
            spellCheck={false}
            value={draft}
            readOnly={!onAction || !onDraft}
            onChange={(e) => onDraft?.(e.target.value)}
          />
        </label>
      )}
      {canMerge && marked && (
        <p className="text-[11.5px]/[15px] text-amber">Còn dấu xung đột ({'<<<<<<<'}, =======, {'>>>>>>>'}): sửa hết các đoạn xung đột (bỏ cả các dòng dấu) rồi lưu.</p>
      )}
      {error && <p className="text-[12px]/[16px] text-red">{error}</p>}
      {onAction && (
        <div className="flex flex-wrap gap-[8px]">
          {canMerge && (
            <Button disabled={busy || marked} icon={<Check size={15} />} onClick={() => onAction('merge')}>
              Lưu bản gộp
            </Button>
          )}
          <Button variant="secondary" disabled={busy} icon={<Upload size={15} />} onClick={() => onAction('mine')}>
            Giữ bản của tôi
          </Button>
          {canTakeTheirs && (
            <Button variant="secondary" disabled={busy} icon={<Download size={15} />} onClick={() => onAction('theirs')}>
              Lấy bản của họ
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Màn gộp: tải xung đột qua SyncConflict, gọi Go theo lựa chọn rồi báo onResolved (trang nhắc Đẩy lên). */
export function MergeScreen({ conflictKey, canEdit, onResolved, onBack }: { conflictKey: string; canEdit: boolean; onResolved: () => void; onBack: () => void }) {
  const [view, setView] = useState<ConflictView | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setView(null);
    setError('');
    testApi.syncConflict(conflictKey).then(
      (v) => {
        if (!live) return;
        setView(v);
        setDraft(v.merged);
      },
      (e) => live && setError(syncErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [conflictKey]);
  const act = async (action: MergeAction) => {
    if (!view) return;
    setBusy(true);
    setError('');
    try {
      await applyMerge(action, view, draft);
      void testApi.track('sync_resolve', { action, kind: view.kind });
      onResolved();
    } catch (e) {
      if (!conflictChanged(e)) {
        setError(syncErrorText(e));
        return;
      }
      // Một lần Kéo về đã làm mới bản của họ: tải lại để không gộp trên bản cũ (bản gộp gợi ý tính lại theo bản mới).
      try {
        const v = await testApi.syncConflict(view.key);
        setView(v);
        setDraft(v.merged);
        setError(changedText(v));
      } catch (e2) {
        setError(syncErrorText(e2));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Gộp xung đột"
      aside={
        <Button size="xs" variant="secondary" icon={<ArrowLeft size={13} />} onClick={onBack}>
          Quay lại
        </Button>
      }
    >
      {view ? (
        <MergeView view={view} draft={draft} onDraft={setDraft} onAction={canEdit ? (a) => void act(a) : undefined} busy={busy} error={error} />
      ) : error ? (
        <p className="text-[12px]/[16px] text-red">{error}</p>
      ) : (
        <Muted>Đang tải xung đột…</Muted>
      )}
    </Card>
  );
}
