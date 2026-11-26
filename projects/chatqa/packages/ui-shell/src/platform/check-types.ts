// Kiểu của phân hệ Kiểm tra trước khai báo: khớp JSON của apps/hs-desk/desktop/internal/modules/check (service.go và các kiểu nó
// trả) và bộ máy thuần internal/domain/check. Đổi tên trường ở Go thì sửa ở đây cùng lúc. Giờ dạng Unix giây; thuế suất là chuỗi
// thập phân dấu chấm (num.Dec ở Go, không qua float).
//
// Lỗi mang khoá câu (contracts/errors.json) và tham số theo đúng chữ trong ngoặc nhọn của câu; dữ liệu kèm đi dưới khoá "_data".
import { parseErrorCode, parseErrorParams } from '../lib/errors';
import { ApiError } from './types';
import type { ConflictInfo, LessonChoice } from './suggest-types';

/** Lựa chọn ở hộp mâu thuẫn với bài học (cùng tên với suggest). */
export type CheckChoice = LessonChoice;

export interface CheckPerson {
  id: string;
  name: string;
}

export type ListState = 'not_checked' | 'red_open' | 'passed' | 'declared' | 'pending_sync';
export type RowStatus = 'red_open' | 'kept' | 'changed' | 'shortened' | 'syncing' | 'yellow' | 'yellow_seen' | 'green';
export type LotResult = 'not_checked' | 'red_open' | 'passed';
export type WarningLevel = 'red' | 'yellow';
export type WarningKind =
  | 'tariff_missing'
  | 'rate_diff'
  | 'upcoming'
  | 'policy'
  | 'rule'
  | 'lesson'
  | 'pair'
  | 'name_long'
  | 'name_near'
  | 'risk'
  | 'lesson_after_sync'
  | 'history_diff';
export type DecisionKind = 'keep' | 'use' | 'change' | 'shorten' | 'seen' | 'rate';
export type StaleSource = 'tariff' | 'rules' | 'lessons' | 'risk';
export type CheckScope = 'similar' | 'item';
export type RiskLevel = 'high' | 'medium' | 'low';

export interface CheckHold {
  lotId: string;
  exportOp: string;
  epoch: number;
  holderId: string;
  holderName: string;
  device: string;
  since: number;
  stale: boolean;
}

export interface HoldView extends CheckHold {
  mine: boolean;
  cached?: boolean;
}

export interface CheckLotInfo {
  id: string;
  code: string;
  status: string;
  exportOp: string;
  exportVersion: number;
  exportedAt: number;
  exportedBy: CheckPerson;
  lines: number;
  foldedFixes?: string[];
}

export interface CheckCounts {
  green: number;
  yellow: number;
  red: number;
}

export interface CheckListRow extends CheckLotInfo {
  state: ListState;
  openable: boolean;
  holder?: HoldView;
  counts: CheckCounts;
  red: number;
  syncing: number;
  checkedAt: number;
  declareDate: string;
  offlineData: boolean;
  /** Phiên bản tờ khai hiện hành của bản xuất (0 = chưa xuất). */
  declaredVersion: number;
  /** Kết quả kiểm tra đổi sau lần xuất tờ khai đó: cần Xuất lại. */
  declaredChanged: boolean;
  /** Lúc Đánh dấu đã nhập ECUS phiên bản hiện hành (0 = chưa). */
  ecusImportedAt: number;
}

export interface CheckRow {
  key: string;
  stt: string;
  name: string;
  hs: string;
  nkPct?: string;
  vatPct?: string;
  lineIds: string[];
  itemIds: string[];
}

export interface CheckWarning {
  kind: WarningKind;
  level: WarningLevel;
  ref?: string;
  suggested?: string[];
  params?: Record<string, string>;
}

export interface CheckDecision {
  id: string;
  kind: DecisionKind;
  row: string;
  basisHs: string;
  basisName: string;
  covers: string[];
  lessonId?: string;
  fixOpId?: string;
  checkEpoch: number;
  perm: string;
  riskLevel?: string;
  by: string;
  at: number;
}

