// Kiểu của phân hệ Sheet Vipo: khớp JSON của apps/hs-desk/desktop/internal/modules/vipo (service.go và các kiểu nó trả).
// Đổi tên trường ở Go thì sửa ở đây cùng lúc (test Go ghi testdata/api-shapes.golden.json, test TS so khoá với kiểu
// dưới đây). Giờ dạng Unix giây; ô Sheet giữ nguyên kiểu Sheets trả (chuỗi, số, đúng/sai).
//
// Câu báo mang khoá câu (contracts/errors.json, map vipoSheetExchange) và tham số theo đúng chữ trong ngoặc nhọn của câu
// (vd { 'số dòng': '20705' }).

export type VipoFieldKey =
  | 'link'
  | 'name'
  | 'spec'
  | 'brand'
  | 'maker'
  | 'otherDesc'
  | 'qty'
  | 'priceCny'
  | 'priceVnd'
  | 'rate'
  | 'note'
  | 'reply'
  | 'vpo'
  | 'out1'
  | 'out2'
  | 'out3'
  | 'out4'
  | 'out5';

export type VipoRole = 'declaredName' | 'hs' | 'tax' | 'policy' | 'conformity';

export type CellValue = string | number | boolean | null;

export interface VipoPerson {
  id: string;
  name: string;
}

export interface FieldCol {
  col: string;
  header: string;
  role?: VipoRole;
}

export interface VipoMapping {
  id: string;
  parent?: string;
  sheetId: string;
  sheetTitle: string;
  tab: string;
  headerRows: number;
  startRow: number;
  fields: Partial<Record<VipoFieldKey, FieldCol>>;
  savedBy: VipoPerson;
  savedAt: number;
  device?: string;
}

export interface SheetTab {
  id: number;
  title: string;
  rowCount: number;
  filtered: boolean;
}

export interface SheetSetup {
  sheetId: string;
  title: string;
  tabs: SheetTab[];
}

export interface TabPreview {
  headers: Record<string, string>;
  defaultStartRow: number;
  lastDataRow: number;
}

export interface MappingProblem {
  kind: string;
  col?: string;
  field?: string;
  text: string;
}

export interface MappingTest {
  ok: boolean;
  problems: MappingProblem[];
  hash: string;
  headers: Record<string, string>;
}

export interface FieldDiff {
  field: VipoFieldKey;
  label: string;
  old: FieldCol;
  new: FieldCol;
}

export interface MappingVersion {
  mapping: VipoMapping;
  changes: FieldDiff[];
  other: string[];
}

export interface ScheduleState {
  lastFinished?: number;
  lastSuccess?: number;
  lastManual?: number;
  backoff?: number;
}

export interface VipoOverview {
  hasMapping: boolean;
  mapping?: VipoMapping;
  canManage: boolean;
  lastReadAt?: number;
  liveRead: boolean;
  schedule: ScheduleState;
  nextAutoAt?: number;
  manualGapSeconds: number;
  batchMaxRows: number;
  uncopied: Record<string, number>;
  sheetBatch: Record<string, boolean>;
}

export interface DetectSummary {
  events: number;
  gone: number;
  newRows: number;
  twins: number;
}

export interface ReadResult {
  at: number;
  rows: number;
  abnormal: boolean;
  detect: DetectSummary;
}

export interface RowTag {
  key: 'missing_link' | 'cancelled_on' | 'after_cutoff' | string;
  text: string;
}

export interface IntakeRowView {
  row: number;
  values: Partial<Record<VipoFieldKey, CellValue>>;
  labels?: RowTag[];
  by?: string;
  itemId?: string;
}

export interface RowSections {
  new: IntakeRowView[];
  taken: IntakeRowView[];
  changed: IntakeRowView[];
}

export interface IntakeView {
  hasMapping: boolean;
  sheetTitle?: string;
  tab?: string;
  readAt?: number;
  live: boolean;
  startRow: number;
  lastDataRow: number;
  sections: RowSections;
  rangeError?: string;
  maxRows: number;
  createReason?: string;
}

