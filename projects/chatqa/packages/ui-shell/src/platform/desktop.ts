// Adapter cho app desktop: gọi hàm Go qua binding của Wails.
//   - Lõi:      window.go.main.App.<Hàm>        (desktop/main.go)
//   - Phân hệ:  window.go.<pkg>.Service.<Hàm>   (desktop/internal/modules/<pkg>)
// Đổi tên/chữ ký hàm => tăng CoreAPI (product.CoreAPI trong desktop/main.go).
import { NET_EVENT, type NetEvent } from '../lib/net-progress';
import {
  ApiError,
  type AdminSyncStatus,
  type AppState,
  type AuthState,
  type BackupResult,
  type BootstrapProgress,
  type ClosePending,
  type DriveAlert,
  type DriveConflict,
  type DriveConflictDetail,
  type DriveInfo,
  type DriveNotice,
  type DriveSyncState,
  type GoogleToken,
  type ItemVersion,
  type LicenseInfo,
  type Platform,
  type QuoteRequest,
  type RestoreResult,
  type RulesApi,
  type SuggestApi,
  type LessonsApi,
  type TeachApi,
  type IntakeRow,
  type RowError,
  type ItemFilter,
  type ImageUpload,
  type EditRequest,
  type FieldKey,
  type LessonChoice,
  type SheetChange,
  type ReviewOp,
  type SyncIssue,
  type SyncStatus,
  type UpdateInfo,
  type User,
} from './types';
import type {
  ApplyNewInput,
  FormEMode,
  ImportSession,
  PreviewAck,
  SaveResult as TariffSaveResult,
  RiskSaveResult,
  TariffApi,
  TariffChange,
  TariffList,
  TaxKind,
  TaxView,
} from './tariff-types';
import type { VipoApi } from './vipo-types';
import { LOT_METHODS, parseLotError, type LotApi } from './lot-types';
import { CHECK_CHANGED_EVENT, CHECK_METHODS, parseCheckError, type CheckApi } from './check-types';
import { parseErrorCode, parseErrorParams } from '../lib/errors';

type GoFn = (...args: unknown[]) => Promise<unknown>;

/** Tìm hàm Go: "Login" => main.App.Login; "quote.Service.SaveCard" => quote.Service.SaveCard. */
export function goFn(path: string, root: unknown = (window as unknown as { go?: unknown }).go): GoFn {
  const full = path.includes('.') ? path : `main.App.${path}`;
  const fn = full.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], root);
  if (typeof fn !== 'function') throw new ApiError('incompatible', 0); // UI mới hơn exe, hoặc Wails chưa sẵn sàng
  return fn as GoFn;
}

