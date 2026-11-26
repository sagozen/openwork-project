// Kiểu của phân hệ biểu thuế: khớp JSON của apps/hs-desk/desktop/internal/modules/tariff (service.go và các kiểu nó
// trả). Đổi tên trường ở Go thì sửa ở đây cùng lúc. Ngày dạng "YYYY-MM-DD", giờ dạng Unix giây; mức thuế và tiền là
// chuỗi thập phân chuẩn ("7.5"), giao diện định dạng khi hiện (modules/tariff/format.ts).
//
// Câu báo (Notice) mang khoá câu và tham số theo đúng chữ trong ngoặc nhọn của câu (vd { 'mã HS': '8516.79.00' }); câu
// tiếng Việt nằm trong contracts/errors.json (map tariffApply).

/** Danh sách của sự kiện: biểu thuế hoặc danh sách chống bán phá giá. */
export type TariffList = 'tariff' | 'antidumping' | 'risk';

/** Một trong 7 loại thuế của Khối Thuế. */
export type TaxKind = 'mfn' | 'acfta' | 'normal' | 'vat' | 'bvmt' | 'ttdb' | 'antidumping';

export type TaxSource = 'tariff' | 'manual' | 'submitted';

/** Form E riêng của mặt hàng; inherit = theo lô. */
export type FormEMode = 'on' | 'off' | 'inherit';

export interface TariffNotice {
  key: string;
  params?: Record<string, string>;
}

export interface TariffActor {
  id: string;
  name: string;
}

// ---------- Khối Thuế ----------

export interface TaxLine {
  kind: TaxKind;
  rate?: string;
  raw?: string;
  doc?: string;
  effective?: string;
  version?: string;
  versionName?: string;
  source?: TaxSource;
  unit?: string;
  basis?: string;
  manualBy?: TariffActor;
  manualAt?: number;
  /** Khoá nhãn cờ (vd BVMT "MT?"). */
  flag?: string;
  notices?: TariffNotice[];
}

export interface ImportDuty {
  mfn?: string;
  acfta?: string;
  normal?: string;
  /** NK thông thường tính bằng 150% MFN vì ô biểu không ghi số. */
  normalComputed?: boolean;
  /** mfn | acfta | không có (trống). */
  inUse?: TaxKind;
  rate?: string;
  /** E-tariff-apply-023. */
  reason?: TariffNotice;
  notes?: TariffNotice[];
}

export interface VATView {
  raw?: string;
  rate?: string;
  provisional: boolean;
  exempt: boolean;
  choices?: string[];
  chosen: boolean;
  flagged: boolean;
  reason?: string;
  pl2: boolean;
  notices?: TariffNotice[];
}

export interface ADView {
  match: boolean;
  prefix?: string;
  note?: string;
  /** Mức cố định của tiền tố khớp, dạng chuẩn ("21.4"); không có = mức theo nhà sản xuất, điền tay. */
  rate?: string;
  doc?: string;
  /** Không còn khớp nhưng đang có số nhập tay (E-tariff-apply-030). */
  gone: boolean;
  version?: string;
}

export interface UpcomingChange {
  kind: TaxKind;
  effective: string;
  old: string;
  new: string;
  doc?: string;
  version?: string;
}

export interface TaxEstimate {
  value?: string;
  nk?: string;
  vat?: string;
  total?: string;
  displayNk?: string;
  displayVat?: string;
  displayTotal?: string;
  provisionalVat: boolean;
  /** E-tariff-apply-004: số lượng / đơn giá VNĐ / thuế NK / VAT. */
  missing?: string[];
  notes?: TariffNotice[];
}

export type FlagCause = 'schedule' | 'apply_date' | 'form_e' | 'antidumping' | 'dropped' | 'manual';

export interface ItemFlag {
  /** Khoá cờ, dùng cho Giữ số cũ. */
  key: string;
  /** tariff_label_updated_by | tariff_label_changed_review. */
  label: string;
  kind?: TaxKind;
  old?: string;
  new?: string;
  doc?: string;
  cause?: FlagCause;
}