export interface CreateResult {
  batchId: string;
  items: number;
  excluded?: number[];
  notice?: string;
  params?: Record<string, string>;
}

export interface FieldChange {
  field: VipoFieldKey;
  label: string;
  old: CellValue;
  new: CellValue;
}

export type SheetAction = 'update' | 'keep' | 'cancel' | 'merge' | 'merge_no' | 'manual_target' | 'twin_cancel' | 'twin_keep';

export interface SheetFlag {
  code: string;
  group: 'todo' | 'info';
  label: string;
  key?: string;
  params?: Record<string, string>;
  eventId?: string;
  changes?: FieldChange[];
  actions?: SheetAction[];
}

export interface SheetAnswer {
  text: string;
  at: number;
}

export interface TwinView {
  other: string;
  otherReceiver: VipoPerson;
  receiver: VipoPerson;
  row: number;
  later: boolean;
  managerOnly: boolean;
  keptByOther: boolean;
  kept: boolean;
  otherCopied: boolean;
  canAct: boolean;
  actions?: SheetAction[];
}

export interface InvalidNumber {
  field: VipoFieldKey;
  label: string;
  value: string;
}

export interface Deviation {
  checked: boolean;
  warn: boolean;
  percent?: string;
  vnd?: string;
  cny?: string;
  rate?: string;
  product?: string;
}

export interface NumbersView {
  mapped: boolean;
  qty?: string;
  priceVnd?: string;
  priceCny?: string;
  rate?: string;
  ok: boolean;
  invalid?: InvalidNumber[];
  deviation?: Deviation;
}

export interface SheetView {
  itemId: string;
  row: number;
  rowLabel: string;
  vpo?: string;
  receiver: VipoPerson;
  receivedAt: number;
  flags: SheetFlag[];
  answer?: SheetAnswer;
  twin?: TwinView;
  numbers?: NumbersView;
  manualTarget?: number;
  mergeRow?: number;
  copyBlock?: string;
  writes: number;
}

export interface TargetPreview {
  row: number;
  link: string;
  name: string;
}

export interface CellDiff {
  row: number;
  col: string;
  got: string;
  want: string;
}

export interface NotePrep {
  old: string;
  line: string;
  append?: string;
  new: string;
  exists?: boolean;
  full?: boolean;
}

export interface VipoBlock {
  range: string;
  rows: number[];
  cols: string[];
  cells: string[][];
  note?: boolean;
  text: string;
}

export type CopyRowState = 'unsent' | 'notfound' | 'pending' | 'confirmed' | 'skipped';

export interface CopyRow {
  itemId: string;
  name: string;
  itemRev: number;
  result: boolean;
  question: boolean;
  questionText?: string;
  row?: number;
  candidates?: number[];
  state: CopyRowState;
  prepared?: Record<string, string>;
  omitted?: string[];
  note?: NotePrep;
  noteCol?: string;
  snapshot?: Record<string, CellValue>;
  existing?: CellDiff[];
  overwrite?: boolean;
  checkedAt?: number;
  firstCopiedAt?: number;
  confirmedAt?: number;
  mismatches?: CellDiff[];
  outside?: CellDiff[];
  stale?: boolean;
  reason?: string;
  reasonParams?: Record<string, string>;
  changedWarn?: boolean;
  rowLabel?: string;
}

export interface CopyRound {
  id: string;
  batchId: string;
  mappingVid: string;
  createdBy: VipoPerson;
  createdAt: number;
  device: string;
  checkedAt?: number;
  filtered?: boolean;
  hiddenRows?: number[];
  blocks?: VipoBlock[];
  copied?: boolean[];
  rows: CopyRow[];
  closed?: boolean;
}

export type CopyGroup = 'approved' | 'recopy' | 'question' | 'other' | 'copied';