async function call<T>(name: string, ...args: unknown[]): Promise<T> {
  const fn = goFn(name);
  try {
    return (await Reflect.apply(fn, undefined, args)) as T;
  } catch (e) {
    // Go trả lỗi dạng "code: chi tiết" (desktop/internal/apperr); lỗi của biểu thuế đi qua hs-suggest mang tham số JSON
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[go] ${name}:`, msg);
    throw parseTariffError(msg);
  }
}

const quote = (fn: string) => `quote.Service.${fn}`;
const drive = (fn: string) => `drive.Service.${fn}`;
const rules = (fn: string) => `rules.Service.${fn}`;

/** Sổ quy tắc phân loại: mỗi hàm gọi đúng rules.Service.<Hàm> (test đối chiếu với các hàm exported của service.go). */
export const desktopRules: RulesApi = {
  list: (filter = {}) => call(rules('List'), filter),
  get: (id) => call(rules('Get'), id),
  history: (id) => call(rules('History'), id),
  openAt: (id, vid, ver) => call(rules('OpenAt'), id, vid, ver),
  openRuleAt: (id, vid, ver) => call(rules('OpenRuleAt'), id, vid, ver),
  groups: (query = '') => call(rules('Groups'), query),
  chapters: () => call(rules('Chapters')),
  generalRules: () => call(rules('GeneralRules')),
  contradictions: () => call(rules('Contradictions')),
  budget: () => call(rules('Budget')),
  previewName: (naming, maker) => call(rules('PreviewName'), naming, maker),
  rulesForAnalysis: () => call(rules('RulesForAnalysis')),
  checkAIResult: (input) => call(rules('CheckAIResult'), input),
  ruleChangesSince: (cursor, limit) => call(rules('RuleChangesSince'), cursor, limit),
  beginEdit: (id) => call(rules('BeginEdit'), id),
  newDraft: (type) => call(rules('NewDraft'), type),
  endEdit: (token) => call(rules('EndEdit'), token),
  save: (input) => call(rules('Save'), input),
  toggle: (input) => call(rules('Toggle'), input),
  restore: (input) => call(rules('Restore'), input),
  recheck: (input) => call(rules('Recheck'), input),
  addGroup: (name, chapters) => call(rules('AddGroup'), name, chapters),
  openTest: (spec) => call(rules('OpenTest'), spec),
  estimateTest: (spec) => call(rules('EstimateTest'), spec),
  startTest: (spec) => call(rules('StartTest'), spec),
  testRunStatus: (runId) => call(rules('TestRunStatus'), runId),
  cancelTest: (runId) => call(rules('CancelTest'), runId),
  prefillFromLesson: (input) => call(rules('PrefillFromLesson'), input),
  saveFromLesson: (input) => call(rules('SaveFromLesson'), input),
};

const suggest = (m: string) => `suggest.Service.${m}`;
const lessons = (m: string) => `lessons.Service.${m}`;

/** Báo giá v1: mỗi hàm gọi đúng suggest.Service.<Hàm> (test đối chiếu service.go). */
export const desktopSuggest: SuggestApi = {
  createBatch: (rows: IntakeRow[]) => call(suggest('CreateBatch'), rows).then((r) => r as { batch: never; items: never }),
  parsePaste: (text: string) =>
    call<{ rows: IntakeRow[] | null; errors: RowError[] | null } | null>(suggest('ParsePaste'), text).then((r) => ({ rows: r?.rows ?? [], errors: r?.errors ?? [] })),
  listBatches: () => call(suggest('ListBatches')),
  setBatchTax: (batchId: string, applyDate: string, coForm: boolean) => call(suggest('SetBatchTax'), batchId, applyDate, coForm),
  listItems: (filter: ItemFilter = {}) => call(suggest('ListItems'), filter),
  getItem: (id: string) => call(suggest('GetItem'), id),
  log: (id: string) => call(suggest('Log'), id),
  addImages: (itemId: string, uploads: ImageUpload[]) => call(suggest('AddImages'), itemId, uploads),
  removeImage: (itemId: string, name: string) => call(suggest('RemoveImage'), itemId, name),
  image: (itemId: string, name: string) => call(suggest('Image'), itemId, name),
  analyze: (itemId: string, mode = 'unconfirmed') => call(suggest('Analyze'), itemId, mode),
  startManual: (itemId: string) => call(suggest('StartManual'), itemId),
  confirm: (itemId: string, field: FieldKey) => call(suggest('Confirm'), itemId, field),
  unconfirm: (itemId: string, field: FieldKey) => call(suggest('Unconfirm'), itemId, field),
  edit: (itemId: string, input: EditRequest) => call(suggest('Edit'), itemId, input),
  revert: (itemId: string, field: FieldKey) => call(suggest('Revert'), itemId, field),
  useFormulaName: (itemId: string) => call(suggest('UseFormulaName'), itemId),
  setManualTax: (itemId: string, field: FieldKey, value: string, basis = '') => call(suggest('SetManualTax'), itemId, field, value, basis),
  setVATChoice: (itemId: string, choice: string) => call(suggest('SetVATChoice'), itemId, choice),
  setDeclarePlace: (itemId: string, place: string) => call(suggest('SetDeclarePlace'), itemId, place),
  editLink: (itemId: string, link: string, confirm = false) => call(suggest('EditLink'), itemId, link, confirm),
  relookup: (batchId: string, itemId = '') => call(suggest('Relookup'), batchId, itemId),
  resolveLessonConflict: (token: string, choice: LessonChoice, text = '') => call(suggest('ResolveLessonConflict'), token, choice, text),
  saveLessonLater: (token: string) => call(suggest('SaveLessonLater'), token),
  chooseFromBlock: (itemId: string, lessonId: string) => call(suggest('ChooseFromBlock'), itemId, lessonId),
  withdrawBlockChoice: (itemId: string, lessonId: string) => call(suggest('WithdrawBlockChoice'), itemId, lessonId),
  askVipo: (itemId: string, text: string) => call(suggest('AskVipo'), itemId, text),
  manualClose: (itemId: string, reason: string) => call(suggest('ManualClose'), itemId, reason),
  approve: (itemId: string) => call(suggest('Approve'), itemId),
  managerApprove: (itemId: string, submittedRev: number) => call(suggest('ManagerApprove'), itemId, submittedRev),
  sendBack: (itemId: string, note: string) => call(suggest('SendBack'), itemId, note),
  bulkApprove: (ids: string[]) => call(suggest('BulkApprove'), ids),
  unflag: (itemId: string, level: string, reason: string) => call(suggest('Unflag'), itemId, level, reason),
  keep: (itemId: string, flag: string) => call(suggest('Keep'), itemId, flag),
  applyNew: (itemId: string, flag: string) => call(suggest('ApplyNew'), itemId, flag),
  editApproved: (itemId: string, reason = '') => call(suggest('EditApproved'), itemId, reason),
  applySheetRow: (itemId: string) => call(suggest('ApplySheetRow'), itemId),
  keepSheetRow: (itemId: string) => call(suggest('KeepSheetRow'), itemId),
  exportQuote: (batchId: string) => call(suggest('ExportQuote'), batchId),
  openCard: (itemId: string) => call(suggest('OpenCard'), itemId),
  touchCard: (itemId: string, lastInput: number) => call(suggest('TouchCard'), itemId, lastInput),
  closeCard: (itemId: string) => call(suggest('CloseCard'), itemId),
  cardPresence: (itemId: string) => call(suggest('CardPresence'), itemId),
  budgetSummary: () => call(suggest('BudgetSummary')),
  budgetDetail: () => call(suggest('BudgetDetail')),
  setBudgetLevel: (levelVnd: number) => call(suggest('SetBudgetLevel'), levelVnd),
  addTopup: (amountVnd: number) => call(suggest('AddTopup'), amountVnd),
  setInvoice: (amountVnd: number) => call(suggest('SetInvoice'), amountVnd),
  serverSkew: () => call(suggest('ServerSkew')),
  answerReceived: (rowRef: string) => call(suggest('AnswerReceived'), rowRef),
  rowChanged: (rowRef: string, change: SheetChange) => call(suggest('RowChanged'), rowRef, change),
  rowDeleted: (rowRef: string) => call(suggest('RowDeleted'), rowRef),
  rowCancelled: (rowRef: string) => call(suggest('RowCancelled'), rowRef),
  recordCopied: (rowRefs: string[], at = 0) => call(suggest('RecordCopied'), rowRefs, at),
};

export const desktopLessons: LessonsApi = {
  reasons: () => call(lessons('Reasons')),
  lessonLabel: (id: string) => call(lessons('LessonLabel'), id),
};

/** Sổ dạy AI (App 4): mỗi hàm gọi đúng lessons.Service.<Hàm> (test đối chiếu service.go). */
export const desktopTeach: TeachApi = {
  list: (filter = {}) => call(lessons('List'), filter),
  detail: (id) => call(lessons('Detail'), id),
  review: (id, seenVer) => call(lessons('Review'), id, seenVer),
  unreview: (id, seenVer) => call(lessons('Unreview'), id, seenVer),
  bulkReview: (filter, seenTotal) => call(lessons('BulkReview'), filter, seenTotal),
  remove: (input) => call(lessons('Remove'), input),
  restore: (id, seenVer) => call(lessons('Restore'), id, seenVer),
  managerEdit: (input) => call(lessons('ManagerEdit'), input),
  ownerEdit: (input) => call(lessons('OwnerEdit'), input),
  ownerRemove: (input) => call(lessons('OwnerRemove'), input),
  addDifference: (id, seenVer, text) => call(lessons('AddDifference'), id, seenVer, text),
  withdraw: (id, seenVer) => call(lessons('Withdraw'), id, seenVer),
  closeKeep: (input) => call(lessons('CloseKeep'), input),
  rulePrefill: (id) => call(lessons('RulePrefill'), id),
  linkRule: (input) => call(lessons('LinkRule'), input),
  pairs: () => call(lessons('Pairs')),
  seenPairs: () => call(lessons('SeenPairs')),
  setPair: (input) => call(lessons('SetPair'), input),
  addPair: (input) => call(lessons('AddPair'), input),
  setThreshold: (input) => call(lessons('SetThreshold'), input),
  allReasons: () => call(lessons('AllReasons')),
  addReason: (label) => call(lessons('AddReason'), label),
  hideReason: (code, hidden) => call(lessons('HideReason'), code, hidden),
  badges: () => call(lessons('Badges')),
  seen: (lessonId) => call(lessons('Seen'), lessonId),
  reminder: () => call(lessons('Reminder')),
  dismissBanner: () => call(lessons('DismissBanner')),
};

/** Sự kiện Go phát khi biểu hoặc danh sách chống bán phá giá đang dùng đổi (dữ liệu: TariffChange). */
export const TARIFF_CHANGED_EVENT = 'tariff:changed';

/**
 * Lỗi Go -> ApiError: mã trước dấu hai chấm; tham số là JSON sau đó (lỗi của biểu thuế, kể cả khi đi qua hs-suggest:
 * khoá tham số là chữ trong ngoặc nhọn của câu, có dấu, vd "mã HS", nên không đi qua "k=v" của lõi) hoặc "k=v" (lỗi
 * của lõi, vd permission_denied).
 */
export function parseTariffError(msg: string): ApiError {
  const code = parseErrorCode(msg);
  const detail = /^\s*[a-z][a-z0-9_]*\s*:\s*(.*)$/s.exec(msg)?.[1] ?? '';
  if (detail.startsWith('{')) {
    try {
      const raw = JSON.parse(detail) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) params[k] = String(v);
        return new ApiError(code, 0, params);
      }
    } catch {
      // không phải JSON: đọc như lỗi của lõi
    }
  }
  return new ApiError(code, 0, parseErrorParams(msg));
}

async function callTariff<T>(name: string, ...args: unknown[]): Promise<T> {
  const fn = goFn(`tariff.Service.${name}`);
  try {
    return (await Reflect.apply(fn, undefined, args)) as T;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[go] tariff.Service.${name}:`, msg);
    throw parseTariffError(msg);
  }
}

