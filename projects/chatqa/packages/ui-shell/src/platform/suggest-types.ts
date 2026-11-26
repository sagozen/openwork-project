// Kiểu dữ liệu của Báo giá v1 (hs-suggest) và Sổ dạy AI (phần ghi/đọc), khớp JSON của Go (internal/modules/suggest,
// internal/modules/lessons). UI gọi qua platform.suggest / platform.lessons (desktop); PWA từ chối desktop_only.

export type FieldKey =
  | 'name' | 'use' | 'spec' | 'brand' | 'maker' | 'declaredName' | 'hs'
  | 'importTax' | 'vat' | 'otherTax' | 'englishName';

export type Source = 'kho' | 'ai' | 'staff' | 'formula' | 'tariff';

export interface Alternative { value: string; confidence?: number; reason?: string }

export interface Field {
  value: string;
  source: Source;
  confidence?: number;
  unsure?: boolean;
  confirmed?: boolean;
  aiValue?: string;
  lessonId?: string;
  manualTax?: boolean;
  choices?: string[];
  basis?: string[];
  rejected?: Alternative[];
  editorName?: string;
  editedAt?: number;
}

export type Fields = Partial<Record<FieldKey, Field>>;

export interface VipoRow { link: string; name: string; spec: string; brand: string; maker: string }
export interface Image { name: string; ext: string; bytes: number; order: number; addedAt: number }
export interface Batch { id: string; code: string; createdAt: number; createdBy: string; applyDate: string; coForm?: boolean; source: string }
export interface IntakeRow { rowRef: string; link: string; name: string; spec: string; brand: string; maker: string }
export interface RowError { line: number; reason: string }

export interface Flag { code: string; group: 'todo' | 'info' | 'routing'; label: string; detail?: string; level?: string; actionable?: boolean }

/** Một lần App Kiểm tra trước khai báo đổi mã HS của dòng gộp chứa mặt hàng (mã của mặt hàng không đổi). */
export interface CheckChange { oldHS: string; newHS: string; lotId: string; lotCode: string; exportVersion: number; by: string; at: number }

export interface Item {
  id: string; batchId: string; rowRef: string; vipo: VipoRow; vipoPending?: VipoRow;
  link: { original: string; edited?: string; editedInApp?: boolean };
  status: string; manual?: boolean; analysisNeeded?: boolean;
  sheetRowChanged?: boolean; sheetRowNumbers?: boolean; sheetRowDeleted?: boolean;
  fields: Fields; images?: Image[]; analysis?: Analysis; fromStore?: FromStore;
  question?: Question; decisions?: Decisions; submitted?: Submitted; returnedBy?: ReturnedBy;
  approvedInfo?: Approved; copiedAt?: number; needsRecopy?: boolean; cancelledInfo?: Cancelled;
  everManager?: boolean;
  checkChanged?: CheckChange[];
  /** Nơi khai dự kiến (chi cục), tuỳ chọn. */
  declarePlace?: string;
  /** Ba mức thuế NK của biểu cạnh "Thuế NK" đang dùng; không có = biểu không cấp. */
  importLevels?: ImportLevels;
}

/** Kết quả xuất báo giá: đường dẫn, tên tệp, số mặt hàng trong tệp và số mặt hàng chưa duyệt. */
export interface QuoteExport { path: string; name: string; rows: number; unapproved: number }

/** Ba mức thuế NK theo biểu; normalComputed: NK thông thường tính bằng 150% MFN vì ô biểu không ghi số. */
export interface ImportLevels { mfn?: string; normal?: string; normalComputed?: boolean; acfta?: string }

