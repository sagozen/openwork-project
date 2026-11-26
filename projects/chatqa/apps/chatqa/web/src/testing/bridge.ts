// Cầu nối tới App 2 - Kiểm thử ở Go (window.go.test.Service.*, apps/chatqa/desktop/internal/modules/test).
// Riêng ChatQASoftware nên không nằm trong Platform dùng chung. Kiểu dưới đây khớp JSON của testengine (Go).
import { goFn } from '@shell/platform/desktop';
import { goCall, goError } from '../live/bridge';
import { SYNC_EVENT, syncApi, type SyncProgress } from '../sync/sync-api';

export interface Stat {
  key: string;
  count: number;
  passed: number;
  p50Ms: number;
  p95Ms: number;
  passRate: number;
}

export interface MetricsSummary {
  byDevice: Stat[] | null;
  byDeviceCount: Stat[] | null;
  coldVsWarm: Stat[] | null;
  driverStart: Stat;
  tapSteps: Stat;
  stepFailures: Stat[] | null;
  maxParallelOk: number;
  maxRssMB: number;
  cpuMsPerRun: number;
}

export interface RunRecord {
  id: string;
  app: string;
  startedAt: string;
  finishedAt: string;
  devices: number;
  repeat: number;
  passed: number;
  failed: number;
  canceled: boolean;
  label?: string;
  /** Mức ảnh theo bước của lượt; trống với lượt lưu trước khi có evidence. */
  artifacts?: ArtifactsMode;
}

/** Mức chụp ảnh/cây UI theo bước (RunRequest.artifacts): mọi bước, chỉ bước lỗi, không chụp. */
export type ArtifactsMode = 'always' | 'on-failure' | 'never';

export interface TestEvent {
  runId: string;
  kind: 'run_start' | 'flow_start' | 'step' | 'flow_end' | 'device_error' | 'run_end' | 'takeover_paused' | 'takeover_resumed';
  /** Giờ engine phát (RFC3339). */
  at?: string;
  deviceId?: string;
  flow?: string;
  error?: string;
}

/** Một bước trong flow (testengine.StepRun); evidence lấy từ file JSON của runner, trống nếu runner không ghi. */
export interface StepRun {
  index: number;
  depth: number;
  command: string;
  desc: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  label?: string;
  yaml?: string;
  /** "kiểu=giá trị", vd text=Đăng nhập. */
  selector?: string;
  element?: string;
  errorType?: string;
  suggestion?: string;
  /** Đường dẫn tương đối trong thư mục lượt (dấu /), đọc bằng testApi.stepShot. */
  shotBefore?: string;
  shotAfter?: string;
  hierarchy?: string;
  startedAt?: string;
}

/** Một flow trên một máy ở một lần lặp (testengine.FlowRun). */
export interface FlowRun {
  runId: string;
  deviceId: string;
  platform: string;
  driver: string;
  flow: string;
  iteration: number;
  passed: boolean;
  durationMs: number;
  failureClass?: string;
  error?: string;
  /** trace.zip của flow web lỗi (đường dẫn tuyệt đối, Go tính khi đọc báo cáo, không lưu DB). Chứa giá trị đã gõ. */
  trace?: string;
  steps?: StepRun[] | null;
}

export interface RunReport {
  run: RunRecord;
  flows: FlowRun[] | null;
}

export interface StepInsight {
  flow: string;
  /** "lệnh selector" hoặc mô tả bước (đã che). */
  step: string;
  command: string;
  count: number;
  failed: number;
  failRate: number;
  runs: number;
  failedRuns: number;
  p50Ms: number;
  p95Ms: number;
  topErrorType?: string;
  lastError?: string;
  lastSuggestion?: string;
}

export interface RepairInsight {
  app: string;
  flow: string;
  calls: number;
  errors: number;
  costVnd: number;
}

export interface Insights {
  failingSteps: StepInsight[] | null;
  slowSteps: StepInsight[] | null;
  flakySteps: StepInsight[] | null;
  repairFlows: RepairInsight[] | null;
}

