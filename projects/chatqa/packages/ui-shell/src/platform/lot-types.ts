// Kiểu của phân hệ Gộp lô: khớp JSON của apps/hs-desk/desktop/internal/modules/lot (service.go và các kiểu nó trả).
// Đổi tên trường ở Go thì sửa ở đây cùng lúc. Giờ dạng Unix giây; số (số lượng, trị giá, thuế suất) là chuỗi thập phân
// dấu chấm (num.Dec ở Go, không bao giờ qua float).
//
// Lỗi mang khoá câu (contracts/errors.json, map lotMerge) và tham số theo đúng chữ trong ngoặc nhọn của câu
// (vd { 'mã VPO': 'VPO-1' }); dữ liệu kèm (dòng vướng, cảnh báo, tab) đi dưới khoá "_data".
import { parseErrorCode, parseErrorParams } from '../lib/errors';
import { ApiError } from './types';

export type Dec = string;

export interface LotPerson {
  id: string;
  name: string;
}

export type LotStatus = 'merging' | 'ready' | 'exported' | 'exported_pending' | 'cancelled';
export type LineStateKind = 'waiting' | 'merged' | 'single' | 'error' | 'excluded';
export type LotTarget = 'board' | 'reconcile' | 'cancelled';

export interface Sums {
  lines: number;
  qty: Record<string, Dec>;
  value: Record<string, Dec>;
}

export interface Totals {
  source: Sums;
  merged: Sums;
  single: Sums;
  excluded: Sums;
  open: Sums;
  groups: number;
  balanced: boolean;
}

export interface OverlayField {
  sheet: string;
  used: string;
  source: 'sheet' | 'quote' | 'tariff';
}

export interface HoldInfo {
  user: LotPerson;
  since: number;
  epoch: number;
}

export interface OtherLotFlag {
  lotId: string;
  code: string;
  holder: string;
}

export interface LotLine {
  id: string;
  key: string;
  vpo: string;
  row: number;
  status?: string;
  product: string;
  spec?: string;
  declaredName?: string;
  hs: string;
  importTax: Dec;
  hasImportTax: boolean;
  vat: Dec;
  hasVat: boolean;
  unit: string;
  maker?: string;
  qty: Dec;
  unitPrice: Dec;
  hasUnitPrice: boolean;
  value: Dec;
  currency: string;
  link?: string;
  bad?: string[];
  state: LineStateKind;
  group?: string;
  issues?: string[];
  warnings?: string[];
  flags?: string[];
  deferred?: boolean;
  itemId?: string;
  overlay?: Record<string, OverlayField>;
  taxDate?: string;
  name?: string;
  nameManual?: boolean;
  nameChars?: number;
  excludeReason?: string;
  excludeNote?: string;
  excludedNote?: string;
  otherLot?: OtherLotFlag;
}

export interface LotConfirm {
  kind: 'size' | 'price' | 'zeroPrice';
  id?: string;
  vpo?: string;
  pct?: string;
  limit?: string;
}

export interface LotGroup {
  id: string;
  ids: string[];
  unit: string;
  currency: string;
  hs: string;
  qty: Dec;
  value: Dec;
  avgPrice: Dec;
  name: string;
  manual: boolean;
  chars: number;
  tooLong: boolean;
  confirms?: LotConfirm[];
  unmeasured?: number;
  by: LotPerson;
  at: number;
}

export interface PendingOp {
  id: string;
  kind: string;
  by: LotPerson;
  at: number;
  text: string;
}

export interface JournalEntry {
  opId: string;
  kind: string;
  by: LotPerson;
  at: number;
  detail?: Record<string, unknown>;
  rejected?: string;
  pending?: boolean;
}