export interface CheckRowResult {
  row: CheckRow;
  status: RowStatus;
  level: WarningLevel | '';
  warnings: CheckWarning[];
  open: CheckWarning[];
  decisions: CheckDecision[];
  pending: CheckDecision[];
}

export interface CheckRejected {
  decision: CheckDecision;
  reason: string;
}

export interface CheckView {
  rows: CheckRowResult[];
  lot: LotResult;
  byLevel: CheckCounts;
  byStatus: Record<string, number>;
  red: number;
  syncing: number;
  pending: CheckDecision[];
  rejected: CheckRejected[];
  holdEpoch: number;
}

export interface CheckMarks {
  tariffVersion: string;
  rulesMark: string;
  lessonsMark: string;
  riskVersion: string;
  /** Dấu dữ liệu lịch sử thông quan lúc kiểm; không làm kết quả cũ. Vắng ở lần kiểm ghi trước khi có kiểm lịch sử. */
  historyMark?: string;
}

export interface CheckRun {
  id: string;
  lotId: string;
  exportOp: string;
  kind: string;
  declareDate: string;
  marks: CheckMarks;
  asOf?: number;
  checkEpoch: number;
  by: CheckPerson;
  device: string;
  at: number;
  offline?: boolean;
}

export interface CheckOp {
  id: string;
  kind: string;
  row?: string;
  checkEpoch: number;
  perm: string;
  by: CheckPerson;
  device: string;
  at: number;
  offline?: boolean;
  payload?: unknown;
}

export interface CheckState {
  lotId: string;
  exportOp: string;
  run?: CheckRun;
  declareDate: string;
  carriedDate: string;
  decisions: CheckDecision[];
  history: CheckOp[];
  handoff?: CheckOp;
  /** Mã mặt hàng báo giá còn chờ gắn dấu "Mã đã đổi khi kiểm tra". */
  flagPending: string[];
  reopened?: boolean;
}

export interface CheckFix {
  opId: string;
  row: string;
  checkEpoch: number;
  hs?: string;
  name?: string;
  nkPct?: string;
  vatPct?: string;
}

export interface CheckPendingFix {
  opId: string;
  row: string;
  by: CheckPerson;
  text: string;
}

export interface CheckExport {
  lot: CheckLotInfo;
  rows: CheckRow[];
  fixes: CheckFix[];
  pending: CheckPendingFix[];
  fileSha: string;
}

export interface OpenedLot {
  export?: CheckExport;
  state?: CheckState;
  hold: HoldView;
  mine: boolean;
  readOnly: boolean;
  offline: boolean;
  claimed: boolean;
  view: CheckView;
}

export interface RunResult {
  runId: string;
  rows: number;
  declareDate: string;
  counts: CheckCounts;
  asOf?: number;
  offline: boolean;
}

export interface LessonHit {
  lessonId: string;
  no: number;
  after: string;
  reviewed: boolean;
  inContradiction: boolean;
  author?: string;
}

export interface KnownConflict {
  row: string;
  lessons: LessonHit[];
  covers: string[];
}

export interface DecisionResult {
  opId?: string;
  lessonId?: string;
  fixOpId?: string;
  unflagged?: number;
}

export interface KeepResult {
  decision?: DecisionResult;
  known?: KnownConflict;
  conflict?: ConflictInfo;
}

export interface UseResult {
  decision?: DecisionResult;
  conflict?: ConflictInfo;
}

export interface BulkResult {
  done: number;
  lessonId?: string;
  conflict?: ConflictInfo;
}

export interface ResolveResult {
  decision?: DecisionResult;
  conflict?: ConflictInfo;
  bulk?: number;
}

export interface HandoffBlockers {
  red: number;
  syncing: number;
  stale: boolean;
}

export interface CheckStatus {
  stale: StaleSource[];
  isStale: boolean;
  asOf: number;
  expired: boolean;
  /** Lịch sử thông quan đã đổi sau lần kiểm cuối: chỉ là nhãn, không chặn Sang xuất; Kiểm tra lại thì mất. */
  historyChanged?: boolean;
  blockers: HandoffBlockers;
  view: CheckView;
}

