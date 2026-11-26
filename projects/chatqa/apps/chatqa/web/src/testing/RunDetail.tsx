// Chi tiết một lượt chạy (test.Service.Report): mỗi máy × lần lặp × flow một dòng thời gian các bước, kèm YAML, selector,
// phần tử, thời gian, lỗi + gợi ý và ảnh trước/sau (tải lười qua StepShot, bấm để phóng to). Nút mở thư mục lượt, mở báo cáo
// (evidence.html trên máy), xuất gói báo cáo và lịch sử vào thư mục exports; gửi đi đâu là người dùng tự làm. Đã cấu hình đồng bộ
// nhóm thì có thêm nút chia sẻ evidence của lượt lên kho nhóm (test.Service.ShareRun).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, FolderOpen, MessageSquareWarning, PackageOpen, Share2, X } from 'lucide-react';
import { Button, Input } from '@shell/components/ui';
import { errorText, useSession } from '@shell/lib/session';
import { useToast } from '@shell/components/overlays/ToastHost';
import { Card, Muted, StateBadge, timeOf } from '../chat/components/shared';
import { fmtMs } from './MetricsPane';
import { ARTIFACT_LABEL } from './RunForm';
import { isSpecFlow, testApi, type FlowRun, type RunReport, type StepRun } from './bridge';
import { flowReqs, reqsOfFlow } from '../docs/docs-api';
import { NoteDialog } from '../docs/NoteDialog';
import { fmtBytes, syncErrorText, TEAM_SHOT_NOTE, type PushRunResult } from '../sync/sync-api';

/** Ảnh/video giữ nguyên những gì màn hình hiện, Go chỉ che được chữ trong file văn bản. */
export const SHOT_NOTE = 'Ảnh màn hình và video không che được chữ bí mật hiện trên màn hình. Chỉ gửi gói cho người được phép xem.';

/** Lỗi khi xuất: câu chung của contracts/errors.json nói cả xuất lẫn mở, ở đây nói rõ việc xuất gói. */
export function exportErrorText(e: unknown): string {
  return (e as { code?: string } | null)?.code === 'redaction_failed'
    ? 'Không xuất được: lượt này từng che bí mật lỗi nên gói có thể lộ giá trị bí mật. Chạy lại lượt rồi xuất.'
    : errorText(e);
}

/**
 * Gọi một lệnh xuất (Go ghi thẳng vào thư mục exports, không hộp lưu) và báo kết quả: đường dẫn đã lưu hoặc câu lỗi.
 * Ghi lịch sử sử dụng (kind) với kết quả saved | error; trả đường dẫn ("" khi lỗi).
 */
export async function exportWith(
  fn: () => Promise<string>,
  show: (msg: string) => void,
  kind: string,
  detail: Record<string, unknown> = {},
): Promise<string> {
  try {
    const path = await fn();
    void testApi.track(kind, { ...detail, result: 'saved' });
    show(`Đã lưu ${path}`);
    return path;
  } catch (e) {
    void testApi.track(kind, { ...detail, result: 'error' });
    show(exportErrorText(e));
    return '';
  }
}

/**
 * Xuất một flow .spec.ts thành zip chạy độc lập (npx playwright test) rồi mở thư mục chứa zip, chọn sẵn file. profileId: hồ sơ
 * trình duyệt lấy baseURL, viewport cho config ("" = không dùng hồ sơ). Trả đường dẫn zip ("" khi lỗi).
 */
export async function exportSpecWith(app: string, name: string, profileId: string, show: (msg: string) => void): Promise<string> {
  const path = await exportWith(() => testApi.exportSpec(app, name, profileId), show, 'export_spec', { app, flow: name, profile: profileId !== '' });
  if (path) await openWith(() => testApi.revealFile(path), show, 'reveal_export');
  return path;
}