export interface LotState {
  id: string;
  code: string;
  status: LotStatus;
  sheetId: string;
  tab: string;
  title: string;
  criteriaId: string;
  criteriaVersion: number;
  createdBy: LotPerson;
  createdAt: number;
  holder?: HoldInfo;
  lastHolder: LotPerson;
  epoch: number;
  maxSeq: number;
  lines: LotLine[];
  groups: LotGroup[];
  totals: Totals;
  pending: PendingOp[];
  journal: JournalEntry[];
  lastOpenedDay?: string;
  lastLoadAt: number;
  quoteAsOf: number;
  readyAt?: number;
  /** Lịch sử xuất theo thứ tự gấp: bản cuối là hiện hành khi lô Đã xuất, mọi bản khác "đã thay thế". */
  exports?: ExportView[];
}

export interface LineCounts {
  waiting: number;
  merged: number;
  single: number;
  error: number;
  excluded: number;
  groups: number;
}

export interface LotSummary {
  id: string;
  code: string;
  status: LotStatus;
  statusLabel: string;
  holder?: HoldInfo;
  holderLive: boolean;
  openedLabel: string;
  daysUnopened: number;
  target: LotTarget;
  counts: LineCounts;
  createdAt: number;
  createdBy: LotPerson;
  pending: number;
}

export interface CheckCounts {
  total: number;
  valid: number;
  missingHs: number;
  missingTax: number;
  duplicate: number;
  badNumber: number;
  missingUnitCurrency: number;
  valueMismatch: number;
}

export interface CheckRow {
  id: string;
  key: string;
  vpo: string;
  row: number;
  product: string;
  hs: string;
  issues: string[] | null;
  warnings: string[] | null;
  overlay?: Record<string, OverlayField>;
  itemId?: string;
  deferred?: boolean;
  duplicates?: string[];
  taxDate?: string;
  applyDate?: string;
  excludedNote?: string;
}

export interface OtherLotGroup {
  lotCode: string;
  n: number;
  ids: string[];
}

export interface CheckResult {
  draftId: string;
  sheetTitle: string;
  tab: string;
  counts: CheckCounts;
  droppedByStatus: number;
  rows: CheckRow[];
  otherLots: OtherLotGroup[];
  quoteAsOf: number;
  quoteOffline: boolean;
  taxLoadedAt?: number;
  canCreate: boolean;
  reason?: string;
  criteriaVersion: number;
}

export interface ChangedLine {
  id: string;
  vpo: string;
  fields: string[];
}

export interface SplitGroup {
  id: string;
  oldName: string;
  manual: boolean;
}

export interface ReloadPreview {
  id: string;
  lotId: string;
  mode: 'add' | 'reload';
  added: CheckRow[];
  addedCounts: CheckCounts;
  changed: ChangedLine[];
  removed: string[];
  groupsToSplit: SplitGroup[];
  otherLots: OtherLotGroup[];
  quoteAsOf: number;
  quoteOffline: boolean;
}

export interface SourceCheck {
  lotId: string;
  at: number;
  loadAt: number;
  changed: Record<string, string[]>;
  left: string[];
  skipped: boolean;
  since?: number;
  message?: string;
}

export interface ReadySummary {
  changedOnSheet: number;
  unmeasuredGroups: number;
  confirmedWarnings: number;
}

export interface ReadyResult {
  done: boolean;
  summary: ReadySummary;
  check?: SourceCheck;
  state: LotState | null;
}

export interface HoldView {
  holder?: HoldInfo;
  live: boolean;
  /** Người đăng nhập giữ lô trên máy này (sửa được). */
  mine: boolean;
  /** Người đăng nhập giữ lô nhưng chưa trên máy này (máy khác, hoặc vừa được chuyển quyền): cần Nhận giữ trên máy này. */
  mineElsewhere: boolean;
}

export interface PendingResult {
  state: LotState;
  done: number;
  invalid: Record<string, string>;
}

export interface Tolerance {
  kind: '%' | 'len';
  value: Dec;
  unit?: 'mm' | 'cm' | 'm';
}