const orEmpty = <T>(p: Promise<T[] | null>) => p.then((r) => r ?? []);

/** Biểu thuế: mỗi hàm gọi đúng tariff.Service.<Hàm> (test đối chiếu với các hàm exported của service.go). */
export const desktopTariff: TariffApi = {
  overview: () => callTariff('Overview'),
  history: () => orEmpty(callTariff('History')),
  versionDetail: (id) => callTariff('VersionDetail', id),
  pendingChoice: (l: TariffList) => callTariff('PendingChoice', l),
  adOverview: () => callTariff('ADOverview'),
  adHistory: () => orEmpty(callTariff('ADHistory')),
  riskOverview: () => callTariff('RiskOverview'),
  riskHistory: () => orEmpty(callTariff('RiskHistory')),
  riskLookup: (code) => callTariff('RiskLookup', code),
  openSource: (versionId) => callTariff('OpenSource', versionId),
  itemView: (itemId) => callTariff('ItemView', itemId),
  itemViewAt: (itemId, vid) => callTariff('ItemViewAt', itemId, vid),
  itemFlags: (itemId) => orEmpty(callTariff('ItemFlags', itemId)),
  totals: (itemIds) => callTariff('Totals', itemIds),
  taxHistory: (itemId) => orEmpty(callTariff('TaxHistory', itemId)),
  vatSuggestion: (code) => callTariff('VATSuggestion', code),
  validateApplyDate: (date) => callTariff('ValidateApplyDate', date),
  opsLog: () => callTariff('OpsLog'),
  deviceStatus: () => callTariff('DeviceStatus'),
  pickScheduleFile: () => callTariff<ImportSession | null>('PickScheduleFile'),
  chooseSheet: (sessionId, sheet) => callTariff('ChooseSheet', sessionId, sheet),
  renameImport: (sessionId, name) => callTariff('RenameImport', sessionId, name),
  preview: (sessionId) => callTariff('Preview', sessionId),
  confirmImport: (sessionId, ack: PreviewAck) => callTariff<TariffSaveResult>('ConfirmImport', sessionId, ack),
  cancelImport: (sessionId) => callTariff('CancelImport', sessionId),
  exportErrorRows: (sessionId, versionId) => callTariff('ExportErrorRows', sessionId, versionId),
  unload: (versionId, confirmInUse) => callTariff('Unload', versionId, confirmInUse),
  pickADFile: () => callTariff<ImportSession | null>('PickADFile'),
  previewAD: (sessionId) => callTariff('PreviewAD', sessionId),
  confirmAD: (sessionId) => callTariff<TariffSaveResult>('ConfirmAD', sessionId),
  unloadAD: (versionId) => callTariff('UnloadAD', versionId),
  pickRiskFile: () => callTariff<ImportSession | null>('PickRiskFile'),
  previewRisk: (sessionId) => callTariff('PreviewRisk', sessionId),
  confirmRisk: (sessionId) => callTariff<RiskSaveResult>('ConfirmRisk', sessionId),
  unloadRisk: (versionId) => callTariff('UnloadRisk', versionId),
  chooseVersion: (versionId) => callTariff('ChooseVersion', versionId),
  setFormE: (itemId, mode: FormEMode) => callTariff<TaxView>('SetFormE', itemId, mode),
  chooseVAT: (itemId, rate, basis) => callTariff<TaxView>('ChooseVAT', itemId, rate, basis),
  setManual: (itemId, kind: TaxKind, value, unit, basis) => callTariff<TaxView>('SetManual', itemId, kind, value, unit, basis),
  clearManual: (itemId, kind: TaxKind) => callTariff<TaxView>('ClearManual', itemId, kind),
  keepOld: (itemId, flagKey) => callTariff<TaxView>('KeepOld', itemId, flagKey),
  applyNewPreview: (itemId) => callTariff('ApplyNewPreview', itemId),
  applyNewTax: (itemId, input: ApplyNewInput) => callTariff<TaxView>('ApplyNewTax', itemId, input),
  saveBatchTax: (batchId, date, coForm) => callTariff<boolean>('SaveBatchTax', batchId, date, coForm),
};

