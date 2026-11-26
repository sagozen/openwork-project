// Trang Kiểm thử › Đồng bộ (/kiem-thu/dong-bo): kéo về / đẩy lên tài liệu, ca, flow, ghi chú của mọi app với kho nhóm S3/MinIO,
// trạng thái từng tệp theo app, kết quả lần cuối, tiến độ qua sự kiện "test:sync" (kể cả lần chạy qua MCP), danh sách xung
// đột dẫn tới màn gộp và tab Lượt của nhóm. Chưa đăng nhập / chưa cấu hình thì màn trống chỉ tới Cài đặt › Kiểm thử.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Download, GitMerge, Settings, Upload } from 'lucide-react';
import { Button, Tabs } from '@shell/components/ui';
import { cx } from '@shell/components/ui/cx';
import { errorText, useSession } from '@shell/lib/session';
import { isAdmin } from '@shell/platform/roles';
import { useToast } from '@shell/components/overlays/ToastHost';
import { Card, Muted } from '../chat/components/shared';
import { onSyncEvent, testApi } from '../testing/bridge';
import { MergeScreen } from './MergeView';
import { TeamRuns } from './TeamRuns';
import {
  blockOf,
  fileOfKey,
  fmtBytes,
  fmtWhen,
  groupByApp,
  KIND_LABEL,
  reasonLabel,
  resultCounts,
  resultSentence,
  STATE_LABEL,
  STATE_TONE,
  stateLabel,
  syncErrorText,
  type LastResult,
  type SyncBlock,
  type SyncOp,
  type SyncProgress,
  type SyncState,
  type SyncStatusResult,
} from './sync-api';

/** Đường dẫn Cài đặt › Kiểm thử (khối Đồng bộ nhóm), chỉ Admin mở được. */
export const SYNC_SETTINGS_PATH = '/cai-dat/kiem-thu';

export const BUSY_NOTE = 'Đang có lần đẩy/kéo khác (có thể từ AI qua MCP). Chờ xong rồi thử lại.';
export const MERGED_HINT = 'Đẩy lên để chia sẻ bản gộp.';
/** Không nhận được sự kiện kết thúc của lần đẩy/kéo khác thì sau chừng này mở lại nút. */
const BUSY_RELEASE_MS = 10_000;

/** Gọi đẩy lên / kéo về mọi app; lỗi (busy, chưa cấu hình...) ném ra như ApiError. */
export async function runSyncOp(op: SyncOp): Promise<LastResult> {
  return op === 'push' ? { op, result: await testApi.syncPush([]) } : { op, result: await testApi.syncPull([]) };
}

export const isBusy = (e: unknown) => (e as { code?: string } | null)?.code === 'busy';

const OP_LABEL: Record<SyncProgress['op'], string> = { push: 'Đẩy lên', pull: 'Kéo về', share: 'Chia sẻ evidence' };

/** Dòng tiến độ từ sự kiện "test:sync". */
export function progressText(ev: SyncProgress): string {
  const what = ev.op === 'share' ? `${OP_LABEL.share} lượt ${ev.runId ?? ''}${ev.auto ? ' (tự động)' : ''}` : OP_LABEL[ev.op];
  switch (ev.phase) {
    case 'start':
      return `${what}: đang chạy…`;
    case 'done':
      return ev.op === 'share' && ev.sizeBytes ? `${what}: xong (${fmtBytes(ev.sizeBytes)}).` : `${what}: xong.`;
    case 'confirm':
      return `${what}: gói nặng ${fmtBytes(ev.sizeBytes ?? 0)}, cần xác nhận. Mở lượt ở trang Kiểm thử và bấm “Chia sẻ lên nhóm”.`;
    case 'error':
      if (ev.code === 'redaction_failed') return `${what}: không chia sẻ, lượt này chứa bí mật chưa che được.`;
      return `${what}: lỗi, ${ev.error || syncErrorText({ code: ev.code })}`;
  }
}