export interface HandoffResult {
  opId: string;
  route: string;
}

export interface PreviousItem {
  row: string;
  decision: CheckDecision;
  reason?: string;
  applicable: boolean;
}

export interface TariffFact {
  status: string;
  nk?: string;
  vat?: string;
  nkText?: string;
  vatText?: string;
  policy?: string;
  versionId?: string;
  upcoming?: { kind: string; effective: string; old: string; new: string; doc?: string }[];
}

export interface RuleHit {
  ruleId: string;
  no: number;
  hs: string;
  groupName: string;
  contradictsWith?: string[];
  outside: boolean;
}

export interface RiskHit {
  code: string;
  ministry: string;
  name: string;
  level: string;
  requirement?: string;
}

export interface PairHit {
  other: string;
  note?: string;
}

export type HistoryTier = 'exact' | 'similar';
/** Ghi chú khi lịch sử thông quan không cho một mã để cảnh báo (Go tính sẵn). */
export type HistoryNote = '' | 'contradiction' | 'old_only';

export interface HistoryCode {
  hs: string;
  count: number;
  oldCode?: boolean;
}

/** Lịch sử thông quan (tờ khai đã thông quan, ECUS) của tên khai: cùng tên, không có thì tên gần giống nhất. */
export interface HistoryFact {
  tier: HistoryTier;
  shared?: number;
  /** Tối đa 10 mã nhiều lần nhất (lượt kiểm chỉ lưu chừng đó). */
  codes: HistoryCode[];
  /** Số mã khác nhau của đủ danh sách; không có ở lượt kiểm cũ (khi đó bằng số mã trong codes). */
  total?: number;
  unchecked?: boolean;
  note?: HistoryNote;
}

/** Dữ kiện của lần kiểm cuối cho một dòng. */
export interface CheckFacts {
  tariff: TariffFact;
  rules?: RuleHit[];
  lessons?: LessonHit[];
  pairs?: PairHit[];
  risk?: RiskHit[];
  history?: HistoryFact;
}

export interface LineDetail {
  facts?: CheckFacts;
  row: CheckRowResult;
  nameChars: number;
  previous?: PreviousItem;
  mine: boolean;
}

// ---- Xuất tờ khai (ECUS và danh sách tên tiếng Anh) và thiết lập xuất ----
// Số lượng, đơn giá, trị giá và tỷ giá là chuỗi thập phân dấu chấm (num.Dec ở Go). Mảng rỗng ở Go có thể tới dưới dạng null.

export type DeclareMode = 'prepare' | 'exported';
/** Vai trò tệp tờ khai (lot.ExportRoleECUS, lot.ExportRoleEnglish). */
export type DeclareFileRole = 'ecus' | 'english';
export type DeclareJobStage = 'generated' | 'accepted' | 'uploaded' | 'done' | 'void';
export type SelfCheckLevel = 'block' | 'warn';
/** Nơi sửa mục tự kiểm: bảng kiểm tra, Quy đổi ĐVT, Thiết lập mẫu, tab tên tiếng Anh, tỷ giá của lô, tab ECUS. */
export type SelfCheckFix = 'board' | 'uom' | 'template' | 'english' | 'rates' | 'ecus';
export type TemplateArea = 'tpl.ecus' | 'tpl.english' | 'tpl.merged';
export type SettingArea = 'uom' | 'kgm' | 'taxcodes' | TemplateArea;
export type TaxKind = 'nk' | 'vat' | 'ttdb' | 'bvmt';
export type DeclCellKind = '' | 'text' | 'number';

export interface DeclareFiles {
  ecus: boolean;
  english: boolean;
}

/** Tỷ giá mặc định lấy từ lần xuất tờ khai gần nhất. */
export interface DeclareRateSource {
  lotId: string;
  lotCode: string;
  at: number;
  ageDays: number;
  taxRate: string;
  cnyUsd: string;
}