export interface CategoryTolerance extends Tolerance {
  hsPrefix: string;
}

export interface Naming {
  colorWords: string[];
  materialWords: string[];
}

export interface Criteria {
  id: string;
  parent?: string;
  version: number;
  defaultTolerance: Tolerance;
  categoryTolerances: CategoryTolerance[];
  priceThreshold: Dec;
  includeStatuses: string[];
  naming: Naming;
  savedBy: LotPerson;
  savedAt: number;
}

export interface CriteriaView {
  active?: Criteria;
  default: Criteria;
  versions: Criteria[];
  canManage: boolean;
}

export interface PreviewName {
  group: string;
  oldName: string;
  newName: string;
}

export interface CriteriaPreview {
  sample: string;
  groups: number;
  sizeWarnings: number;
  priceWarnings: number;
  baseSizeWarnings: number;
  basePriceWarnings: number;
  changed: PreviewName[];
}

/** Cảnh báo của một lần gộp / thêm dòng (dữ liệu kèm lot_merge_warning, E-lot-merge-007). */
export interface MergeWarnings {
  size: { id: string; vpo: string; pct: string; dev: string; tol: string; len: boolean }[];
  price: { id: string; vpo: string; pct: string; thr: string }[];
  zeroPrice: string[];
  unmeasured: string[];
  violating: string[];
  /** Từng dòng của hộp cảnh báo: khoá câu E-lot-merge-007 (lot_size_warning, lot_size_warning_length, lot_price_warning, lot_zero_price) và tham số. */
  rows: { key: string; params: Record<string, string> }[];
}

/** Chỗ vướng điều kiện bắt buộc (dữ liệu kèm E-lot-merge-006). */
export interface Blocker {
  id: string;
  vpo: string;
  field: string;
  label: string;
  value: string;
  groupValue: string;
}

/** Dòng còn vướng cổng Sẵn sàng đối soát (dữ liệu kèm E-lot-merge-010). */
export interface Blocking {
  kinds: Record<string, string[]>;
  ids: string[];
}

/** Lựa chọn tên khi thêm / bớt dòng ở nhóm đã sửa tay tên. */
export type NameChoice = '' | 'keep' | 'regenerate';


// ---------- Đối soát, truy vết, nhật ký, xuất lô ----------

export type ExportRole = 'merged' | 'report_xlsx' | 'report_pdf';

export interface ExportFile {
  role: ExportRole;
  name: string;
  driveId: string;
  size: number;
  sha256: string;
}

export interface ExportView {
  opId: string;
  version: number;
  files: ExportFile[];
  by: LotPerson;
  at: number;
  current: boolean;
  superseded: boolean;
  flaggedChanged: number;
  confirmedFlagged: boolean;
}

export interface ReportTotals {
  source: Sums;
  after: Sums;
  removed: Sums;
}

export interface ReportBaseline {
  loadId: string;
  mode: 'create' | 'add' | 'reload';
  readAt: number;
  by: LotPerson;
  sheetTitle: string;
  droppedByStatus: number;
  otherLotRows: number;
}

export interface LoadSummary {
  loadId: string;
  mode: 'create' | 'add' | 'reload';
  readAt: number;
  by: LotPerson;
  at: number;
  rows: number;
  added: number;
}

export interface ReportCounts {
  sourceLines: number;
  groups: number;
  mergedLines: number;
  singles: number;
  removed: number;
  open: number;
  afterLines: number;
}

export interface CompareRow {
  kind: 'qty' | 'value';
  key: string;
  source: Dec;
  after: Dec;
  removed: Dec;
  diff: Dec;
}

export interface RemovedLine {
  id: string;
  vpo: string;
  row: number;
  product: string;
  qty: Dec;
  unit: string;
  value: Dec;
  currency: string;
  reason: string;
  note?: string;
  by: LotPerson;
  at: number;
}