/** Màn trống khi chưa đăng nhập hoặc chưa cấu hình; Admin có nút mở Cài đặt › Kiểm thử. */
export function SyncEmpty({ block, onOpenSettings }: { block: SyncBlock; onOpenSettings?: () => void }) {
  const signedOut = block === 'not_signed_in';
  return (
    <Card title={signedOut ? 'Chưa đăng nhập tài khoản công ty' : 'Chưa cấu hình đồng bộ nhóm'}>
      <div data-testid="sync-empty" className="flex flex-col gap-[8px]">
        <Muted>
          {signedOut
            ? errorText({ code: 'not_signed_in' })
            : onOpenSettings
              ? 'Nhập endpoint, bucket và khoá S3 ở Cài đặt › Kiểm thử › Đồng bộ nhóm (S3/MinIO), bấm “Thử kết nối”, rồi quay lại đây.'
              : errorText({ code: 'sync_not_configured' })}
        </Muted>
        {!signedOut && onOpenSettings && (
          <Button size="sm" variant="secondary" className="self-start" icon={<Settings size={13} />} onClick={onOpenSettings}>
            Mở Cài đặt › Kiểm thử
          </Button>
        )}
      </div>
    </Card>
  );
}

/** Nút Kéo về / Đẩy lên và dòng tiến độ; tắt khi đang chạy hoặc kho đang bận. Không có quyền chạy flow thì chỉ xem. */
export function SyncActions({
  running,
  busy,
  canRun,
  progress,
  onPull,
  onPush,
}: {
  running: SyncOp | '';
  busy?: boolean;
  canRun: boolean;
  progress?: string;
  onPull?: () => void;
  onPush?: () => void;
}) {
  const off = running !== '' || !!busy;
  return (
    <div className="flex flex-col gap-[6px]">
      {canRun ? (
        <div className="flex flex-wrap gap-[8px]">
          <Button disabled={off} icon={<Download size={15} />} onClick={onPull}>
            {running === 'pull' ? 'Đang kéo về…' : 'Kéo về'}
          </Button>
          <Button variant="secondary" disabled={off} icon={<Upload size={15} />} onClick={onPush}>
            {running === 'push' ? 'Đang đẩy lên…' : 'Đẩy lên'}
          </Button>
        </div>
      ) : (
        <Muted>Cần quyền chạy flow để kéo về, đẩy lên và gộp.</Muted>
      )}
      {busy && <p className="text-[11.5px]/[15px] text-amber">{BUSY_NOTE}</p>}
      {progress && <p className="text-[11.5px]/[15px] text-text-2" data-testid="sync-progress">{progress}</p>}
    </div>
  );
}

function StateChip({ state }: { state: SyncState }) {
  return <span className={cx('shrink-0 rounded-[5px] px-[6px] py-px text-[10.5px]/[14px] font-semibold', STATE_TONE[state] ?? 'bg-chip-neutral text-text-2')}>{stateLabel(state)}</span>;
}