/** Tỷ giá và Form E của lần xuất ("0" = chưa có); *Set: lô đã nhập trường đó; deviation: phần trăm lệch so với mặc định. */
export interface DeclareLotInputs {
  taxRate: string;
  cnyUsd: string;
  formE: boolean;
  taxRateSet: boolean;
  cnySet: boolean;
  formESet: boolean;
  needsCny: boolean;
  source?: DeclareRateSource;
  deviation?: string;
  cnyDeviation?: string;
}

export interface EnglishCandidate {
  name: string;
  lines: number;
}

export interface DeclRowView {
  key: string;
  stt: string;
  name: string;
  hs: string;
  unit: string;
  qty: string;
  price: string;
  value: string;
  currency: string;
  origin: string;
  originSet: boolean;
  english: string;
  proposed: string;
  confirmed: boolean;
  candidates: EnglishCandidate[];
  wordWarn: boolean;
  itemIds: string[];
  englishPending: boolean;
  /** Tên tiếng Anh đã lưu ở lô khác cho dòng cùng tên khai (chỉ khi dòng chưa xác nhận tên): gợi ý, bấm Dùng rồi Lưu. */
  history?: EnglishHistory[];
}

/** Một tên tiếng Anh đã khai ở lô trước: số dòng đã khai tên này, lô và giờ lần lưu gần nhất. */
export interface EnglishHistory {
  name: string;
  rows: number;
  lot: string;
  at: number;
}

export interface DeclareGate {
  red: number;
  syncing: number;
  stale: boolean;
  handoff: boolean;
  blocked: boolean;
}

/** Một ô của tệp dựng ra; exact: số chính xác khi text đã làm tròn (tiền thuế). */
export interface DeclCell {
  kind: DeclCellKind;
  text: string;
  exact?: string;
}

/** Một dòng tệp ECUS: ô theo trường của mẫu. */
export interface EcusRowView {
  key: string;
  cells: Record<string, DeclCell>;
}

/** Một dòng danh sách tên tiếng Anh: ô theo trường của mẫu. */
export interface EnglishRowView {
  key: string;
  cells: Record<string, DeclCell>;
}

export interface SelfCheckItem {
  key: string;
  level: SelfCheckLevel;
  rows?: string[];
  params?: Record<string, string>;
  fix: SelfCheckFix;
}

export interface DeclareWarning {
  key: string;
  row: string;
  params?: Record<string, string>;
}

export interface DeclaredFile {
  role: DeclareFileRole;
  name: string;
  driveId: string;
  size: number;
  sha256: string;
}

export interface SettingRef {
  area: SettingArea;
  itemId: string;
  sha256: string;
}

export interface DeclareRates {
  taxRate: string;
  cnyUsd: string;
}

/** Một phiên bản tờ khai đã xuất của bản xuất hiện hành (current: hiện hành; superseded: đã thay thế). */
export interface DeclaredVersion {
  opId: string;
  version: number;
  jobId: string;
  files: DeclaredFile[];
  settings: SettingRef[];
  rates: DeclareRates;
  formE: boolean;
  taxAmounts: boolean;
  origins?: Record<string, string>;
  handoffOpId: string;
  fixOpIds: string[];
  runId: string;
  exportOp: string;
  exact?: Record<string, Record<string, string>>;
  by: CheckPerson;
  at: number;
  current: boolean;
  superseded: boolean;
  importedAt?: number;
  importedBy?: CheckPerson;
}

/** Màn Xuất ECUS và C/O của một lô. */
export interface DeclareView {
  lotId: string;
  lotCode: string;
  exportOp: string;
  exportVersion: number;
  declareDate: string;
  hold: HoldView;
  mine: boolean;
  readOnly: boolean;
  canPing: boolean;
  canTakeover: boolean;
  offline: boolean;
  claimed: boolean;
  mode: DeclareMode;
  lot: DeclareLotInputs;
  files: DeclareFiles;
  gate: DeclareGate;
  rows: DeclRowView[];
  ecus: EcusRowView[];
  english: EnglishRowView[];
  /** Tự kiểm cho các tệp chọn sẵn (files). */
  selfCheck: SelfCheckItem[];
  /** Tự kiểm khi chỉ chọn một tệp. */
  fileChecks: Partial<Record<DeclareFileRole, SelfCheckItem[]>>;
  warnings: DeclareWarning[];
  versions: DeclaredVersion[];
  changed: boolean;
  settingsRefs: SettingRef[];
  englishPending: number;
}