/** Lệnh chạy qua tháp (tower.DispatchRequest): tháp chọn máy rảnh theo filter, kiểm biến rồi chạy nền. */
export interface DispatchRequest {
  app: string;
  /** Trống = mọi flow của app. */
  flows: string[];
  devices: string[];
  filter: { platform: string; model: string; count: number };
  env: Record<string, string>;
  secrets: string[];
  repeat: number;
  record: string;
  artifacts: ArtifactsMode;
  label: string;
  timeoutSec: number;
  typingFrequency: number;
}

export interface DispatchTask {
  id: string;
  status: string;
  error?: string;
}

async function call<T>(fn: string, ...args: unknown[]): Promise<T> {
  try {
    return (await goFn(`test.Service.${fn}`)(...args)) as T;
  } catch (e) {
    throw goError(e);
  }
}

/** Loại tài liệu nghiệp vụ (docs.Type*). */
export type DocType = 'PRD' | 'BRD' | 'URD' | 'SRS' | 'AC' | 'other';

/** Một tài liệu trong danh sách (docs.DocInfo). */
export interface DocInfo {
  id: string;
  type: DocType;
  title: string;
  rev: number;
  updatedAt: string;
}

/** Một mục yêu cầu có mã (docs.Requirement); line tính từ 1 trong tệp. */
export interface Requirement {
  id: string;
  doc: string;
  title: string;
  body: string;
  hash: string;
  line: number;
}

/** Tài liệu đầy đủ (docs.Doc): markdown gồm cả front-matter type/title/rev. */
export interface Doc {
  id: string;
  type: DocType;
  title: string;
  rev: number;
  markdown: string;
  requirements: Requirement[];
}

/** Một bản trong lịch sử tài liệu (docs.Revision). */
export interface Revision {
  rev: number;
  at: string;
  size: number;
  current: boolean;
}

export interface ReqIndex {
  reqs: Requirement[];
  /** Mã có ở nhiều tài liệu (đồng bộ từ máy khác): không biên dịch được tới khi đổi mã một bên. */
  duplicates: string[];
}

/** Ghi chú "nguồn có thể sai" (docs.Note). */
export interface Note {
  id: string;
  req: string;
  runId: string;
  flow: string;
  text: string;
  author: string;
  at: string;
  status: 'open' | 'resolved';
}

/** Ca cần xem lại (testengine.AffectedCase): reqs là các mã đã đổi, removed các mã đã bị xoá khỏi tài liệu. */
export interface AffectedCase {
  caseId: string;
  title: string;
  flow?: string;
  reqs: string[];
  removed?: string[];
  reason: 'changed' | 'removed';
}

/** Kết quả chạy gần nhất của flow (testengine.FlowResult). */
export interface FlowResult {
  status: 'passed' | 'failed';
  runId: string;
  at: string;
}

/** Một ca trong ma trận độ phủ (testengine.CaseRef); stale = cần xem lại. */
export interface CaseRef {
  id: string;
  title: string;
  flow?: string;
  status?: string;
  stale: boolean;
  last?: FlowResult;
}

export interface ReqRow {
  id: string;
  doc: string;
  title: string;
  cases: CaseRef[];
}

export interface Coverage {
  reqs: ReqRow[];
  untraced: CaseRef[];
  duplicates: string[];
}

/** Thiết bị cho biên dịch (testengine.Device: Go không đặt tên JSON nên khoá là tên trường). */
export interface EngineDevice {
  ID: string;
  Platform: string;
  Driver: string;
  TeamID?: string;
}

/** testengine.CompileRequest. */
export interface CompileRequest {
  app: string;
  source: string;
  appId: string;
  device: EngineDevice;
  env: Record<string, string>;
  secrets: string[];
  confirmToken: string;
  startPath: string;
  /** Mã yêu cầu đã chọn: có thì nguồn là các yêu cầu này (source để trống). */
  reqs?: string[];
}

export interface CompiledCase {
  case: { id: string; title: string; steps?: string[] | null; expected?: string; reqs?: string[] | null };
  flow?: string;
  status: string;
  risks?: string[] | null;
  error?: string;
  candidate?: string;
  runId?: string;
}