export interface TaxView {
  itemId?: string;
  hs?: string;
  /** "Chờ mã HS". */
  waitingHs: boolean;
  applyDate?: string;
  formE: boolean;
  /** Form E riêng của mặt hàng (không theo lô). */
  formEItem: boolean;
  origin?: string;
  versionChain?: string[];
  taxes: TaxLine[];
  importDuty: ImportDuty;
  vat: VATView;
  antidumping: ADView;
  upcoming?: UpcomingChange[];
  computed: boolean;
  estimate?: TaxEstimate;
  flags?: ItemFlag[];
  notices?: TariffNotice[];
  staleSince?: number;
}

export interface TaxTotals {
  nk: string;
  vat: string;
  total: string;
  displayNk: string;
  displayVat: string;
  displayTotal: string;
  estimated: number;
  unestimated: number;
  provisionalVat: number;
  /** "{n} mặt hàng chưa ước tính được, {k} mặt hàng tính VAT tạm". */
  counts: TariffNotice;
}

export interface ImpactChange {
  kind?: TaxKind;
  importDuty?: boolean;
  old: string;
  new: string;
  doc?: string;
}

export interface TaxHistoryEntry {
  at: number;
  by?: TariffActor;
  device?: string;
  /** form_e | vat | manual | clear_manual | keep | apply_new | snapshot | auto_recompute. */
  action: string;
  kind?: TaxKind;
  before?: string;
  after?: string;
  version?: string;
  versionName?: string;
  doc?: string;
  changes?: ImpactChange[];
  cause?: string;
  derived: boolean;
}

export interface VATSuggestion {
  itemId: string;
  rate: string;
  basis?: string;
  by: TariffActor;
  at: number;
}

export interface ApplyMissing {
  chooseVat?: boolean;
  kind?: TaxKind;
}

export interface ApplyPreview {
  old: TaxView;
  new: TaxView;
  flags: ItemFlag[];
  missing?: ApplyMissing[];
  /** E-tariff-apply-026. */
  notice?: TariffNotice;
}

export interface ManualInput {
  kind: TaxKind;
  value: string;
  unit?: string;
  basis?: string;
}

export interface ApplyNewInput {
  vatRate?: string;
  vatBasis?: string;
  manual?: ManualInput[];
}

// ---------- Bản biểu, cây phiên bản, lịch sử ----------

export interface SourceInfo {
  sha256: string;
  bytes: number;
  partCount?: number;
}

export interface VersionMeta {
  id: string;
  name: string;
  fileName: string;
  parent?: string;
  loadedAt?: number;
  loadedBy: TariffActor;
  device?: string;
  htLatest?: string;
  source: SourceInfo;
}

export interface TariffEvent {
  id: string;
  list: TariffList;
  type: 'load' | 'unload' | 'choose';
  version: string;
  parent?: string;
  chosen?: string;
  rejected?: string[];
  actor: TariffActor;
  perm: string;
  device?: string;
  at: number;
  opRef?: string;
}

/** tariff_state_active | _replaced | _unloaded | _dropped_by_choice | _not_recognized | _not_synced | _pending_choice. */
export type VersionState = string;

export interface HistoryEntry extends VersionMeta {
  state: VersionState;
  loadEvent?: string;
  cause?: TariffEvent;
  unsynced: boolean;
}

export interface Fork {
  point: string;
  leaves: string[];
}

export interface IgnoredEvent {
  event: TariffEvent;
  reason: string;
}

export interface TreeState {
  list: TariffList;
  active: string;
  chain: string[];
  pending?: Fork;
  history: HistoryEntry[];
  ignored: IgnoredEvent[];
}

export interface TariffVisibility {
  canLoad: boolean;
  canLoadRisk?: boolean;
  canPickVersion: boolean;
  canOpsLog: boolean;
  staleBanners: boolean;
  readDevices: boolean;
}