export interface EnglishInput {
  row: string;
  name: string;
}

/** Kết quả ghi tên tiếng Anh một dòng: số mặt hàng đã ghi, mặt hàng bỏ qua, số mặt hàng chờ ghi lại. */
export interface EnglishResult {
  row: string;
  opId: string;
  written: number;
  skipped: string[];
  pending: number;
}

export interface DeclareExportInput {
  files: DeclareFiles;
  taxAmounts: boolean;
}

/** Việc xuất tờ khai trên máy này; key/params: câu báo declare_job_void hoặc declare_job_waiting_user. */
export interface DeclareJob {
  jobId: string;
  lotId: string;
  version: number;
  stage: DeclareJobStage;
  pending: boolean;
  files: DeclaredFile[];
  by: CheckPerson;
  at: number;
  voidReason?: string;
  /** Thư mục trên máy giữ các tệp của việc xuất (<dataDir>/check/declare/<mã lô>/<mã việc>). */
  localDir: string;
  key?: string;
  params?: Record<string, string>;
}

/** Kết quả Xuất: blocked = còn mục chặn (items, chưa dựng gì); không thì job. */
export interface DeclareExportResult {
  blocked: boolean;
  items?: SelfCheckItem[];
  job?: DeclareJob;
  /** job là việc đang chạy từ lần bấm trước với lựa chọn tệp hoặc cột tiền thuế khác lần bấm này (không dựng việc mới). */
  otherOptions?: boolean;
}

export interface DeclareVersions {
  lotId: string;
  versions: DeclaredVersion[];
  job?: DeclareJob;
}

export interface UOMRow {
  unit: string;
  vn: string;
  cn: string;
}

/** Một dòng bảng mã biểu thuế; key: mức (NK: mfn / acfta / normal; VAT, TTĐB: "8"; "*" = mọi mức). */
export interface TaxCodeRow {
  tax: TaxKind;
  key: string;
  code: string;
}

/** Một phiên bản của một vùng thiết lập (bản mặc định: default, no = 0). */
export interface SettingVersion {
  area: SettingArea;
  itemId: string;
  sha256: string;
  no: number;
  default: boolean;
  by: CheckPerson;
  at: number;
}

export interface TemplateColumn {
  field: string;
  col: string;
  header: string;
}

/** Mẫu tệp hiện hành của một vùng; source: tên tệp đã nạp ("" = mẫu có sẵn). */
export interface TemplateView {
  area: TemplateArea;
  source: string;
  sheet: string;
  headerRow: number;
  columns: TemplateColumn[];
}

/** Bản hiện hành của mọi vùng thiết lập; canEdit: người đang làm có export.template. */
export interface SettingsView {
  uom: UOMRow[];
  kgm: string[];
  taxCodes: TaxCodeRow[];
  templates: TemplateView[];
  versions: SettingVersion[];
  canEdit: boolean;
}

export interface TemplateField {
  field: string;
  label: string;
  required: boolean;
  col?: string;
  header?: string;
}

/** Bản xem trước tệp mẫu vừa chọn; token để lưu; missing: tiêu đề cột bắt buộc còn thiếu (còn thiếu thì không lưu được). */
export interface TemplatePreview {
  token: string;
  area: TemplateArea;
  fileName: string;
  sheet: string;
  headerRow: number;
  fields: TemplateField[];
  missing: string[];
}