export interface Analysis {
  id: string; startedAt: number; endedAt?: number; images: number; state?: string; mode?: string;
  cited?: { lessonId: string; similarity?: number }[]; deviations?: Deviation[];
  discrepancies?: { field: FieldKey; message: string }[]; costLineId?: string;
  waitLabel?: boolean; waitSeconds?: number; retries?: number; lessonsUnavailable?: boolean; rulesUnreadable?: boolean;
  hint?: HintBlock;
}
export interface Deviation { ruleId: string; no?: number; ver?: number; vid?: string; hs?: string; cited?: boolean }
export interface FromStore { resultItemId: string; approvedAt: number; changedSince?: string[]; variantUnsure?: boolean; variantUnknown?: boolean; oldResult?: boolean; nameRegenerated?: boolean; images?: Image[] }
export interface Question { rounds: number; text?: string; sentAt?: number; answeredAt?: number; manualCloseReason?: string; manualClosedAt?: number }
export interface Decisions { vatChoice?: string; unflag?: { level: string; reason: string; by: string; at: number; code?: string }; appliedTaxVid?: string }
export interface Submitted { rev: number; at: number; by: string; byId?: string }
export interface ReturnedBy { note: string; byVipo?: boolean; at?: number; by?: string }
export interface Approved { at: number; by: string; self?: boolean; bulk?: boolean }
export interface Cancelled { at: number; wasCopied?: boolean }

export interface LessonHint {
  lessonId: string; no?: number; field: FieldKey; before: string; after: string; reason?: string; note?: string;
  author?: string; at?: number; scope?: string; status?: string; similarity?: number; applied?: number; unchecked?: boolean;
  contradictsRule?: number;
}
export interface LessonPair { a: LessonHint; b: LessonHint }
export interface PairWarning { codeA: string; codeB: string; note?: string; count?: number }
/** Một khoá lịch sử đã gộp, hiện làm tham khảo ưu tiên thấp nhất; sources: quote | ecus | declaration. */
export interface HistoryRef {
  name: string; hs: string; count: number; sources: string[]; offices?: string[];
  conflict?: string[]; oldCode?: boolean; unchecked?: boolean;
}
export interface HintBlock { ruleConflicts?: LessonHint[]; contradictions?: LessonPair[]; confusablePairs?: PairWarning[]; similar?: LessonHint[]; similarTotal?: number; unavailable?: boolean; history?: HistoryRef[] }

export interface ItemView extends Item {
  flags: Flag[]; waitDays?: number; rounds?: number; overdue?: boolean; canApprove?: boolean;
  riskLevel?: string; riskRows?: { code: string; description: string; standard?: string; level: string }[];
  taxAvailable?: boolean;
  /** Chi cục đã nạp ở lịch sử, gợi ý cho ô Nơi khai dự kiến. */
  places?: string[];
  /** Phần Sheet Vipo của mặt hàng nhận từ Sheet (kiểu đủ ở vipo-types.ts, SheetView). */
  sheet?: import('./vipo-types').SheetView;
}

export interface ItemFilter { batchId?: string; status?: string; flag?: string; approver?: boolean; query?: string; allBatches?: boolean }

export interface ImageUpload { name: string; base64: string }
export interface ImageResult { name: string; code?: string; detail?: string; ok: boolean }

export interface EditRequest { field: FieldKey; value: string; reason?: string; note?: string; scope?: 'similar' | 'item' }
export interface RecordResult { kind: 'created' | 'replaced' | 'historyOnly' | 'conflict' | 'unchecked'; lessonId?: string; conflict?: ConflictInfo; itemId?: string; field?: FieldKey; value?: string }
export interface ConflictInfo { token: string; lesson: LessonHint; others: number; lessons?: LessonHint[] }
export interface EditResult { item: ItemView; record: RecordResult; conflict?: ConflictInfo; offline?: boolean }
export interface EditLinkResult { item: ItemView; matched: boolean; needsAnalysis: boolean }
export interface Application { lessonId: string; itemId: string; source: number }
export type LessonChoice = 'follow_old' | 'save_with_difference' | 'save_and_link'
export interface BulkResult { approved: number; total: number; skipped?: string[] }
export interface SheetChange { desc?: string; numbersOnly?: boolean; newRow?: VipoRow }
export interface Presence { userId: string; deviceId: string; name: string; since: number }
export interface PresenceView { others: Presence[]; known: boolean; skewSeconds?: number; skewKnown?: boolean }
export interface BudgetSummary { month: string; levelVnd: number; topupsVnd: number; capVnd: number; usedVnd: number; remainingVnd: number; warn: boolean; empty: boolean }
export interface LogEntry { rev: number; at: number; deviceTime?: number; syncedAt?: number; offline?: boolean; skew?: boolean; action: string; field?: string; before?: string; after?: string; srcBefore?: string; srcAfter?: string; reason?: string; userId?: string; name?: string }

export interface ReasonOption { code: string; label: string }