/** Lỗi khi chia sẻ lượt lên nhóm: lượt che bí mật lỗi có câu riêng, còn lại câu lỗi của đồng bộ. */
export function shareErrorText(e: unknown): string {
  return (e as { code?: string } | null)?.code === 'redaction_failed'
    ? 'Không chia sẻ được: lượt này chứa giá trị bí mật chưa che (che bí mật bị lỗi) nên không được đưa lên kho nhóm. Chạy lại lượt rồi chia sẻ.'
    : syncErrorText(e);
}

/**
 * Chia sẻ evidence của lượt lên kho nhóm. Gói quá ngưỡng (200 MB) thì hỏi xác nhận kèm dung lượng rồi gọi lại với confirm; không
 * đồng ý thì không tải gì. Báo kết quả qua show; trả kết quả đã đẩy (null khi lỗi hoặc huỷ).
 */
export async function shareRunWith(runId: string, show: (msg: string) => void, confirm: (msg: string) => boolean = (m) => window.confirm(m)): Promise<PushRunResult | null> {
  try {
    let res = await testApi.shareRun(runId, false);
    if (res.confirmRequired) {
      const limit = res.limitBytes ? ` (ngưỡng ${fmtBytes(res.limitBytes)})` : '';
      if (!confirm(`Evidence lượt này nặng ${fmtBytes(res.sizeBytes)}${limit}. Vẫn đẩy cả ảnh, video lên kho nhóm?`)) {
        void testApi.track('share_run', { result: 'declined' });
        return null;
      }
      res = await testApi.shareRun(runId, true);
    }
    void testApi.track('share_run', { result: 'ok', files: res.files });
    show(`Đã chia sẻ lượt lên nhóm: ${res.files} tệp (tải lên ${res.uploaded}, đã có ${res.skipped}), ${fmtBytes(res.sizeBytes)}.`);
    return res;
  } catch (e) {
    void testApi.track('share_run', { result: 'error' });
    show(shareErrorText(e));
    return null;
  }
}

/** Ghi chú cạnh trace của flow web lỗi. */
export const TRACE_NOTE = 'Trace Playwright (trace.zip) của flow lỗi chứa giá trị đã gõ, kể cả biến bí mật. Chỉ giữ khi flow lỗi, xoá theo số ngày giữ dữ liệu và không bao giờ có trong gói xuất.';

/** Mở thư mục / báo cáo / file qua Go: lỗi thành câu chung (redaction_failed nói rõ việc mở báo cáo), ghi lịch sử sử dụng kind. */
export async function openWith(fn: () => Promise<void>, show: (msg: string) => void, kind: string, detail: Record<string, unknown> = {}): Promise<boolean> {
  try {
    await fn();
    void testApi.track(kind, { ...detail, result: 'ok' });
    return true;
  } catch (e) {
    void testApi.track(kind, { ...detail, result: 'error' });
    show(openErrorText(e));
    return false;
  }
}

/** Lỗi khi mở báo cáo: lượt che bí mật lỗi thì không sinh evidence.html. */
export function openErrorText(e: unknown): string {
  return (e as { code?: string } | null)?.code === 'redaction_failed'
    ? 'Không mở được báo cáo: lượt này từng che bí mật lỗi nên không sinh báo cáo. Vẫn mở được thư mục lượt.'
    : errorText(e);
}