export interface CheckApi {
  listLots(): Promise<CheckListRow[]>;
  openLot(lotId: string): Promise<OpenedLot>;
  lineDetail(lotId: string, rowKey: string): Promise<LineDetail>;
  status(lotId: string): Promise<CheckStatus>;
  previous(lotId: string): Promise<PreviousItem[]>;
  release(lotId: string): Promise<void>;
  ping(lotId: string): Promise<void>;
  takeover(lotId: string): Promise<HoldView>;
  run(lotId: string, date: string): Promise<RunResult>;
  setDeclareDate(lotId: string, date: string): Promise<void>;
  markSeen(lotId: string, rowKey: string, covers: string[]): Promise<DecisionResult>;
  keep(lotId: string, rowKey: string, covers: string[], suggested: string, reason: string, scope: CheckScope | ''): Promise<KeepResult>;
  keepHighRisk(lotId: string, rowKey: string, covers: string[], suggested: string, reason: string, scope: CheckScope | ''): Promise<KeepResult>;
  keepAll(lotId: string, pairKey: string, reason: string, scope: CheckScope | ''): Promise<BulkResult>;
  useSuggested(lotId: string, rowKey: string, code: string, reason: string, scope: CheckScope | ''): Promise<UseResult>;
  changeCode(lotId: string, rowKey: string, code: string, reason: string): Promise<UseResult>;
  useAll(lotId: string, pairKey: string, reason: string, scope: CheckScope | ''): Promise<BulkResult>;
  resolveKnown(lotId: string, rowKey: string, lessonIds: string[], choice: CheckChoice, text: string, reason: string, scope: CheckScope | ''): Promise<KeepResult>;
  resolveToken(token: string, choice: CheckChoice, text: string): Promise<ResolveResult>;
  shorten(lotId: string, rowKey: string, name: string): Promise<UseResult>;
  updateRate(lotId: string, rowKey: string): Promise<UseResult>;
  markRisk(lotId: string, rowKey: string, mark: 'in' | 'out', reason: string): Promise<DecisionResult>;
  markHighRisk(lotId: string, rowKey: string, reason: string): Promise<DecisionResult>;
  confirmHighRisk(lotId: string, rowKey: string): Promise<DecisionResult>;
  decidePending(lotId: string, decisionIds: string[], apply: boolean): Promise<void>;
  applyPrevious(lotId: string, decisionIds: string[]): Promise<number>;
  handoff(lotId: string): Promise<HandoffResult>;
  reopen(lotId: string, reason: string): Promise<void>;
  /** Mở màn xuất tờ khai (nhận giữ lô như openLot). */
  declarePrepare(lotId: string): Promise<DeclareView>;
  /** Đọc lại màn xuất tờ khai (không nhận giữ). */
  declareRefresh(lotId: string): Promise<DeclareView>;
  declareVersions(lotId: string): Promise<DeclareVersions>;
  /** cnyUsd "" = giữ giá trị trước. */
  declareSetLot(lotId: string, taxRate: string, cnyUsd: string, formE: boolean): Promise<void>;
  declareSetEnglishName(lotId: string, rowKey: string, name: string): Promise<EnglishResult>;
  declareSetEnglishNames(lotId: string, rows: EnglishInput[]): Promise<EnglishResult[]>;
  declareSetOrigin(lotId: string, rowKey: string, origin: string): Promise<void>;
  declareExport(lotId: string, input: DeclareExportInput): Promise<DeclareExportResult>;
  /** null = không có việc đang chờ. */
  declareRetry(lotId: string): Promise<DeclareJob | null>;
  /** Đường dẫn đã lưu; "" = người dùng huỷ hộp thoại lưu. */
  declareDownload(lotId: string, version: number, role: DeclareFileRole): Promise<string>;
  declareOpenFolder(lotId: string): Promise<void>;
  declareMarkImported(lotId: string, version: number): Promise<void>;
  settings(): Promise<SettingsView>;
  /** Mới nhất trước; chưa ai lưu thì chỉ bản mặc định. */
  settingsHistory(area: SettingArea): Promise<SettingVersion[]>;
  settingsSaveUom(rows: UOMRow[], baseItemId: string): Promise<SettingsView>;
  settingsSaveKgm(codes: string[], baseItemId: string): Promise<SettingsView>;
  settingsSaveTaxCodes(rows: TaxCodeRow[], baseItemId: string): Promise<SettingsView>;
  /** Mở hộp chọn tệp (.xls, .xlsx) rồi đọc tệp mẫu; null = người dùng huỷ. */
  settingsPickTemplate(area: TemplateArea, baseItemId: string): Promise<TemplatePreview | null>;
  settingsSaveTemplate(token: string): Promise<SettingsView>;
}