export interface SuggestApi {
  createBatch(rows: IntakeRow[]): Promise<{ batch: Batch; items: Item[] }>;
  parsePaste(text: string): Promise<{ rows: IntakeRow[]; errors: RowError[] }>;
  listBatches(): Promise<Batch[]>;
  /** Ngày áp (YYYY-MM-DD) và Form E mặc định của đợt; không đổi gì thì không ghi. */
  setBatchTax(batchId: string, applyDate: string, coForm: boolean): Promise<Batch>;
  listItems(filter?: ItemFilter): Promise<ItemView[]>;
  getItem(id: string): Promise<ItemView>;
  log(id: string): Promise<LogEntry[]>;
  addImages(itemId: string, uploads: ImageUpload[]): Promise<ImageResult[]>;
  removeImage(itemId: string, name: string): Promise<ItemView>;
  image(itemId: string, name: string): Promise<string>;
  analyze(itemId: string, mode?: 'unconfirmed' | 'full'): Promise<void>;
  startManual(itemId: string): Promise<ItemView>;
  confirm(itemId: string, field: FieldKey): Promise<ItemView>;
  unconfirm(itemId: string, field: FieldKey): Promise<ItemView>;
  edit(itemId: string, input: EditRequest): Promise<EditResult>;
  revert(itemId: string, field: FieldKey): Promise<ItemView>;
  useFormulaName(itemId: string): Promise<ItemView>;
  setManualTax(itemId: string, field: FieldKey, value: string, basis?: string): Promise<ItemView>;
  setVATChoice(itemId: string, choice: string): Promise<ItemView>;
  /** Đặt nơi khai dự kiến (rỗng = bỏ); không chạy lại phân tích. */
  setDeclarePlace(itemId: string, place: string): Promise<ItemView>;
  editLink(itemId: string, link: string, confirm?: boolean): Promise<EditLinkResult>;
  relookup(batchId: string, itemId?: string): Promise<void>;
  resolveLessonConflict(token: string, choice: LessonChoice, text?: string): Promise<ItemView>;
  saveLessonLater(token: string): Promise<ItemView>;
  chooseFromBlock(itemId: string, lessonId: string): Promise<Application>;
  withdrawBlockChoice(itemId: string, lessonId: string): Promise<void>;
  askVipo(itemId: string, text: string): Promise<ItemView>;
  manualClose(itemId: string, reason: string): Promise<ItemView>;
  approve(itemId: string): Promise<ItemView>;
  managerApprove(itemId: string, submittedRev: number): Promise<ItemView>;
  sendBack(itemId: string, note: string): Promise<ItemView>;
  bulkApprove(ids: string[]): Promise<BulkResult>;
  unflag(itemId: string, level: string, reason: string): Promise<ItemView>;
  keep(itemId: string, flag: string): Promise<ItemView>;
  applyNew(itemId: string, flag: string): Promise<ItemView>;
  editApproved(itemId: string, reason?: string): Promise<ItemView>;
  applySheetRow(itemId: string): Promise<ItemView>;
  keepSheetRow(itemId: string): Promise<ItemView>;
  /** Xuất tệp báo giá (.xlsx) của đợt qua hộp "Lưu thành"; path rỗng = người dùng huỷ. */
  exportQuote(batchId: string): Promise<QuoteExport>;
  openCard(itemId: string): Promise<void>;
  touchCard(itemId: string, lastInput: number): Promise<void>;
  closeCard(itemId: string): Promise<void>;
  cardPresence(itemId: string): Promise<PresenceView>;
  budgetSummary(): Promise<BudgetSummary>;
  budgetDetail(): Promise<unknown>;
  setBudgetLevel(levelVnd: number): Promise<unknown>;
  addTopup(amountVnd: number): Promise<unknown>;
  setInvoice(amountVnd: number): Promise<unknown>;
  serverSkew(): Promise<number>;
  answerReceived(rowRef: string): Promise<void>;
  rowChanged(rowRef: string, change: SheetChange): Promise<void>;
  rowDeleted(rowRef: string): Promise<void>;
  rowCancelled(rowRef: string): Promise<void>;
  recordCopied(rowRefs: string[], at?: number): Promise<void>;
}

export interface LessonsApi {
  reasons(): Promise<ReasonOption[]>;
  lessonLabel(id: string): Promise<string>;
}