export interface CopyCandidate {
  itemId: string;
  name: string;
  rev: number;
  status: string;
  rowLabel: string;
  row: number;
  kind?: 'result' | 'question';
  group: CopyGroup;
  selectable: boolean;
  reason?: string;
  copiedAt?: number;
  changedWarn?: boolean;
  warnParams?: Record<string, string>;
  twin?: boolean;
  twinParams?: Record<string, string>;
  question?: string;
}

export interface CopyListView {
  batchId: string;
  items: CopyCandidate[];
  round?: CopyRound;
  policyOmitted: boolean;
  checkMinutes: number;
}

export interface WriteCell {
  col: string;
  before: string;
  after: string;
}

export interface WriteNote {
  col: string;
  before: string;
  appended: string;
}

export interface WriteRec {
  id: string;
  itemId: string;
  itemRev: number;
  row: number;
  cells: WriteCell[];
  note?: WriteNote;
  mappingVid: string;
  copyId: string;
  kind: 'result' | 'question';
  /** direct: app ghi thẳng ô Ghi chú; paste hoặc thiếu (bản ghi cũ): dán tay. */
  mode?: 'direct' | 'paste';
  /** App ghi nhầm ô Ghi chú dòng row (dòng dời trong lúc ghi): không phải câu hỏi đã gửi; note giữ nội dung đã ghi. */
  misplaced?: boolean;
  by: VipoPerson;
  at: number;
}

export interface DaySummary {
  day: string;
  reads: number;
  failedReads: number;
  rateLimited: number;
  abnormal: number;
  lastRows: number;
  goneRows: number;
  copyRows: number;
  confirmed: number;
  mismatched: number;
  notFound: number;
  itemsSheet: number;
  itemsManual: number;
  devices: string[];
  errorsByKind?: Record<string, number>;
}

// ---------- Trao đổi với Vipo (luồng dẫn xuất trên máy; câu báo map vipoNoteExchange) ----------

/** pending: Chưa gửi; waiting: Chờ Vipo; answered: Vipo đã trả lời; done: Đã xong. */
export type ThreadState = 'pending' | 'waiting' | 'answered' | 'done';

/**
 * Một tin của luồng. dir: out (câu hỏi HS Desk), in (Vipo), info (thông tin). kind: question (đã lên Sheet, mode App ghi
 * / dán tay), pending (câu đã lưu chưa gửi, at = 0), reply (Vipo trả lời; replaced: sửa phản hồi, text là toàn văn mới;
 * removed: xoá phản hồi), reply_initial (phản hồi có sẵn khi bắt đầu theo dõi), note_edited (Ghi chú sửa ngoài app).
 * at: giờ ghi lên Sheet, hoặc lúc một máy đọc thấy (tin Vipo).
 */
export interface ThreadMessage {
  id: string;
  dir: 'out' | 'in' | 'info';
  kind: 'question' | 'pending' | 'reply' | 'reply_initial' | 'note_edited';
  text: string;
  at: number;
  by?: VipoPerson;
  mode?: 'direct' | 'paste';
  replaced?: boolean;
  removed?: boolean;
}

export interface PendingQuestion {
  text: string;
  rounds: number;
}

/** Phần chung của luồng. canSend sai thì blockReason là khoá câu (vd vipo_note_blocked, vipo_note_status, vipo_not_ready). */
export interface ThreadSummary {
  itemId: string;
  batchId: string;
  batchCode: string;
  row: number;
  rowLabel: string;
  name: string;
  itemStatus: string;
  itemStatusLabel?: string;
  state: ThreadState;
  lastAt: number;
  pending?: PendingQuestion;
  canSend: boolean;
  blockReason?: string;
  blockParams?: Record<string, string>;
  doneBy?: VipoPerson;
  doneAt?: number;
}

/** Luồng mở ra: tin theo giờ, câu chưa gửi ở cuối. */
export interface Thread extends ThreadSummary {
  messages: ThreadMessage[];
}