export interface CompileResult {
  sourceHash: string;
  cases: CompiledCase[];
}

const normalizeDoc = (d: Doc): Doc => ({ ...d, requirements: d.requirements ?? [] });

/** Flow web (Playwright Test) chạy trên hồ sơ trình duyệt; flow .yaml chạy trên điện thoại. */
export const isSpecFlow = (name: string) => name.endsWith('.spec.ts');

export const testApi = {
  /** Số đo 30 ngày gần nhất (đủ cho ô 4, không quét toàn bộ lịch sử sau mỗi lượt chạy). */
  metrics: (q: { app?: string; flow?: string; days?: number } = {}) =>
    call<MetricsSummary>('Metrics', { app: q.app ?? '', flow: q.flow ?? '', since: new Date(Date.now() - (q.days ?? 30) * 86_400_000).toISOString() }),
  runs: (limit = 10) => call<RunRecord[] | null>('Runs', limit).then((r) => r ?? []),
  apps: () => call<string[] | null>('Apps').then((r) => r ?? []),
  flows: (app: string) => call<FlowInfo[] | null>('Flows', app).then((r) => r ?? []),
  /** Tên các biến bí mật của flow (không bao giờ có giá trị). */
  secretNames: () => call<string[] | null>('SecretNames').then((r) => r ?? []),
  /** Lưu biến bí mật vào kho của hệ điều hành (DPAPI); giá trị không đọc lại được. */
  setSecret: (name: string, value: string) => call<void>('SetSecret', name, value),
  deleteSecret: (name: string) => call<void>('DeleteSecret', name),
  /** Xuất diff gọn giữa 2 commit của một repo cục bộ (git-impact). Trả cả diff đầy đủ lẫn đường dẫn file đã lưu. */
  gitDiff: (p: GitDiffParams) =>
    call<GitDiffResult>('GitDiff', {
      Repo: p.repo,
      Base: p.base,
      Head: p.head ?? '',
      Paths: p.paths ?? [],
      Ignore: [],
      MergeBase: !!p.mergeBase,
      MaxLines: p.maxLines ?? 0,
      OutDir: '',
    }),
  /** Mở thư mục chứa diff trong Finder/Explorer (path rỗng = thư mục git-impact); trả thư mục đã mở. */
  openDiffFolder: (path = '') => call<string>('OpenDiffFolder', path),
  /** Báo cáo một lượt đã lưu: lượt + flow theo máy/lần lặp, mỗi flow kèm các bước và evidence. */
  report: (runId: string) => call<RunReport>('Report', runId),
  /** Chạy tay qua tháp (chọn máy rảnh, kiểm biến, chạy nền); tiến độ qua "test:event". */
  dispatch: (req: DispatchRequest) => goCall<DispatchTask>('tower.Service.Dispatch', req),
  /** Bước hay lỗi, bước chậm (p95), bước chập chờn, flow hay phải nhờ AI sửa; mặc định 30 ngày. */
  insights: (q: { app?: string; flow?: string; days?: number } = {}) =>
    call<Insights>('Insights', { app: q.app ?? '', flow: q.flow ?? '', device: '', since: new Date(Date.now() - (q.days ?? 30) * 86_400_000).toISOString() }),
  /** Ảnh PNG của một bước dạng data URL (relPath như step.shotBefore). */
  stepShot: (runId: string, relPath: string) => call<string>('StepShot', runId, relPath),
  /** Nội dung tệp văn bản của một bước (cây aria lúc lỗi của flow web; relPath như step.hierarchy). */
  stepText: (runId: string, relPath: string) => call<string>('StepText', runId, relPath),
  /** Số ngày giữ dữ liệu cục bộ (mặc định 90). */
  retention: () => call<number>('Retention'),
  /** Đặt số ngày giữ (7..3650); Go dọn ngay phần cũ hơn. */
  setRetention: (days: number) => call<void>('SetRetention', days),
  /** Xuất gói zip của một lượt vào thư mục exports của app (không hộp lưu); trả đường dẫn đã ghi. */
  exportRun: (runId: string) => call<string>('ExportRun', runId),
  /**
   * Xuất một flow web (.spec.ts) thành zip chạy độc lập bằng `npx playwright test` vào thư mục exports; trả đường dẫn zip.
   * profileId: hồ sơ lấy baseURL, viewport, testIdAttribute cho config ("" = không dùng hồ sơ). Cần quyền chạy flow.
   */
  exportSpec: (app: string, name: string, profileId: string) => call<string>('ExportSpec', app, name, profileId),
  /** Xuất JSON lịch sử N ngày để phân tích vào thư mục exports; trả đường dẫn đã ghi. */
  exportHistory: (days: number) => call<string>('ExportHistory', days),
  /** Mở thư mục của lượt (báo cáo, ảnh, run.jsonl) trong Finder/Explorer. */
  openRunFolder: (runId: string) => call<void>('OpenRunFolder', runId),
  /** Mở evidence.html của lượt bằng trình duyệt mặc định (lượt cũ chưa có thì Go sinh từ dữ liệu trên máy). */
  openRunReport: (runId: string) => call<void>('OpenRunReport', runId),
  /** Mở thư mục exports của app. */
  openExportsFolder: () => call<void>('OpenExportsFolder'),
  /** Mở thư mục chứa một bản xuất và chọn sẵn file (chỉ file trong thư mục exports). */
  revealFile: (path: string) => call<void>('RevealFile', path),
  /**
   * Biên dịch tài liệu thành flow (gọi AI một lần, chạy xác nhận trên thiết bị). Có reqs thì nguồn là các yêu cầu đó (source
   * để trống) và ca được nối mã để truy vết. Vượt trần chi phí: lỗi confirm_required kèm token, gọi lại với confirmToken.
   */
  compile: (req: CompileRequest) => call<CompileResult>('Compile', req).then((r) => ({ ...r, cases: r.cases ?? [] })),
  /** Tài liệu nghiệp vụ của app, sắp theo mã. */
  docs: (app: string) => call<DocInfo[] | null>('Docs', app).then((r) => r ?? []),
  /** Một tài liệu kèm các yêu cầu đã phân tích. */
  doc: (app: string, id: string) => call<Doc>('Doc', app, id).then(normalizeDoc),
  /** Lưu Markdown (tạo mới nếu chưa có); trả bản đã lưu với mã vừa gán cho mục chưa có neo. Cần quyền chạy flow. */
  saveDoc: (app: string, id: string, markdown: string) => call<Doc>('SaveDoc', app, id, markdown).then(normalizeDoc),
  /** Xoá tài liệu; bản cuối vẫn còn trong lịch sử. */
  deleteDoc: (app: string, id: string) => call<void>('DeleteDoc', app, id),
  /** Các bản của tài liệu, mới nhất trước (bản đang dùng có current). */
  docHistory: (app: string, id: string) => call<Revision[] | null>('DocHistory', app, id).then((r) => r ?? []),
  /** Nội dung một bản (cả front-matter); rev 0 = bản đang dùng. */
  docRevision: (app: string, id: string, rev: number) => call<string>('DocRevision', app, id, rev),
  /** Diff theo dòng từ fromRev sang toRev: dòng bắt đầu "  " giữ, "+ " thêm, "- " bỏ; rev 0 = bản đang dùng. */
  docDiff: (app: string, id: string, fromRev: number, toRev: number) => call<string>('DocDiff', app, id, fromRev, toRev),
  /** Mọi yêu cầu của app và các mã trùng giữa nhiều tài liệu. */
  requirements: (app: string) => call<ReqIndex>('Requirements', app).then((r) => ({ reqs: r?.reqs ?? [], duplicates: r?.duplicates ?? [] })),
  /** Ma trận yêu cầu ↔ ca ↔ kết quả chạy gần nhất, ca chưa truy vết và mã trùng. */
  coverage: (app: string) =>
    call<Coverage>('Coverage', app).then((c) => ({
      reqs: (c?.reqs ?? []).map((r) => ({ ...r, cases: r.cases ?? [] })),
      untraced: c?.untraced ?? [],
      duplicates: c?.duplicates ?? [],
    })),
  /** Ca cần xem lại vì yêu cầu đã đổi (changed) hoặc bị xoá (removed). */
  affectedCases: (app: string) => call<AffectedCase[] | null>('AffectedCases', app).then((r) => (r ?? []).map((a) => ({ ...a, reqs: a.reqs ?? [] }))),
  /** Xác nhận ca vẫn đúng với bản yêu cầu hiện tại (không sinh lại, không gọi AI). */
  ackCase: (app: string, caseId: string) => call<void>('AckCase', app, caseId),
  /** Sửa tay mã yêu cầu của ca (rỗng = bỏ truy vết). */
  setCaseReqs: (app: string, caseId: string, reqs: string[]) => call<void>('SetCaseReqs', app, caseId, reqs),
  /** Ghi chú "nguồn có thể sai" của app, mới nhất trước. */
  notes: (app: string) => call<Note[] | null>('Notes', app).then((r) => r ?? []),
  /** Mở ghi chú "nguồn có thể sai" cho một yêu cầu (thường từ lượt chạy lỗi); tác giả là người đang làm. */
  addNote: (app: string, req: string, runId: string, flow: string, text: string) => call<Note>('AddNote', app, req, runId, flow, text),
  /** Đánh dấu ghi chú đã xử lý. */
  resolveNote: (app: string, id: string) => call<Note>('ResolveNote', app, id),
  /** Ghi lịch sử sử dụng (mở trang, thao tác). Không bao giờ ném lỗi: ghi hỏng không được làm hỏng thao tác chính. */
  track: async (kind: string, detail: Record<string, unknown> = {}): Promise<void> => {
    try {
      await call<void>('Track', kind, detail);
    } catch {
      // Bỏ qua: bản web/PWA không có Go, app cũ chưa có Track, hoặc DB bận.
    }
  },
  /** Đồng bộ nhóm qua S3/MinIO (sync/sync-api.ts): cấu hình, khoá chỉ ghi, đẩy/kéo, gộp, chia sẻ và mở evidence lượt nhóm. */
  ...syncApi,
};