/** Danh sách xung đột, số tệp theo trạng thái, lần đồng bộ cuối, cảnh báo và bảng tệp chưa đồng bộ theo app. */
export function SyncStatusView({ status, onMerge }: { status: SyncStatusResult; onMerge?: (key: string) => void }) {
  const groups = groupByApp(status.files);
  const counts = (Object.keys(STATE_LABEL) as SyncState[]).filter((s) => (status.counts[s] ?? 0) > 0);
  return (
    <div className="flex flex-col gap-[10px]" data-testid="sync-status">
      {status.conflicts.length > 0 && (
        <Card title={`Xung đột cần gộp · ${status.conflicts.length}`} tone="error">
          <ul data-testid="sync-conflicts">
            {status.conflicts.map((c) => (
              <li key={c.key} className="flex items-center gap-[10px] border-t border-divider py-[6px] first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[12px]/[16px] text-text">{fileOfKey(c.key, c.app)}</p>
                  <p className="truncate text-[11.5px]/[15px] text-text-2">
                    {c.app} · {KIND_LABEL[c.kind] ?? c.kind} · bản của {c.author || 'người khác'}
                    {c.device ? ` (máy ${c.device})` : ''}
                    {c.theirsDeleted ? ' · họ đã xoá' : ''}
                    {c.reason ? ` · ${reasonLabel(c.reason)}` : ''}
                  </p>
                </div>
                {onMerge && (
                  <Button size="xs" variant="secondary" icon={<GitMerge size={13} />} onClick={() => onMerge(c.key)}>
                    Mở màn gộp
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Trạng thái tệp">
        <p className="text-[11.5px]/[15px] text-text-2">
          {counts.length === 0 ? 'Chưa có tệp nào ở máy này hay trên kho nhóm.' : counts.map((s) => `${STATE_LABEL[s]} ${status.counts[s]}`).join(' · ')}
        </p>
        <p className="text-[11.5px]/[15px] text-text-3">
          Đẩy lên lần cuối: {fmtWhen(status.lastPush) || 'chưa'} · Kéo về lần cuối: {fmtWhen(status.lastPull) || 'chưa'}
        </p>
        {groups.map((g) => (
          <section key={g.app} className="flex flex-col gap-[4px] border-t border-divider pt-[6px]" data-app={g.app}>
            <p className="text-[12px]/[16px] font-semibold text-text">
              {g.app}
              <span className="font-normal text-text-3">
                {' '}
                · {g.synced} đã đồng bộ{g.changed.length > 0 ? `, ${g.changed.length} cần xử lý` : ''}
              </span>
            </p>
            {g.changed.length > 0 && (
              <table className="w-full text-left text-[11.5px]/[15px]">
                <thead className="text-text-3">
                  <tr>
                    <th className="py-[3px] font-medium">Tệp</th>
                    <th className="w-[80px] py-[3px] font-medium">Loại</th>
                    <th className="w-[130px] py-[3px] font-medium">Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {g.changed.map((f) => (
                    <tr key={f.key} className="border-t border-divider" data-state={f.state}>
                      <td className="max-w-0 py-[4px] pr-[8px]">
                        <span className="block truncate font-mono text-text" title={f.key}>
                          {fileOfKey(f.key, f.app)}
                        </span>
                        {(f.author || f.reason) && (
                          <span className="block truncate text-text-3">
                            {f.author ? `bản của ${f.author}` : ''}
                            {f.author && f.reason ? ' · ' : ''}
                            {reasonLabel(f.reason)}
                          </span>
                        )}
                      </td>
                      <td className="py-[4px] text-text-2">{KIND_LABEL[f.kind] ?? f.kind}</td>
                      <td className="py-[4px]">
                        <StateChip state={f.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </Card>
      {status.warnings.length > 0 && (
        <Card title={`Cảnh báo · ${status.warnings.length}`} tone="warn">
          <ul className="flex flex-col gap-[4px] text-[11.5px]/[15px] text-text-2">
            {status.warnings.map((w, i) => (
              <li key={i}>
                {w.key && <span className="font-mono">{w.key}: </span>}
                {w.message}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Kết quả lần đẩy/kéo vừa rồi: số tệp từng phần, tệp bỏ qua kèm lý do, lỗi từng tệp, cảnh báo. */
export function LastResultView({ last }: { last: LastResult }) {
  const r = last.result;
  const merged = last.op === 'pull' ? last.result.merged : [];
  return (
    <Card title={`Kết quả lần cuối · ${last.op === 'push' ? 'Đẩy lên' : 'Kéo về'}`}>
      <div className="flex flex-col gap-[6px]" data-testid="sync-last">
        <p className="text-[12px]/[16px] text-text">{resultCounts(last).map((c) => `${c.n} ${c.label}`).join(' · ')}</p>
        {merged.length > 0 && (
          <p className="text-[11.5px]/[15px] text-amber">
            {merged.length} tệp đã gộp tự động. {MERGED_HINT}
          </p>
        )}
        {r.conflicts.length > 0 && <p className="text-[11.5px]/[15px] text-red">{r.conflicts.length} tệp đang xung đột bị bỏ qua: gộp trong danh sách xung đột.</p>}
        {r.skipped.length > 0 && (
          <details>
            <summary className="cursor-pointer text-[11.5px]/[15px] text-text-2">Bỏ qua {r.skipped.length} tệp</summary>
            <ul className="mt-[4px] flex flex-col gap-[2px] text-[11.5px]/[15px] text-text-2">
              {r.skipped.map((s) => (
                <li key={s.key}>
                  <span className="font-mono">{s.key}</span> · {stateLabel(s.reason)}
                </li>
              ))}
            </ul>
          </details>
        )}
        {r.errors.length > 0 && (
          <ul className="flex flex-col gap-[2px] text-[11.5px]/[15px] text-red">
            {r.errors.map((e) => (
              <li key={e.key}>
                <span className="font-mono">{e.key}</span>: {e.error}
              </li>
            ))}
          </ul>
        )}
        {r.warnings.length > 0 && (
          <ul className="flex flex-col gap-[2px] text-[11.5px]/[15px] text-amber">
            {r.warnings.map((w, i) => (
              <li key={i}>
                {w.key && <span className="font-mono">{w.key}: </span>}
                {w.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

type PageTab = 'files' | 'team';

export default function SyncPage() {
  const { show } = useToast();
  const session = useSession();
  const canRun = session.can('cqs.run');
  const admin = isAdmin(session.state?.user?.role);
  const navigate = useNavigate();
  const [tab, setTab] = useState<PageTab>('files');
  const [prefix, setPrefix] = useState('');
  const [block, setBlock] = useState<SyncBlock | null>(null);
  const [status, setStatus] = useState<SyncStatusResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState<SyncOp | ''>('');
  /** Lần đẩy/kéo đang chạy ở nơi khác (MCP, cửa sổ khác) hoặc vừa trả busy. */
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<LastResult | null>(null);
  const [progress, setProgress] = useState('');
  const [mergeKey, setMergeKey] = useState('');
  const [hint, setHint] = useState('');
  const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Lần đẩy/kéo của chính trang này: sự kiện của nó không tính là "đang bận ở nơi khác". */
  const own = useRef(false);

  const load = useCallback(async () => {
    try {
      const cfg = await testApi.syncConfig();
      setPrefix(cfg.prefix);
      if (!cfg.prefix) return setBlock('not_signed_in');
      if (!cfg.configured) return setBlock('sync_not_configured');
      setStatus(await testApi.syncStatus([]));
      setBlock(null);
      setError('');
    } catch (e) {
      const b = blockOf(e);
      if (b) setBlock(b);
      else setError(syncErrorText(e));
    }
  }, []);

  const holdBusy = useCallback((on: boolean) => {
    clearTimeout(busyTimer.current);
    setBusy(on);
    if (on) busyTimer.current = setTimeout(() => setBusy(false), BUSY_RELEASE_MS);
  }, []);

  useEffect(() => {
    void load();
    const off = onSyncEvent((ev) => {
      setProgress(progressText(ev));
      if (ev.op === 'share' || own.current) return;
      if (ev.phase === 'start') holdBusy(true);
      else {
        holdBusy(false);
        void load();
      }
    });
    return () => {
      off();
      clearTimeout(busyTimer.current);
    };
  }, [load, holdBusy]);

  const run = async (op: SyncOp) => {
    own.current = true;
    setRunning(op);
    setHint('');
    try {
      const out = await runSyncOp(op);
      setLast(out);
      show(resultSentence(out));
      void testApi.track('sync_run', { op, errors: out.result.errors.length, conflicts: out.result.conflicts.length });
    } catch (e) {
      if (isBusy(e)) {
        holdBusy(true);
        show(BUSY_NOTE);
      } else {
        const b = blockOf(e);
        if (b) setBlock(b);
        else show(syncErrorText(e));
      }
    } finally {
      own.current = false;
      setRunning('');
    }
    await load();
  };

  const resolved = () => {
    setMergeKey('');
    setHint(`Đã gộp. ${MERGED_HINT}`);
    show(`Đã gộp. ${MERGED_HINT}`);
    void load();
  };

  return (
    <div className="flex flex-col gap-[10px] px-[16px] py-[14px]" data-testid="sync-page">
      <Card title="Đồng bộ nhóm" aside={prefix && <span className="truncate font-mono text-[11px]/[14px] text-text-3">{prefix}</span>}>
        <Muted>
          Tài liệu, ca, flow và ghi chú của mọi app đồng bộ với đồng đội qua kho S3/MinIO. Kéo về trước khi sửa, đẩy lên khi xong; hai người sửa cùng một tệp
          thì gộp ở đây, không ai bị ghi đè.
        </Muted>
        {!block && <SyncActions running={running} busy={busy} canRun={canRun} progress={progress} onPull={() => void run('pull')} onPush={() => void run('push')} />}
      </Card>
      {block ? (
        <SyncEmpty block={block} onOpenSettings={admin ? () => navigate(SYNC_SETTINGS_PATH) : undefined} />
      ) : (
        <>
          <Tabs<PageTab>
            items={[
              { key: 'files', label: 'Tệp', ...(status?.conflicts.length ? { count: status.conflicts.length } : {}) },
              { key: 'team', label: 'Lượt của nhóm' },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === 'files' &&
            (mergeKey ? (
              <MergeScreen conflictKey={mergeKey} canEdit={canRun} onResolved={resolved} onBack={() => setMergeKey('')} />
            ) : (
              <>
                {error && <p className="text-[12px]/[16px] text-red">{error}</p>}
                {hint && <p className="text-[12px]/[16px] text-amber" data-testid="sync-hint">{hint}</p>}
                {last && <LastResultView last={last} />}
                {status ? <SyncStatusView status={status} onMerge={setMergeKey} /> : !error && <Muted>Đang đọc trạng thái…</Muted>}
              </>
            ))}
          {tab === 'team' && <TeamRuns show={show} />}
        </>
      )}
    </div>
  );
}