export interface FlaggedLine {
  id: string;
  vpo: string;
  row: number;
  product: string;
}

export type MismatchKind = 'missing' | 'duplicate' | 'unknown' | 'removed_in_group' | 'group_total' | 'open' | 'left_sheet';

export interface Mismatch {
  kind: MismatchKind;
  ids?: string[];
  group?: string;
  text: string;
}

export interface ReportCheck {
  checked: boolean;
  at: number;
  skipped: boolean;
  since?: number;
  message?: string;
}

export interface JobView {
  stage: 'generated' | 'accepted' | 'uploaded' | 'done' | 'void' | 'lost';
  version: number;
  localDir: string;
  voidKey?: string;
  voidReason?: string;
}

export interface ReportView {
  lotId: string;
  code: string;
  status: LotStatus;
  statusLabel: string;
  holder?: HoldInfo;
  lastHolder: LotPerson;
  readyAt?: number;
  baseline: ReportBaseline;
  loads: LoadSummary[];
  counts: ReportCounts;
  totals: ReportTotals;
  compare: CompareRow[];
  diff: Sums;
  removed: RemovedLine[];
  mismatches: Mismatch[];
  faulty: number;
  match: boolean;
  flagged: FlaggedLine[];
  check: ReportCheck;
  exports: ExportView[];
  job?: JobView;
  isHolder: boolean;
  canExport: boolean;
  canReopen: boolean;
  canTakeover: boolean;
  exportedAt?: number;
  lostExport?: boolean;
  exportedBy?: string;
}

export interface PreviewFile {
  role: ExportRole;
  name: string;
  optional: boolean;
}

export interface ExportPreview {
  lotId: string;
  status: LotStatus;
  allowed: boolean;
  denyKey?: string;
  denyParams?: Record<string, string>;
  holder: boolean;
  canOffline: boolean;
  match: boolean;
  faulty: number;
  flagged: number;
  templateOk: boolean;
  version: number;
  folder: string;
  files: PreviewFile[];
  job?: JobView;
}

export interface ExportOptions {
  pdf: boolean;
  confirmFlagged: boolean;
  /** Số dòng gốc đã đổi mà người xuất đã thấy khi xác nhận. */
  flaggedCount: number;
}

export interface ExportResult {
  status: 'exported' | 'pending';
  version: number;
  files: { role: ExportRole; name: string; link?: string }[];
  folder: string;
  localDir?: string;
}

export interface TraceLine {
  id: string;
  key: string;
  vpo: string;
  row: number;
  product: string;
  qty: Dec;
  unit: string;
  value: Dec;
  currency: string;
  unitPrice: Dec;
  hasUnitPrice: boolean;
}

export interface GroupTrace {
  id: string;
  name: string;
  manual: boolean;
  hs: string;
  unit: string;
  currency: string;
  qty: Dec;
  value: Dec;
  avgPrice: Dec;
  by: LotPerson;
  at: number;
  confirms?: LotConfirm[];
  lines: TraceLine[];
}

export type TraceKind = 'merged' | 'single' | 'removed' | 'waiting' | 'error';

export interface TraceHit {
  kind: TraceKind;
  line: TraceLine;
  groupId?: string;
  groupName?: string;
  by: LotPerson;
  at: number;
  name?: string;
  reason?: string;
  note?: string;
}

export interface JournalFilter {
  userId: string;
  kinds: string[];
  from: number;
  to: number;
}

export interface JournalRow {
  opId: string;
  kind: string;
  label: string;
  by: LotPerson;
  at: number;
  detail?: string;
  rejected?: string;
  pending?: boolean;
  offline?: boolean;
  syncedAt?: number;
  load?: LoadSummary;
}

export interface JournalKindOption {
  kind: string;
  label: string;
}

export interface JournalView {
  rows: JournalRow[];
  total: number;
  users: LotPerson[];
  kinds: JournalKindOption[];
  empty: boolean;
}