export interface GitDiffParams {
  repo: string;
  base: string;
  head?: string;
  paths?: string[];
  mergeBase?: boolean;
  maxLines?: number;
}

export interface GitDiffResult {
  repo: string;
  base: string;
  head: string;
  stats: { files: number; add: number; del: number };
  files: { path: string; st: string; add: number; del: number }[];
  /** Đường dẫn file diff Go đã lưu (tên repo + ngày giờ xuất) trong thư mục git-impact của app. */
  path?: string;
}

export interface FlowInfo {
  app?: string;
  name: string;
  stale?: boolean;
  errors?: { file: string; line?: number; message: string }[] | null;
}

/** Nghe một sự kiện Wails do Go phát; trả hàm huỷ nghe. Ngoài desktop không làm gì. */
function onGoEvent<T>(name: string, cb: (ev: T) => void): () => void {
  const rt = (window as unknown as { runtime?: { EventsOn: (n: string, cb: (d: unknown) => void) => unknown; EventsOff: (n: string) => void } }).runtime;
  if (!rt) return () => undefined;
  const off = rt.EventsOn(name, (d) => cb(d as T));
  return typeof off === 'function' ? (off as () => void) : () => rt.EventsOff(name);
}

/** Nghe tiến độ lượt chạy do Go phát ("test:event"). */
export const onTestEvent = (cb: (ev: TestEvent) => void) => onGoEvent('test:event', cb);

/** Nghe tiến độ đẩy/kéo/chia sẻ của đồng bộ nhóm ("test:sync"), kể cả lần chạy qua MCP hay tự chia sẻ evidence. */
export const onSyncEvent = (cb: (ev: SyncProgress) => void) => onGoEvent(SYNC_EVENT, cb);