/** Sự kiện Go phát sau mỗi lần đọc Sheet Vipo và lượt kéo mang bản ghi Sheet về. */
export const VIPO_CHANGED_EVENT = 'vipo:changed';

async function callVipo<T>(name: string, ...args: unknown[]): Promise<T> {
  const fn = goFn(`vipo.Service.${name}`);
  try {
    return (await Reflect.apply(fn, undefined, args)) as T;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[go] vipo.Service.${name}:`, msg);
    throw parseTariffError(msg); // cùng dạng lỗi "khoá: {JSON tham số}"
  }
}

/** Sự kiện Go phát sau mỗi lần ghi của Gộp lô và lượt kéo mang bản ghi lô về. */
export const LOT_CHANGED_EVENT = 'lot:changed';

async function callLot<T>(name: string, ...args: unknown[]): Promise<T> {
  const fn = goFn(`lot.Service.${name}`);
  try {
    return (await Reflect.apply(fn, undefined, args)) as T;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[go] lot.Service.${name}:`, msg);
    throw parseLotError(msg); // "khoá: {JSON tham số}", dữ liệu kèm dưới "_data"
  }
}

/** Gộp lô: mỗi hàm gọi đúng lot.Service.<Hàm> theo LOT_METHODS (test Go đối chiếu với các hàm exported của service.go). */
export const desktopLot: LotApi = Object.fromEntries(
  (Object.keys(LOT_METHODS) as (keyof LotApi)[]).map((k) => [k, (...args: unknown[]) => callLot(LOT_METHODS[k], ...args)]),
) as unknown as LotApi;