export interface TariffReminders {
  nextYear?: TariffNotice;
  age?: TariffNotice;
  localUpdated?: TariffNotice;
  /** E-tariff-apply-029, hoặc khoá đề xuất tariff_pull_never khi máy chưa kéo lần nào. */
  pullStale?: TariffNotice;
  upcoming?: TariffNotice;
  twoVersions?: TariffNotice;
  twoAdLists?: TariffNotice;
  twoRiskLists?: TariffNotice;
  rejected: TariffNotice[];
  lastPullAt?: number;
}

export interface VersionSummary extends HistoryEntry {
  codes: number;
  errorRows: number;
  documents: number;
}

export interface TariffOverview {
  visibility: TariffVisibility;
  tree: TreeState;
  active?: VersionSummary;
  reminders: TariffReminders;
}

export interface ADSummary extends HistoryEntry {
  prefixes: number;
  errorRows: number;
}

export interface ADOverview {
  visibility: TariffVisibility;
  tree: TreeState;
  active?: ADSummary;
  reminders: TariffReminders;
}

export interface RiskCount {
  ministry: string;
  high: number;
  medium: number;
  low: number;
}

export interface RiskSkip {
  line: number;
  raw: string;
  ministry?: string;
  name?: string;
  note?: string;
}

export interface RiskDiff {
  added: string[];
  removed: string[];
  addedCodes: number;
  removedCodes: number;
  rowsChanged: number;
}

export interface RiskDetail {
  rows: number;
  counts: RiskCount[];
  high: number;
  medium: number;
  low: number;
  skippedRows: RiskSkip[];
  canUnload: boolean;
}

export interface RiskSummary extends HistoryEntry {
  rows: number;
  skipped: number;
  high: number;
  medium: number;
  low: number;
}

export interface RiskOverview {
  visibility: TariffVisibility;
  tree: TreeState;
  active?: RiskSummary;
  reminders: TariffReminders;
}

export type RiskLevel = 'high' | 'medium' | 'low';

/** Một dòng Danh mục rủi ro có mã HS; byGroup = mã của dòng ngắn hơn mã tra (khớp theo nhóm hàng). */
export interface RiskLookupRow {
  line: number;
  code: string;
  codeRaw: string;
  ministry: string;
  docNo?: string;
  name: string;
  description?: string;
  standard?: string;
  level: RiskLevel;
  levelRaw?: string;
  requirement?: string;
  legalBasis?: string;
  byGroup: boolean;
}

/** Các dòng khớp của một Bộ, ngành. */
export interface RiskLookupGroup {
  ministry: string;
  rows: RiskLookupRow[];
}

/** Kết quả tra mã HS trên Danh mục rủi ro đang dùng. short = ít hơn 4 số, loaded = đã có danh mục, mixed = khác Bộ hoặc khác mức. */
export interface RiskLookup {
  code: string;
  short: boolean;
  loaded: boolean;
  version?: string;
  groups: RiskLookupGroup[];
  mixed: boolean;
}

export interface RiskPreview {
  session: string;
  name: string;
  fileName: string;
  base: string;
  baseName: string;
  rows: number;
  counts: RiskCount[];
  high: number;
  medium: number;
  low: number;
  skipped: number;
  skippedRows: RiskSkip[];
  diff: RiskDiff;
  same?: TariffNotice;
  canConfirm: boolean;
  builtAt: number;
}

export interface RiskSaveResult {
  saved?: SavedVersion;
  unsynced: boolean;
  newer?: TariffNotice;
  preview?: RiskPreview;
}

export interface ErrorRow {
  row: number;
  code: string;
  reason: string;
}

export interface PaddedCode {
  row: number;
  raw: string;
  code: string;
}

export interface HTDoc {
  row: number;
  title?: string;
  abbr?: string;
  form?: string;
  docNos: string[];
  docDates?: string[];
  effective?: string[];
}

export interface HTWarning {
  row: number;
  value: string;
}