/** Sự kiện Go phát sau mỗi lần ghi của App Kiểm tra và lượt kéo mang bản ghi kiểm tra về. */
export const CHECK_CHANGED_EVENT = 'check:changed';

/** Tên hàm Go (check.Service.<Hàm>) của từng hàm CheckApi (test Go đối chiếu với các hàm exported của service.go). */
export const CHECK_METHODS: Record<keyof CheckApi, string> = {
  listLots: 'ListLots',
  openLot: 'OpenLot',
  lineDetail: 'LineDetail',
  status: 'Status',
  previous: 'Previous',
  release: 'Release',
  ping: 'Ping',
  takeover: 'Takeover',
  run: 'Run',
  setDeclareDate: 'SetDeclareDate',
  markSeen: 'MarkSeen',
  keep: 'Keep',
  keepHighRisk: 'KeepHighRisk',
  keepAll: 'KeepAll',
  useSuggested: 'UseSuggested',
  changeCode: 'ChangeCode',
  useAll: 'UseAll',
  resolveKnown: 'ResolveKnown',
  resolveToken: 'ResolveToken',
  shorten: 'Shorten',
  updateRate: 'UpdateRate',
  markRisk: 'MarkRisk',
  markHighRisk: 'MarkHighRisk',
  confirmHighRisk: 'ConfirmHighRisk',
  decidePending: 'DecidePending',
  applyPrevious: 'ApplyPrevious',
  handoff: 'Handoff',
  reopen: 'Reopen',
  declarePrepare: 'DeclarePrepare',
  declareRefresh: 'DeclareRefresh',
  declareVersions: 'DeclareVersions',
  declareSetLot: 'DeclareSetLot',
  declareSetEnglishName: 'DeclareSetEnglishName',
  declareSetEnglishNames: 'DeclareSetEnglishNames',
  declareSetOrigin: 'DeclareSetOrigin',
  declareExport: 'DeclareExport',
  declareRetry: 'DeclareRetry',
  declareDownload: 'DeclareDownload',
  declareOpenFolder: 'DeclareOpenFolder',
  declareMarkImported: 'DeclareMarkImported',
  settings: 'Settings',
  settingsHistory: 'SettingsHistory',
  settingsSaveUom: 'SettingsSaveUOM',
  settingsSaveKgm: 'SettingsSaveKGM',
  settingsSaveTaxCodes: 'SettingsSaveTaxCodes',
  settingsPickTemplate: 'SettingsPickTemplate',
  settingsSaveTemplate: 'SettingsSaveTemplate',
};

/** Lỗi của App Kiểm tra: khoá câu, tham số (chữ trong ngoặc nhọn của câu) và dữ liệu kèm. */
export class CheckError extends ApiError {
  constructor(code: string, params: Record<string, string | number> = {}, public data?: unknown) {
    super(code, 0, params);
  }
}

/** Lỗi Go "khoá: {JSON tham số}" -> CheckError; tham số "_data" thành dữ liệu kèm. */
export function parseCheckError(msg: string): CheckError {
  const code = parseErrorCode(msg);
  const detail = /^\s*[a-z][a-z0-9_]*\s*:\s*([\s\S]*)$/.exec(msg)?.[1] ?? '';
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
        return new CheckError(code, params, data);
      }
    } catch {
      // không phải JSON: đọc như lỗi của lõi
    }
  }
  return new CheckError(code, parseErrorParams(msg));
}