async function callCheck<T>(name: string, ...args: unknown[]): Promise<T> {
  const fn = goFn(`check.Service.${name}`);
  try {
    return (await Reflect.apply(fn, undefined, args)) as T;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[go] check.Service.${name}:`, msg);
    throw parseCheckError(msg); // "khoá: {JSON tham số}", dữ liệu kèm dưới "_data"
  }
}

/** Kiểm tra trước khai báo: mỗi hàm gọi đúng check.Service.<Hàm> theo CHECK_METHODS (test Go đối chiếu với các hàm exported của service.go). */
export const desktopCheck: CheckApi = Object.fromEntries(
  (Object.keys(CHECK_METHODS) as (keyof CheckApi)[]).map((k) => [k, (...args: unknown[]) => callCheck(CHECK_METHODS[k], ...args)]),
) as unknown as CheckApi;

/** Sheet Vipo: mỗi hàm gọi đúng vipo.Service.<Hàm> (test đối chiếu với các hàm exported của service.go). */
export const desktopVipo: VipoApi = {
  overview: () => callVipo('Overview'),
  loadSheet: (link) => callVipo('LoadSheet', link),
  previewTab: (m) => callVipo('PreviewTab', m),
  testMapping: (m) => callVipo('TestMapping', m),
  saveMapping: (m, confirmOpen) => callVipo('SaveMapping', m, confirmOpen),
  mappingHistory: () => orEmpty(callVipo('MappingHistory')),
  readLog: (days) => orEmpty(callVipo('ReadLog', days)),
  readNow: () => callVipo('ReadNow'),
  intakeList: (from, to) => callVipo('IntakeList', from, to),
  createBatch: (rows) => callVipo('CreateBatch', rows),
  openBatch: () => callVipo('OpenBatch'),
  itemSheet: (itemId) => callVipo('ItemSheet', itemId),
  keepDesc: (itemId, eventId) => callVipo('KeepDesc', itemId, eventId),
  updateDesc: (itemId, eventId) => callVipo('UpdateDesc', itemId, eventId),
  keepGone: (itemId, eventId) => callVipo('KeepGone', itemId, eventId),
  cancelGone: (itemId, eventId) => callVipo('CancelGone', itemId, eventId),
  merge: (itemId, newRow) => callVipo('Merge', itemId, newRow),
  mergeNo: (itemId, newRow) => callVipo('MergeNo', itemId, newRow),
  previewManualTarget: (itemId, row) => callVipo('PreviewManualTarget', itemId, row),
  setManualTarget: (itemId, row) => callVipo('SetManualTarget', itemId, row),
  twinDecide: (itemId, action) => callVipo('TwinDecide', itemId, action),
  writeHistory: (itemId) => orEmpty(callVipo('WriteHistory', itemId)),
  copyList: (batchId) => callVipo('CopyList', batchId),
  startCopy: (batchId, itemIds) => callVipo('StartCopy', batchId, itemIds),
  checkTargets: (copyId) => callVipo('CheckTargets', copyId),
  resolveMatch: (copyId, itemId, row) => callVipo('ResolveMatch', copyId, itemId, row),
  skipRow: (copyId, itemId) => callVipo('SkipRow', copyId, itemId),
  overwrite: (copyId, itemId) => callVipo('Overwrite', copyId, itemId),
  copyBlock: (copyId, index) => callVipo('CopyBlock', copyId, index),
  copyText: (text) => callVipo('CopyText', text),
  confirmPasted: (copyId) => callVipo('ConfirmPasted', copyId),
  copyRound: (copyId) => callVipo('CopyRound', copyId),
  threads: (f) => callVipo('Threads', f),
  thread: (itemId) => callVipo('Thread', itemId),
  sendQuestion: (itemId, text) => callVipo('SendQuestion', itemId, text),
  writeResults: (itemId) => callVipo('WriteResults', itemId),
  writeBatchResults: (batchId) => callVipo('WriteBatchResults', batchId),
  markThreadDone: (itemId, messageId) => callVipo('MarkThreadDone', itemId, messageId),
};

export const desktopPlatform: Platform = {
  kind: 'desktop',
  getState: () => call<AppState>('GetState'),
  login: (username, password) => call<User>('Login', username, password),
  logout: () => call<number>('Logout'),
  changePassword: (current, next, confirm) => call<User>('ChangePassword', current, next, confirm),
  onAuthState: (cb) => onEvent('auth:state', (d) => cb(d as AuthState)),
  listReviewOps: () => call<ReviewOp[]>('ListReviewOps').then((r) => r ?? []),
  dismissRejected: (id) => call<void>('DismissRejected', id),
  api: <T>(path: string, init?: { method?: string; body?: unknown }) =>
    call<T>('CallAPI', init?.method ?? 'GET', path, init?.body === undefined ? '' : JSON.stringify(init.body)),
  googleToken: () => call<GoogleToken>('GoogleToken'),
  activateLicense: (key) => call<LicenseInfo>('ActivateLicense', key),
  checkUpdate: () => call<UpdateInfo>('CheckUpdate'),
  applyUpdate: (kind) => call<void>('ApplyUpdate', kind),
  updateStatus: () => call<UpdateInfo>('UpdateStatus'),
  onUpdateStatus: (cb) => onEvent('update:status', (d) => cb(d as UpdateInfo)),

  // App 1 - Báo giá
  listRequests: (status = '') => call<QuoteRequest[]>(quote('ListRequests'), status).then((r) => r ?? []),
  saveCard: (input) => call<QuoteRequest>(quote('SaveCard'), input),
  pullRequests: () => call<number>(quote('PullRequests')),
  syncNow: () => call<SyncStatus>('SyncNow'),
  listSyncIssues: () => call<SyncIssue[]>('ListSyncIssues').then((r) => r ?? []),
  resolveSyncIssue: (id, keepMine) => call<void>('ResolveSyncIssue', id, keepMine),
  onSyncStatus: (cb) => onEvent('sync:status', (d) => cb(d as SyncStatus)),

  // Đồng bộ Drive công ty
  driveStatus: () => call<DriveSyncState>(drive('Status')),
  drivePullNow: () => call<void>(drive('PullNow')),
  listConflicts: () => call<DriveConflict[]>(drive('ListConflicts')).then((r) => r ?? []),
  getConflict: (id) => call<DriveConflictDetail>(drive('GetConflict'), id),
  resolveConflict: (id, keepMine) => call<void>(drive('ResolveConflict'), id, keepMine),
  listVersions: (kind, id) => call<ItemVersion[]>(drive('ListVersions'), kind, id).then((r) => r ?? []),
  restoreVersion: (input) => call<RestoreResult>(drive('Restore'), input),
  removeItem: (kind, id) => call<void>(drive('Remove'), kind, id),
  undoRemoveItem: (kind, id) => call<void>(drive('UndoRemove'), kind, id),
  listNotices: () => call<DriveNotice[]>(drive('ListNotices')).then((r) => r ?? []),
  seeNotice: (id) => call<void>(drive('SeeNotice'), id),
  driveInfo: () => call<DriveInfo>(drive('DriveInfo')),
  initDriveRoot: () => call<string>(drive('InitRoot')),
  backupNow: () => call<BackupResult>(drive('BackupNow')),
  bootstrapProgress: () => call<BootstrapProgress>(drive('BootstrapProgress')),
  listDeviceStatus: () => call<AdminSyncStatus>(drive('ListDeviceStatus')),
  listDriveAlerts: () => call<DriveAlert[]>(drive('ListAlerts')).then((r) => r ?? []),
  seeDriveAlert: (id) => call<void>(drive('SeeAlert'), id),
  exportSyncLog: () => call<string>(drive('ExportSyncLog')),
  confirmClose: (wait) => call<void>('ConfirmClose', wait),
  onClosePending: (cb) => onEvent('sync:close_pending', (d) => cb(d as ClosePending)),
  onNetProgress: (cb) => onEvent(NET_EVENT, (d) => cb(d as NetEvent)),

  rules: desktopRules,
  suggest: desktopSuggest,
  lessons: desktopLessons,
  tariff: desktopTariff,
  teach: desktopTeach,
  onTariffChanged: (cb) => onEvent(TARIFF_CHANGED_EVENT, (d) => cb(d as TariffChange)),
  vipo: desktopVipo,
  onVipoChanged: (cb) => onEvent(VIPO_CHANGED_EVENT, () => cb()),
  lot: desktopLot,
  onLotChanged: (cb) => onEvent(LOT_CHANGED_EVENT, () => cb()),
  check: desktopCheck,
  onCheckChanged: (cb) => onEvent(CHECK_CHANGED_EVENT, () => cb()),
};



/** Nghe sự kiện do Go phát (core.Emit). */
function onEvent(name: string, cb: (data: unknown) => void): () => void {
  if (typeof window === 'undefined') return () => undefined; // render phía máy chủ / test node: không có runtime Wails
  const rt = (window as unknown as { runtime?: WailsRuntime }).runtime;
  if (!rt) return () => undefined;
  const off = rt.EventsOn(name, cb);
  return typeof off === 'function' ? off : () => rt.EventsOff(name);
}

interface WailsRuntime {
  EventsOn(name: string, cb: (data: unknown) => void): (() => void) | void;
  EventsOff(name: string): void;
}