export interface RefTable {
  title?: string;
  columns: string[];
  rows: string[][];
}

export interface TariffChapter {
  code: string;
  title: string;
}

export interface ParseStats {
  dataRows: number;
  groupRows: number;
  validCodes: number;
}

/** Bản biểu thuế (không gồm dòng mã). */
export interface ScheduleVersion {
  id: string;
  name: string;
  fileName: string;
  sheet: string;
  headerRow: number;
  loadedAt?: number;
  loadedBy: TariffActor;
  device?: string;
  parent?: string;
  htDocs: HTDoc[];
  htLatest?: string;
  htWarnings?: HTWarning[];
  columns: string[];
  stored: string[];
  errorRows: ErrorRow[];
  padded: PaddedCode[];
  dropped: string[];
  mt?: RefTable;
  db?: RefTable;
  qt6?: { title: string; rows: string[] };
  chapters: TariffChapter[];
  source: SourceInfo;
  stats: ParseStats;
}

export interface ADPrefix {
  prefix: string;
  note?: string;
  /** Mức cố định theo văn bản, dạng chuẩn ("35.2"). */
  rate?: string;
  doc?: string;
}

export interface ADList {
  id: string;
  name: string;
  fileName: string;
  sheet: string;
  loadedAt?: number;
  loadedBy: TariffActor;
  device?: string;
  parent?: string;
  prefixes: ADPrefix[];
  errorRows: ErrorRow[];
  source: SourceInfo;
}

export interface UnloadInfo {
  version: string;
  parent?: string;
  /** false: nút Gỡ ẩn. */
  canUnload: boolean;
  items: number;
  copied: number;
  /** E-tariff-apply-013. */
  inUse?: TariffNotice;
}

export interface UnloadOutcome {
  /** Có = đã gỡ. */
  event?: string;
  /** Có = chưa gỡ, chờ "Vẫn gỡ" (E-tariff-apply-013). */
  inUse?: TariffNotice;
}

export interface VersionDetail {
  list: TariffList;
  entry: HistoryEntry;
  version?: ScheduleVersion;
  adList?: ADList;
  unload?: UnloadInfo;
  canUnloadAd: boolean;
  risk?: RiskDetail;
  /** Biểu thuế có bản trước (FR-022): khác biệt so với bản trước, cùng dạng Xem trước; không có = bản đầu tiên. */
  diff?: ScheduleDiff;
  /** Mặt hàng bị ảnh hưởng so với bản trước (mở thẻ hàng theo mã). */
  items?: ItemImpact;
}

// ---------- Nạp, xem trước, chọn bản ----------

export interface DocRef {
  row: number;
  title?: string;
  abbr?: string;
  docNo: string;
  docDate?: string;
  effective?: string;
}

export interface CellChange {
  code: string;
  old: string;
  new: string;
  oldDoc?: string;
  newDoc?: string;
  oldEffective?: string;
  newEffective?: string;
}

export interface ScheduleDiff {
  old?: string;
  newDocuments: DocRef[];
  changedDocuments: DocRef[];
  newColumns: string[];
  removedColumns: string[];
  /** Theo trường cột lưu: mfn, acfta, normal, vat, bvmt, ttdb, vatReduction. */
  changed: Record<string, CellChange[]>;
  added: string[];
  dropped: string[];
  errorCodes: string[];
  padded: PaddedCode[];
  validChanged: boolean;
}

export interface ADDiff {
  old?: string;
  added: ADPrefix[];
  removed: ADPrefix[];
  /** Tiền tố có ở cả hai bản mà mức hoặc văn bản đổi (giá trị mới). */
  rateChanged: ADPrefix[];
  /** Tiền tố có ở cả hai bản mà chỉ ghi chú đổi. */
  noteChanged: ADPrefix[];
}

export interface NeedSheet {
  candidates: string[];
  matching: string[];
}