export interface LotApi {
  listLots(): Promise<LotSummary[]>;
  openLot(lotId: string): Promise<LotState>;
  markOpened(lotId: string): Promise<void>;
  readSheet(draftId: string, link: string, tab: string): Promise<CheckResult>;
  discardDraft(draftId: string): Promise<void>;
  draftUseSheet(draftId: string, id: string, field: string): Promise<CheckResult>;
  draftFixLink(draftId: string, id: string): Promise<string>;
  draftReloadFixed(draftId: string, ids: string[]): Promise<CheckResult>;
  draftTaxFill(draftId: string, ids: string[], date: string): Promise<CheckResult>;
  draftDropDuplicate(draftId: string, keep: string): Promise<CheckResult>;
  draftDefer(draftId: string, id: string): Promise<CheckResult>;
  createLot(draftId: string): Promise<LotState>;
  merge(lotId: string, ids: string[], confirm: boolean): Promise<LotState>;
  keepSingle(lotId: string, id: string): Promise<LotState>;
  split(lotId: string, groupId: string, ids: string[], nameChoice: NameChoice): Promise<LotState>;
  undo(lotId: string, groupId: string): Promise<LotState>;
  addLines(lotId: string, groupId: string, ids: string[], confirm: boolean, nameChoice: NameChoice): Promise<LotState>;
  removeLines(lotId: string, groupId: string, ids: string[], nameChoice: NameChoice): Promise<LotState>;
  rename(lotId: string, target: string, text: string): Promise<LotState>;
  exclude(lotId: string, id: string, reason: string, note: string): Promise<LotState>;
  useSheetValue(lotId: string, id: string, field: string): Promise<LotState>;
  taxFillLot(lotId: string, ids: string[], date: string): Promise<LotState>;
  applyLatestCriteria(lotId: string): Promise<LotState>;
  prepareReload(lotId: string, mode: 'add' | 'reload'): Promise<ReloadPreview>;
  applyReload(previewId: string): Promise<LotState>;
  discardReload(previewId: string): Promise<void>;
  checkSource(lotId: string, trigger: 'open' | 'manual'): Promise<SourceCheck>;
  ready(lotId: string, confirm: boolean): Promise<ReadyResult>;
  reopen(lotId: string, reason: string): Promise<LotState>;
  cancel(lotId: string, reason: string): Promise<LotState>;
  holdInfo(lotId: string): Promise<HoldView>;
  claim(lotId: string): Promise<LotState>;
  release(lotId: string): Promise<LotState>;
  takeover(lotId: string, reason: string): Promise<LotState>;
  /** Tên người nhận ghi vào nhật ký lấy từ Worker, không gửi từ giao diện. */
  transfer(lotId: string, toId: string, reason: string): Promise<LotState>;
  holdCandidates(): Promise<LotPerson[]>;
  ping(lotId: string): Promise<LotState>;
  listPending(lotId: string): Promise<PendingOp[]>;
  applyPending(lotId: string, ops: string[]): Promise<PendingResult>;
  discardPending(lotId: string, ops: string[]): Promise<PendingResult>;
  activeCriteria(): Promise<CriteriaView>;
  previewCriteria(draft: Criteria, lotId: string): Promise<CriteriaPreview>;
  saveCriteria(draft: Criteria, parentId: string, force: boolean): Promise<Criteria>;
  reconcileLots(): Promise<LotSummary[]>;
  reconcileReport(lotId: string): Promise<ReportView>;
  traceGroup(lotId: string, groupId: string): Promise<GroupTrace>;
  traceFind(lotId: string, query: string): Promise<TraceHit[]>;
  journal(lotId: string, filter: JournalFilter): Promise<JournalView>;
  prepareExport(lotId: string): Promise<ExportPreview>;
  exportLot(lotId: string, opts: ExportOptions): Promise<ExportResult>;
  /** Lưu một tệp của lần xuất ra máy; trả đường dẫn, "" khi người dùng huỷ hộp thoại lưu. */
  downloadExport(lotId: string, version: number, role: ExportRole): Promise<string>;
  reloadChanged(lotId: string): Promise<LotState>;
  openExportFile(lotId: string, version: number, role: ExportRole): Promise<void>;
  abandonExport(lotId: string): Promise<void>;
}