/** Mở thư mục lượt và mở báo cáo, dùng chung cho dòng lượt chạy và chi tiết lượt. Bấm nút không mở/đóng dòng. */
export function RunOpenButtons({ runId, onOpenFolder, onOpenReport }: { runId: string; onOpenFolder?: (id: string) => void; onOpenReport?: (id: string) => void }) {
  return (
    <>
      {onOpenFolder && (
        <Button
          size="xs"
          variant="secondary"
          icon={<FolderOpen size={13} />}
          onClick={(e) => {
            e.stopPropagation();
            onOpenFolder(runId);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          Mở thư mục
        </Button>
      )}
      {onOpenReport && (
        <Button
          size="xs"
          variant="secondary"
          icon={<FileText size={13} />}
          onClick={(e) => {
            e.stopPropagation();
            onOpenReport(runId);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          Mở báo cáo
        </Button>
      )}
    </>
  );
}

/** Đường dẫn bản vừa xuất kèm nút mở thư mục chứa nó (chọn sẵn file). */
export function ExportedPath({ path, onReveal }: { path: string; onReveal?: () => void }) {
  return (
    <div className="flex items-center gap-[8px] rounded-[6px] bg-muted-box px-[8px] py-[5px]" data-testid="exported-path">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]/[15px] text-text-2" title={path}>
        Đã lưu {path}
      </span>
      {onReveal && (
        <Button size="xs" variant="secondary" icon={<FolderOpen size={13} />} onClick={onReveal}>
          Mở thư mục
        </Button>
      )}
    </div>
  );
}

/** Ảnh đã tải trong phiên (khoá runId/relPath): mở lại chi tiết không phải đọc lại file. */
export const shotCache = new Map<string, string>();

/** Ảnh thu nhỏ của một bước: chỉ tải khi cuộn tới (IntersectionObserver), bấm để phóng to. */
function ShotThumb({ runId, rel, label, onOpen }: { runId: string; rel: string; label: string; onOpen: (src: string, label: string) => void }) {
  const key = `${runId}/${rel}`;
  const [src, setSrc] = useState(() => shotCache.get(key) ?? '');
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (src || failed) return;
    const load = () =>
      testApi.stepShot(runId, rel).then(
        (s) => {
          shotCache.set(key, s);
          setSrc(s);
        },
        () => setFailed(true),
      );
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      void load();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) {
        io.disconnect();
        void load();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [key, runId, rel, src, failed]);
  return (
    <button
      ref={ref}
      type="button"
      disabled={!src}
      onClick={() => src && onOpen(src, label)}
      title={src ? `${label} · bấm để phóng to` : label}
      data-shot={rel}
      className="stroke-in flex h-[72px] w-[48px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-chip-neutral text-[10px]/[12px] text-text-3"
    >
      {src ? <img src={src} alt={label} className="h-full w-full object-cover" /> : failed ? 'Lỗi ảnh' : label}
    </button>
  );
}

/** Đường dẫn tương đối của một file trong thư mục lượt (Go ghi cây UI lúc lỗi ra file), không phải nội dung. */
const isRunFile = (v: string) => !v.includes('\n') && /^[\w.-]+(\/[\w.-]+)*\.(txt|json|xml|yaml)$/.test(v);

/** Cây aria lúc bước web lỗi (thu gọn): nội dung thì hiện chữ đơn cách; đường dẫn file thì chỉ chỗ lưu và nút mở thư mục lượt. */
function AriaSnapshot({ value, runId, onOpenFolder }: { value: string; runId: string; onOpenFolder?: () => void }) {
  const file = isRunFile(value);
  // Đường dẫn file thì đọc nội dung khi mở lần đầu; đọc lỗi thì giữ cách hiện đường dẫn.
  const [text, setText] = useState<string | null>(null);
  const loaded = useRef(false);
  const load = () => {
    if (!file || loaded.current) return;
    loaded.current = true;
    testApi.stepText(runId, value).then(setText, () => {});
  };
  return (
    <details data-testid="aria-snapshot" onToggle={(e) => e.currentTarget.open && load()}>
      <summary className="cursor-pointer text-[11px]/[14px] text-text-3">Cây aria lúc lỗi</summary>
      {file && text === null ? (
        <div className="mt-[4px] flex flex-wrap items-center gap-[8px]">
          <span className="text-[11.5px]/[15px] text-text-2">
            Lưu ở <span className="font-mono">{value}</span> trong thư mục lượt chạy.
          </span>
          {onOpenFolder && (
            <Button size="xs" variant="secondary" icon={<FolderOpen size={13} />} onClick={onOpenFolder}>
              Mở thư mục lượt chạy
            </Button>
          )}
        </div>
      ) : (
        <pre className="mt-[4px] max-h-[260px] overflow-auto rounded-[6px] bg-chip-neutral px-[8px] py-[6px] font-mono text-[11px]/[14px] whitespace-pre text-text-2">{text ?? value}</pre>
      )}
    </details>
  );
}

function StepRow({ s, runId, onOpen, web, onOpenFolder }: { s: StepRun; runId: string; onOpen: (src: string, label: string) => void; web?: boolean; onOpenFolder?: () => void }) {
  const title = s.label || [s.command, s.desc].filter(Boolean).join(' · ');
  return (
    <li className="flex gap-[10px] border-t border-divider py-[6px] first:border-t-0" style={{ paddingLeft: s.depth * 14 }} data-testid="step">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex items-center gap-[8px]">
          <StateBadge state={s.passed ? 'passed' : 'failed'} />
          <span className="min-w-0 flex-1 truncate text-[12px]/[16px] text-text" title={title}>
            <span className="font-mono text-text-3">{s.index + 1}.</span> {title}
          </span>
          <span className="shrink-0 font-mono text-[11.5px]/[15px] text-text-2">{fmtMs(s.durationMs)}</span>
        </div>
        {(s.selector || s.element) && (
          <p className="truncate font-mono text-[11px]/[14px] text-text-3" title={s.element}>
            {s.selector}
            {s.selector && s.element ? ' → ' : ''}
            {s.element}
          </p>
        )}
        {!s.passed && (s.error || s.errorType) && (
          <p className="text-[11.5px]/[15px] text-red">
            {s.errorType ? <b className="font-mono font-semibold">{s.errorType}</b> : null}
            {s.errorType && s.error ? ': ' : ''}
            {s.error}
          </p>
        )}
        {s.suggestion && <p className="text-[11.5px]/[15px] text-text-2">Gợi ý: {s.suggestion}</p>}
        {s.yaml && (
          <details>
            <summary className="cursor-pointer text-[11px]/[14px] text-text-3">YAML</summary>
            <pre className="mt-[4px] overflow-auto rounded-[6px] bg-chip-neutral px-[8px] py-[6px] font-mono text-[11px]/[14px] text-text-2">{s.yaml}</pre>
          </details>
        )}
        {web && !s.passed && s.hierarchy && <AriaSnapshot value={s.hierarchy} runId={runId} onOpenFolder={onOpenFolder} />}
      </div>
      {(s.shotBefore || s.shotAfter) && (
        <div className="flex shrink-0 gap-[6px]">
          {s.shotBefore && <ShotThumb runId={runId} rel={s.shotBefore} label="Trước" onOpen={onOpen} />}
          {s.shotAfter && <ShotThumb runId={runId} rel={s.shotAfter} label="Sau" onOpen={onOpen} />}
        </div>
      )}
    </li>
  );
}

function FlowTimeline({
  f,
  onOpen,
  onOpenFolder,
  onExportSpec,
  reqs = [],
  onNote,
}: {
  f: FlowRun;
  onOpen: (src: string, label: string) => void;
  onOpenFolder?: (id: string) => void;
  onExportSpec?: (f: FlowRun) => void;
  /** Mã yêu cầu nối với flow (qua ca kiểm thử). */
  reqs?: string[];
  onNote?: (f: FlowRun, reqs: string[]) => void;
}) {
  const steps = f.steps ?? [];
  const web = f.platform === 'web';
  const openFolder = onOpenFolder ? () => onOpenFolder(f.runId) : undefined;
  return (
    <details open={!f.passed} className="border-t border-divider py-[6px] first:border-t-0" data-testid="flow-run">
      <summary className="flex cursor-pointer items-center gap-[8px] text-[12px]/[16px]">
        <StateBadge state={f.passed ? 'passed' : 'failed'} />
        <span className="min-w-0 flex-1 truncate font-mono text-text-2">
          {f.deviceId} · lần {f.iteration} · {f.flow}
        </span>
        <span className="shrink-0 font-mono text-[11.5px]/[15px] text-text-2">{fmtMs(f.durationMs)}</span>
      </summary>
      {f.error && <p className="mt-[4px] text-[11.5px]/[15px] text-red">{f.error}</p>}
      {((onExportSpec && isSpecFlow(f.flow)) || (onNote && !f.passed && reqs.length > 0)) && (
        <div className="mt-[4px] flex flex-wrap gap-[6px]">
          {onExportSpec && isSpecFlow(f.flow) && (
            <Button size="xs" variant="secondary" icon={<PackageOpen size={13} />} onClick={() => onExportSpec(f)}>
              Xuất chạy độc lập
            </Button>
          )}
          {/* Lỗi có thể do tài liệu sai chứ không phải app sai: ghi chú gắn vào yêu cầu của ca. */}
          {onNote && !f.passed && reqs.length > 0 && (
            <Button size="xs" variant="secondary" icon={<MessageSquareWarning size={13} />} onClick={() => onNote(f, reqs)} title={`Yêu cầu: ${reqs.join(', ')}`}>
              Nguồn có thể sai
            </Button>
          )}
        </div>
      )}
      {web && f.trace && (
        <div className="mt-[4px] flex flex-wrap items-center gap-[8px] rounded-[6px] bg-amber-soft px-[8px] py-[5px]" data-testid="trace-row">
          <p className="min-w-0 flex-1 text-[11px]/[15px] text-text-2">{TRACE_NOTE}</p>
          {openFolder && (
            <Button size="xs" variant="secondary" icon={<FolderOpen size={13} />} onClick={openFolder}>
              Mở thư mục lượt chạy
            </Button>
          )}
        </div>
      )}
      {steps.length === 0 ? (
        <Muted>Không có bước nào được ghi.</Muted>
      ) : (
        <ol className="mt-[4px]">
          {steps.map((s, i) => (
            <StepRow key={i} s={s} runId={f.runId} onOpen={onOpen} web={web} onOpenFolder={openFolder} />
          ))}
        </ol>
      )}
    </details>
  );
}

/** Lớp phóng to ảnh: bấm bất kỳ đâu hoặc Esc để đóng. */
function Lightbox({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-label={label} className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-[24px]" onClick={onClose}>
      <img src={src} alt={label} className="max-h-full max-w-full rounded-[8px] shadow-popup" />
    </div>
  );
}

export function RunDetailView({
  report,
  exporting,
  onExport,
  exported,
  onReveal,
  onOpenFolder,
  onOpenReport,
  onExportSpec,
  noteReqs,
  onNote,
  onShare,
  sharing,
  onClose,
}: {
  report: RunReport;
  exporting?: boolean;
  onExport?: () => void;
  /** Đường dẫn gói vừa xuất (trong thư mục exports). */
  exported?: string;
  onReveal?: () => void;
  onOpenFolder?: (id: string) => void;
  onOpenReport?: (id: string) => void;
  /** Xuất flow .spec.ts thành zip chạy độc lập; không có (thiếu quyền chạy flow) = không hiện nút. */
  onExportSpec?: (f: FlowRun) => void;
  /** Mã yêu cầu theo tên flow (từ ma trận độ phủ của app). */
  noteReqs?: Record<string, string[]>;
  /** Mở ghi chú "nguồn có thể sai" cho flow lỗi nối yêu cầu; không có (thiếu quyền chạy flow) = không hiện nút. */
  onNote?: (f: FlowRun, reqs: string[]) => void;
  /** Chia sẻ evidence lên kho nhóm; không có (chưa cấu hình đồng bộ, thiếu quyền) = không hiện nút. */
  onShare?: () => void;
  sharing?: boolean;
  onClose?: () => void;
}) {
  const [zoom, setZoom] = useState<{ src: string; label: string } | null>(null);
  const open = useCallback((src: string, label: string) => setZoom({ src, label }), []);
  const { run } = report;
  const flows = report.flows ?? [];
  return (
    <div className="flex flex-col gap-[8px] rounded-[8px] bg-bg px-[10px] py-[8px]" data-testid="run-detail">
      <div className="flex flex-wrap items-center gap-[8px]">
        <p className="min-w-0 flex-1 text-[11.5px]/[15px] text-text-3">
          <span className="font-mono">{run.id}</span> · {timeOf(run.startedAt)} → {timeOf(run.finishedAt)} · ảnh{' '}
          {run.artifacts ? ARTIFACT_LABEL[run.artifacts] : 'chỉ khi lỗi (lượt cũ)'}
        </p>
        <RunOpenButtons runId={run.id} onOpenFolder={onOpenFolder} onOpenReport={onOpenReport} />
        {onExport && (
          <Button size="xs" variant="secondary" disabled={exporting} onClick={onExport} icon={<Download size={13} />}>
            {exporting ? 'Đang xuất…' : 'Xuất gói báo cáo'}
          </Button>
        )}
        {onShare && (
          <Button size="xs" variant="secondary" disabled={sharing} onClick={onShare} icon={<Share2 size={13} />}>
            {sharing ? 'Đang chia sẻ…' : 'Chia sẻ lên nhóm'}
          </Button>
        )}
        {onClose && (
          <Button size="xs" variant="secondary" onClick={onClose} icon={<X size={13} />}>
            Đóng
          </Button>
        )}
      </div>
      {onExport && <p className="text-[11px]/[14px] text-text-3">{SHOT_NOTE}</p>}
      {onShare && <p className="text-[11px]/[14px] text-text-3">{TEAM_SHOT_NOTE}</p>}
      {exported && <ExportedPath path={exported} onReveal={onReveal} />}
      {flows.length === 0 ? <Muted>Lượt này chưa ghi flow nào.</Muted> : <div>{flows.map((f, i) => <FlowTimeline key={i} f={f} onOpen={open} onOpenFolder={onOpenFolder} onExportSpec={onExportSpec} reqs={noteReqs ? reqsOfFlow(noteReqs, f.flow) : []} onNote={onNote} />)}</div>}
      {zoom && <Lightbox src={zoom.src} label={zoom.label} onClose={() => setZoom(null)} />}
    </div>
  );
}

/** Mở thư mục lượt / báo cáo của lượt, lỗi thành toast (dùng cho dòng lượt chạy và chi tiết lượt). */
export function useRunOpeners(show: (msg: string) => void) {
  return {
    openFolder: useCallback((id: string) => void openWith(() => testApi.openRunFolder(id), show, 'open_run_folder', { runId: id }), [show]),
    openReport: useCallback((id: string) => void openWith(() => testApi.openRunReport(id), show, 'open_run_report', { runId: id }), [show]),
  };
}

/** Chi tiết lượt đang mở trong danh sách Lượt chạy gần nhất. */
export function RunDetail({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { show } = useToast();
  const canRun = useSession().can('cqs.run');
  const openers = useRunOpeners(show);
  const [report, setReport] = useState<RunReport | null>(null);
  const [error, setError] = useState<unknown>();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState('');
  const [noteReqs, setNoteReqs] = useState<Record<string, string[]>>({});
  const [noteFor, setNoteFor] = useState<{ flow: string; reqs: string[] } | null>(null);
  const [syncReady, setSyncReady] = useState(false);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    // Nút chia sẻ chỉ khi đã cấu hình đồng bộ nhóm; core cũ chưa có đồng bộ hoặc lỗi đọc thì ẩn.
    if (!canRun) return;
    let live = true;
    testApi.syncConfig().then(
      (c) => live && setSyncReady(c.configured && c.prefix !== ''),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [canRun]);
  useEffect(() => {
    let live = true;
    setReport(null);
    setNoteReqs({});
    setNoteFor(null);
    setError(undefined);
    setExported('');
    testApi.report(runId).then(
      (r) => {
        if (!live) return;
        setReport(r);
        // Flow nào nối yêu cầu nào (qua ca): core cũ chưa có truy vết hoặc lỗi đọc thì không hiện nút ghi chú.
        if (canRun && (r.flows ?? []).some((f) => !f.passed))
          testApi.coverage(r.run.app).then(
            (c) => live && setNoteReqs(flowReqs(c)),
            () => undefined,
          );
      },
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [runId, canRun]);
  const exportRun = async () => {
    setExporting(true);
    const path = await exportWith(() => testApi.exportRun(runId), show, 'export_run', { runId });
    if (path) setExported(path);
    setExporting(false);
  };
  const share = async () => {
    setSharing(true);
    await shareRunWith(runId, show);
    setSharing(false);
  };
  if (error) return <p className="text-[12px]/[16px] text-red">{errorText(error)}</p>;
  if (!report) return <Muted>Đang tải chi tiết lượt…</Muted>;
  return (
    <>
      <RunDetailView
        report={report}
        exporting={exporting}
        onExport={() => void exportRun()}
        exported={exported}
        onReveal={() => void openWith(() => testApi.revealFile(exported), show, 'reveal_export')}
        onOpenFolder={openers.openFolder}
        onOpenReport={openers.openReport}
        // Thiết bị web là hồ sơ trình duyệt cùng mã: bản xuất lấy baseURL, viewport của hồ sơ đã chạy flow.
        onExportSpec={canRun ? (f) => void exportSpecWith(report.run.app, f.flow, f.platform === 'web' ? f.deviceId : '', show) : undefined}
        noteReqs={noteReqs}
        onNote={canRun ? (f, reqs) => setNoteFor({ flow: f.flow, reqs }) : undefined}
        onShare={canRun && syncReady ? () => void share() : undefined}
        sharing={sharing}
        onClose={onClose}
      />
      {noteFor && <NoteDialog app={report.run.app} runId={report.run.id} flow={noteFor.flow} reqs={noteFor.reqs} onClose={() => setNoteFor(null)} />}
    </>
  );
}

/** Số ngày lịch sử xuất được: khớp ExportHistory (Go) 1..3650. */
export const validHistoryDays = (n: number) => Number.isInteger(n) && n >= 1 && n <= 3650;

/** Xuất lịch sử phân tích (lượt, bước, sổ AI, sổ tool, lịch sử sử dụng) N ngày gần nhất ra một file JSON. */
export function ExportHistoryCard() {
  const { show } = useToast();
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const n = Number(days);
  const ok = validHistoryDays(n);
  const run = async () => {
    if (!ok) return;
    setBusy(true);
    const path = await exportWith(() => testApi.exportHistory(n), show, 'export_history', { days: n });
    if (path) setSaved(path);
    setBusy(false);
  };
  return (
    <Card
      title="Xuất lịch sử phân tích"
      aside={
        <Button size="xs" variant="secondary" icon={<FolderOpen size={13} />} onClick={() => void openWith(testApi.openExportsFolder, show, 'open_exports_folder')}>
          Mở thư mục xuất
        </Button>
      }
    >
      <Muted>
        Một file JSON gồm lượt chạy, từng bước, sổ gọi AI, sổ gọi tool và lịch sử sử dụng trên máy này, đã che giá trị bí mật trong văn bản. File lưu
        trong thư mục xuất của app; không gửi đi đâu cả, cần gửi thì tự gửi file.
      </Muted>
      <div className="flex items-end gap-[10px]">
        <Input label="Số ngày gần nhất" type="number" min={1} max={3650} value={days} invalid={!ok} onChange={(e) => setDays(e.target.value)} />
        <Button disabled={busy || !ok} onClick={() => void run()} icon={<Download size={15} />}>
          {busy ? 'Đang xuất…' : 'Xuất lịch sử phân tích'}
        </Button>
      </div>
      {!ok && <p className="text-[11.5px]/[15px] text-red">Từ 1 đến 3650 ngày.</p>}
      {saved && <ExportedPath path={saved} onReveal={() => void openWith(() => testApi.revealFile(saved), show, 'reveal_export')} />}
    </Card>
  );
}