export interface ImportSession {
  id: string;
  list: TariffList;
  fileName: string;
  name: string;
  sheet?: string;
  /** Có = chưa chọn được sheet biểu, chờ chooseSheet. */
  pick?: NeedSheet;
}

export interface PreviewAck {
  /** "Tôi đã kiểm" (E-tariff-apply-027). */
  checked: boolean;
  /** "Đồng ý thay thế" (E-tariff-apply-015). */
  replaceOlder: boolean;
}

export interface ItemImpact {
  auto: number;
  flag: number;
  autoItems: string[];
  flagItems: string[];
  earliest?: string;
}

export interface PreviewView {
  session: string;
  name: string;
  fileName: string;
  sheet: string;
  base: string;
  baseName: string;
  htLatest?: string;
  baseLatest?: string;
  stats: ParseStats;
  baseCodes: number;
  diff: ScheduleDiff;
  htWarnings: HTWarning[];
  errorRows: ErrorRow[];
  errorTotal: number;
  items: ItemImpact;
  errorNotice?: TariffNotice;
  manyErrors?: TariffNotice;
  past?: TariffNotice;
  older?: TariffNotice;
  same?: TariffNotice;
  needChecked: boolean;
  needReplace: boolean;
  canConfirm: boolean;
  builtAt: number;
}

export interface ADPreview {
  session: string;
  name: string;
  fileName: string;
  base: string;
  baseName: string;
  prefixes: number;
  diff: ADDiff;
  errorRows: ErrorRow[];
  errorTotal: number;
  matched: string[];
  /** Vẫn khớp nhưng mức cố định của tiền tố đổi. */
  rerated?: string[];
  unmatched: string[];
  gone: string[];
  errorNotice?: TariffNotice;
  same?: TariffNotice;
  canConfirm: boolean;
  builtAt: number;
}

export interface SavedVersion {
  version: string;
  event: string;
  parts: number;
}

export interface SaveResult {
  saved?: SavedVersion;
  /** "Chưa đồng bộ". */
  unsynced: boolean;
  /** E-tariff-apply-011: có bản mới hơn, preview / adPreview là bản xem trước dựng lại. */
  newer?: TariffNotice;
  preview?: PreviewView;
  adPreview?: ADPreview;
}

export interface ChoiceLeaf extends VersionMeta {
  codes: number;
  errorRows: number;
  documents: number;
}

export interface ChoiceView {
  list: TariffList;
  point: string;
  pointName: string;
  leaves: ChoiceLeaf[];
  diff?: ScheduleDiff;
  adDiff?: ADDiff;
  riskDiff?: RiskDiff;
  notice: TariffNotice;
}

// ---------- Nhật ký thao tác (admin.drive) ----------

export interface FlagCounts {
  autoRecomputed: number;
  resolved: number;
  flagged: number;
}

export interface OpsEntry {
  kind: 'load' | 'pull' | 'unload' | 'choose' | 'ignored' | 'rejected';
  event: TariffEvent;
  versionName: string;
  reason?: string;
  counts?: FlagCounts;
}

export interface DeviceRow {
  id: string;
  name: string;
  revoked: boolean;
  activeTariff: string;
  activeTariffName: string;
  activeAntidumping: string;
  activeAntidumpingName: string;
  since?: number;
  user: TariffActor;
  lastPullAt?: number;
  stale: boolean;
}

export interface OpsLog {
  entries: OpsEntry[];
  devices: DeviceRow[];
  syncError?: string;
}

export interface DeviceStatus {
  devices: DeviceRow[];
  syncError?: string;
}

/** Sự kiện giao diện "tariff:changed". */
export interface TariffChange {
  active: string;
  antidumping: string;
  full: boolean;
  removed: string[];
}

// ---------- API ----------

/**
 * API phân hệ biểu thuế: mỗi hàm gọi đúng tariff.Service.<Hàm> ở Go (test đối chiếu với service.go). Hàm nạp / gỡ
 * cần tariff.load, chọn bản cần tariff.pick_version (từ chối = tariff_permission_denied, E-tariff-apply-012), thao tác
 * mặt hàng cần work.do, nhật ký thao tác cần admin.drive (từ chối = permission_denied).
 */