/** Dòng danh sách: last là câu chưa gửi nếu có, không thì tin mới nhất. */
export interface ThreadRow extends ThreadSummary {
  last: ThreadMessage;
}

export interface ThreadFilter {
  batchId: string;
  state: ThreadState | '';
  query: string;
}

/** counts: số luồng theo trạng thái trên bộ lọc đợt + tìm; scopeMissingAt > 0: hiện băng "Chưa ghi được lên Sheet". */
export interface ThreadList {
  items: ThreadRow[];
  counts: Record<ThreadState, number>;
  scopeMissingAt?: number;
}

/** Hàm Go của phân hệ (window.go.vipo.Service.<Hàm>); test đối chiếu tên với các hàm exported của service.go. */
export interface VipoApi {
  overview(): Promise<VipoOverview>;
  loadSheet(link: string): Promise<SheetSetup>;
  previewTab(m: VipoMapping): Promise<TabPreview>;
  testMapping(m: VipoMapping): Promise<MappingTest>;
  saveMapping(m: VipoMapping, confirmOpen: boolean): Promise<VipoMapping>;
  mappingHistory(): Promise<MappingVersion[]>;
  readLog(days: number): Promise<DaySummary[]>;
  readNow(): Promise<ReadResult>;
  intakeList(from: string, to: string): Promise<IntakeView>;
  createBatch(rows: number[]): Promise<CreateResult>;
  openBatch(): Promise<void>;
  itemSheet(itemId: string): Promise<SheetView | null>;
  keepDesc(itemId: string, eventId: string): Promise<void>;
  updateDesc(itemId: string, eventId: string): Promise<void>;
  keepGone(itemId: string, eventId: string): Promise<void>;
  cancelGone(itemId: string, eventId: string): Promise<void>;
  merge(itemId: string, newRow: number): Promise<void>;
  mergeNo(itemId: string, newRow: number): Promise<void>;
  previewManualTarget(itemId: string, row: string): Promise<TargetPreview>;
  setManualTarget(itemId: string, row: string): Promise<TargetPreview>;
  twinDecide(itemId: string, action: 'twin_cancel' | 'twin_keep'): Promise<void>;
  writeHistory(itemId: string): Promise<WriteRec[]>;
  copyList(batchId: string): Promise<CopyListView>;
  startCopy(batchId: string, itemIds: string[]): Promise<CopyRound>;
  checkTargets(copyId: string): Promise<CopyRound>;
  resolveMatch(copyId: string, itemId: string, row: number): Promise<CopyRound>;
  skipRow(copyId: string, itemId: string): Promise<CopyRound>;
  overwrite(copyId: string, itemId: string): Promise<CopyRound>;
  copyBlock(copyId: string, index: number): Promise<CopyRound>;
  copyText(text: string): Promise<void>;
  confirmPasted(copyId: string): Promise<CopyRound>;
  copyRound(copyId: string): Promise<CopyRound>;
  threads(f: ThreadFilter): Promise<ThreadList>;
  thread(itemId: string): Promise<Thread | null>;
  /** text rỗng: gửi câu hỏi đã lưu mà chưa gửi. */
  sendQuestion(itemId: string, text: string): Promise<Thread>;
  /** Ghi lại lên Sheet kết quả đã duyệt của một mặt hàng (lần tự ghi lúc duyệt chưa xong). */
  writeResults(itemId: string): Promise<void>;
  /** Ghi lên Sheet mọi mặt hàng Đã duyệt của đợt mà chưa ghi. */
  writeBatchResults(batchId: string): Promise<BatchWriteResult>;
  markThreadDone(itemId: string, messageId: string): Promise<Thread>;
}

/** Kết quả ghi lại cả đợt lên Sheet. */
export interface BatchWriteResult {
  written: number;
  failed: number;
  errors?: string[];
}