/** Tên hàm Go (lot.Service.<Hàm>) của từng hàm LotApi (test Go đối chiếu với các hàm exported của service.go). */
export const LOT_METHODS: Record<keyof LotApi, string> = {
  listLots: 'ListLots',
  openLot: 'OpenLot',
  markOpened: 'MarkOpened',
  readSheet: 'ReadSheet',
  discardDraft: 'DiscardDraft',
  draftUseSheet: 'DraftUseSheet',
  draftFixLink: 'DraftFixLink',
  draftReloadFixed: 'DraftReloadFixed',
  draftTaxFill: 'DraftTaxFill',
  draftDropDuplicate: 'DraftDropDuplicate',
  draftDefer: 'DraftDefer',
  createLot: 'CreateLot',
  merge: 'Merge',
  keepSingle: 'KeepSingle',
  split: 'Split',
  undo: 'Undo',
  addLines: 'AddLines',
  removeLines: 'RemoveLines',
  rename: 'Rename',
  exclude: 'Exclude',
  useSheetValue: 'UseSheetValue',
  taxFillLot: 'TaxFillLot',
  applyLatestCriteria: 'ApplyLatestCriteria',
  prepareReload: 'PrepareReload',
  applyReload: 'ApplyReload',
  discardReload: 'DiscardReload',
  checkSource: 'CheckSource',
  ready: 'Ready',
  reopen: 'Reopen',
  cancel: 'Cancel',
  holdInfo: 'HoldInfo',
  claim: 'Claim',
  release: 'Release',
  takeover: 'Takeover',
  transfer: 'Transfer',
  holdCandidates: 'HoldCandidates',
  ping: 'Ping',
  listPending: 'ListPending',
  applyPending: 'ApplyPending',
  discardPending: 'DiscardPending',
  activeCriteria: 'ActiveCriteria',
  previewCriteria: 'PreviewCriteria',
  saveCriteria: 'SaveCriteria',
  reconcileLots: 'ReconcileLots',
  reconcileReport: 'ReconcileReport',
  traceGroup: 'TraceGroup',
  traceFind: 'TraceFind',
  journal: 'Journal',
  prepareExport: 'PrepareExport',
  exportLot: 'ExportLot',
  downloadExport: 'DownloadExport',
  reloadChanged: 'ReloadChanged',
  openExportFile: 'OpenExportFile',
  abandonExport: 'AbandonExport',
};

/** Lỗi của Gộp lô: khoá câu, tham số (chữ trong ngoặc nhọn của câu) và dữ liệu kèm. */
export class LotError extends ApiError {
  constructor(code: string, params: Record<string, string | number> = {}, public data?: unknown) {
    super(code, 0, params);
  }
}

/** Lỗi Go "khoá: {JSON tham số}" -> LotError; tham số "_data" thành dữ liệu kèm. Lỗi của lõi ("k=v") đọc như cũ. */
export function parseLotError(msg: string): LotError {
  const code = parseErrorCode(msg);
  const detail = /^\s*[a-z][a-z0-9_]*\s*:\s*(.*)$/s.exec(msg)?.[1] ?? '';
  if (detail.startsWith('{')) {
    try {
      const raw = JSON.parse(detail) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const params: Record<string, string> = {};
        let data: unknown;
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (k === '_data') data = v;
          else params[k] = String(v);
        }
        return new LotError(code, params, data);
      }
    } catch {
      // không phải JSON: đọc như lỗi của lõi
    }
  }
  return new LotError(code, parseErrorParams(msg));
}