export interface TariffApi {
  // Đọc
  overview(): Promise<TariffOverview>;
  history(): Promise<HistoryEntry[]>;
  versionDetail(id: string): Promise<VersionDetail>;
  pendingChoice(list: TariffList): Promise<ChoiceView | null>;
  adOverview(): Promise<ADOverview>;
  adHistory(): Promise<HistoryEntry[]>;
  riskOverview(): Promise<RiskOverview>;
  riskHistory(): Promise<HistoryEntry[]>;
  /** Tra mã HS (4 số trở lên) trên Danh mục rủi ro đang dùng; chưa nạp danh mục = loaded false, không lỗi. */
  riskLookup(code: string): Promise<RiskLookup>;
  /** Lưu tệp gốc qua hộp lưu tệp; "" = người dùng huỷ. */
  openSource(versionId: string): Promise<string>;
  itemView(itemId: string): Promise<TaxView>;
  itemViewAt(itemId: string, vid: string): Promise<TaxView>;
  itemFlags(itemId: string): Promise<ItemFlag[]>;
  /** Tổng của đúng các mặt hàng itemIds; rỗng = tổng 0; mã không còn mặt hàng đếm là chưa ước tính được. */
  totals(itemIds: string[]): Promise<TaxTotals>;
  taxHistory(itemId: string): Promise<TaxHistoryEntry[]>;
  vatSuggestion(code: string): Promise<VATSuggestion | null>;
  validateApplyDate(date: string): Promise<void>;
  // admin.drive
  opsLog(): Promise<OpsLog>;
  deviceStatus(): Promise<DeviceStatus>;
  // tariff.load
  /** null = người dùng huỷ hộp chọn tệp. */
  pickScheduleFile(): Promise<ImportSession | null>;
  chooseSheet(sessionId: string, sheet: string): Promise<ImportSession>;
  renameImport(sessionId: string, name: string): Promise<ImportSession>;
  preview(sessionId: string): Promise<PreviewView>;
  confirmImport(sessionId: string, ack: PreviewAck): Promise<SaveResult>;
  cancelImport(sessionId: string): Promise<void>;
  /** sessionId rỗng = dòng lỗi của bản đã lưu versionId. "" = người dùng huỷ hộp lưu. */
  exportErrorRows(sessionId: string, versionId: string): Promise<string>;
  unload(versionId: string, confirmInUse: boolean): Promise<UnloadOutcome>;
  pickADFile(): Promise<ImportSession | null>;
  previewAD(sessionId: string): Promise<ADPreview>;
  confirmAD(sessionId: string): Promise<SaveResult>;
  unloadAD(versionId: string): Promise<string>;
  // risk.load
  pickRiskFile(): Promise<ImportSession | null>;
  previewRisk(sessionId: string): Promise<RiskPreview>;
  confirmRisk(sessionId: string): Promise<RiskSaveResult>;
  unloadRisk(versionId: string): Promise<string>;
  // tariff.pick_version
  chooseVersion(versionId: string): Promise<string>;
  // work.do
  setFormE(itemId: string, mode: FormEMode): Promise<TaxView>;
  chooseVAT(itemId: string, rate: string, basis: string): Promise<TaxView>;
  setManual(itemId: string, kind: TaxKind, value: string, unit: string, basis: string): Promise<TaxView>;
  clearManual(itemId: string, kind: TaxKind): Promise<TaxView>;
  keepOld(itemId: string, flagKey: string): Promise<TaxView>;
  applyNewPreview(itemId: string): Promise<ApplyPreview>;
  applyNewTax(itemId: string, input: ApplyNewInput): Promise<TaxView>;
  /** false = không đổi gì (không ghi). */
  saveBatchTax(batchId: string, date: string, coForm: boolean): Promise<boolean>;
}
