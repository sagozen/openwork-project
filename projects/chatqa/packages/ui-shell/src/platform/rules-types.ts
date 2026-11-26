// Kiểu của sổ quy tắc phân loại: khớp JSON của apps/hs-desk/desktop/internal/modules/rules (service.go và các kiểu nó
// trả). Đổi tên trường ở Go thì sửa ở đây cùng lúc. Mã lỗi, khoá câu: contracts/errors.json (classificationRules).

export type RuleType = 'classify' | 'naming' | 'maker';
/** Mã cố định của hai quy tắc ghim. */
export const RULE_ID_NAMING = 'naming';
export const RULE_ID_MAKER = 'maker';

export type RuleChangeKind = 'create' | 'edit' | 'enable' | 'disable' | 'restore' | 'overwrite' | 'conflict_pick';
export type RuleLabelCode = 'untested' | 'stale_test' | 'unchecked' | 'contradiction' | 'not_in_tariff' | 'conflict_pending' | 'admin_pending';

export interface RuleLabel {
  code: RuleLabelCode;
  /** "đang mâu thuẫn với #n": mã và số quy tắc kia. */
  with?: string;
  withNo?: number;
}

export interface ClassifyBody {
  name: string;
  groupId: string;
  features?: string[];
  /** Chỉ chữ số, đúng hsLen số. */
  hs: string;
  /** 4 | 6 | 8. */
  hsLen: number;
  explain?: string;
}

export type NamingPart = 'name' | 'use' | 'specs' | 'brand' | 'maker';

export interface GroupNote {
  groupId: string;
  note: string;
}

export interface NamingBody {
  parts: NamingPart[];
  separator: string;
  maxLen: number;
  notes?: GroupNote[];
  colours?: string[];
  /** "mới 100%": một lần, luôn ở cuối. */
  tail: string;
}

export interface MakerBody {
  withBrand: string;
  withMaker: string;
  noBrand: string;
  noMaker: string;
  defaultText: string;
}

/** Đúng một trường có theo loại quy tắc. */
export interface RuleBody {
  classify?: ClassifyBody;
  naming?: NamingBody;
  maker?: MakerBody;
}

export interface RuleFlags {
  untested?: boolean;
  staleTest?: boolean;
  unchecked?: boolean;
}

export interface RulePair {
  with: string;
  verdict: 'contradiction' | 'not_duplicate';
  selfHash: string;
  withHash: string;
  condition?: string;
  aiReason?: string;
  reason?: string;
  by?: string;
  byName?: string;
  at?: number;
}

/** Nội dung một phiên bản quy tắc. */
export interface Rule {
  type: RuleType;
  ver: number;
  vid: string;
  /** Phiên bản mà phiên bản này sửa từ đó (thiếu = bản đầu hoặc lưu trước khi có trường này). */
  prevVid?: string;
  change: RuleChangeKind | string;
  write?: 'labels' | 'number' | 'recheck';
  enabled: boolean;
  /** 0/thiếu = "Quy tắc mới (chưa có số)". */
  no?: number;
  reason?: string;
  createdBy?: string;
  createdByName?: string;
  createdAt?: number;
  editedBy?: string;
  editedByName?: string;
  editedAt?: number;
  flags: RuleFlags;
  pairs?: RulePair[];
  labelsAtSave?: RuleLabel[];
  body: RuleBody;
}

export interface RuleFilter {
  query?: string;
  type?: RuleType | '';
  state?: 'on' | 'off' | '';
  label?: RuleLabelCode | '';
}

/** Một dòng sổ quy tắc. */
export interface RuleRow {
  id: string;
  type: RuleType;
  no: number;
  ver: number;
  vid: string;
  name: string;
  groupId?: string;
  groupName?: string;
  features?: string[];
  hs?: string;
  hsLen?: number;
  /** Giải thích căn cứ, hiện cạnh dòng THÌ. */
  explain?: string;
  enabled: boolean;
  labels: RuleLabel[];
  editedBy?: string;
  editedByName?: string;
  editedAt?: number;
  pinned: boolean;
  /** "Chưa đồng bộ". */
  unsynced: boolean;
}

/** pinned: công thức đặt tên, quy tắc tên NSX (luôn có). total/enabled đếm mọi quy tắc phân loại, không theo bộ lọc. */
export interface RuleList {
  pinned: RuleRow[];
  rows: RuleRow[];
  total: number;
  enabled: number;
}

export interface RuleView {
  id: string;
  rule: Rule;
  labels: RuleLabel[];
  unsynced: boolean;
}

/** Phiên soạn (màn soạn đang mở). Mọi Lưu/Bật-Tắt/Khôi phục/Chạy thử từ màn soạn kèm token. */
export interface RuleDraft {
  token: string;
  id: string;
  type: RuleType;
  isNew: boolean;
  baseRev: number;
  baseVer: number;
  baseVid: string;
  rule: Rule;
  labels: RuleLabel[];
}

export interface FieldChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export interface RuleSubEntry {
  write: 'labels' | 'number' | 'recheck';
  by: string;
  byName: string;
  device: string;
  at: number;
  no?: number;
  labels: RuleLabel[];
  rejected?: boolean;
  lost?: boolean;
}

export interface RuleHistoryEntry {
  ver: number;
  vid: string;
  change: RuleChangeKind | string;
  by: string;
  byName: string;
  device: string;
  at: number;
  reason?: string;
  enabled: boolean;
  diff: FieldChange[];
  labels: RuleLabel[];
  /** "Bản đầu" của công thức đặt tên, quy tắc tên NSX. */
  initial?: boolean;
  rejected?: boolean;
  lost?: boolean;
  onDrive: boolean;
  sub: RuleSubEntry[];
}

export type RuleHistory = RuleHistoryEntry[];

/** Một phiên bản đúng như lúc đó (labels = nhãn tại thời điểm đó). */
export interface RuleVersionView {
  id: string;
  rule: Rule;
  labels: RuleLabel[];
  rejected: boolean;
  lost: boolean;
  currentVer: number;
  currentVid: string;
}

/** Phiên bản đã áp cho mặt hàng; currentVer/currentVid chỉ có khi bản hiện hành là phiên bản khác. */
export interface RuleAtVersion {
  id: string;
  rule: Rule;
  labels: RuleLabel[];
  rejected: boolean;
  lost: boolean;
  currentVer?: number;
  currentVid?: string;
}

export interface TariffChapter {
  code: string;
  title: string;
}

export interface Group {
  id: string;
  name: string;
  chapters: TariffChapter[];
  source: 'seed' | 'manager';
}

/** available=false: chưa có biểu, UI báo rules_no_6qt. */
export interface GeneralRulesView {
  available: boolean;
  title: string;
  rows: string[];
}

export interface ContradictionPair {
  a: RuleRow;
  b: RuleRow;
  condition: string;
  aiReason: string;
  byName: string;
  at: number;
}

/** Ngân sách AI của sổ quy tắc (VND). */
export interface BudgetView {
  month: string;
  budgetVnd: number;
  usedVnd: number;
  purposeUsedVnd: number;
  ceilingPercent: number;
  ceilingVnd: number;
  model: string;
  inUsdPerM: number;
  outUsdPerM: number;
  usdVnd: number;
}

/** Tên khai ví dụ trên màn soạn công thức: "{chars} / {maxLen} ký tự", "Đã bỏ '{màu}'". */
export interface NamePreview {
  withMaker: boolean;
  name: string;
  chars: number;
  maxLen: number;
  over: boolean;
  dropped: string[];
}

// ---------- Lưu, Bật/Tắt, Khôi phục ----------

export type DecisionAction = 'edit' | 'discard' | 'not_duplicate' | 'keep' | 'keep_off' | 'disable';

export interface Decision {
  with: string;
  action: DecisionAction;
  /** Bắt buộc với not_duplicate (E-020). */
  reason?: string;
}

export interface SaveOptions {
  confirmTariff?: boolean;
  newer?: '' | 'overwrite' | 'asNew';
  confirmOverwrite?: boolean;
  /** Phiên bản hộp xác nhận Ghi đè đã cho xem (newer.current.vid); bản hiện hành đã khác thì Go hỏi lại cho bản mới. */
  overwriteVid?: string;
  disableOriginal?: boolean;
  decisions?: Decision[];
}

export interface SaveInput {
  token: string;
  body: RuleBody;
  opts?: SaveOptions;
}

/** code: rules_field_missing | rules_hs_format | rules_name_limit | rules_reason_required...; params điền câu lỗi. */
export interface FieldIssue {
  field: string;
  label: string;
  code: string;
  params?: Record<string, string | number>;
}

/** E-004: code rules_hs_not_in_tariff (có biểu) | rules_no_tariff. */
export interface TariffNotice {
  code: 'rules_hs_not_in_tariff' | 'rules_no_tariff';
  hs: string;
  schedule?: string;
}

/** E-011: confirm = bước xác nhận lần hai của Ghi đè. */
export interface NewerNotice {
  no: number;
  ver: number;
  byName: string;
  at: number;
  fields: FieldChange[];
  current: Rule;
  confirm: boolean;
}

/** E-009 (duplicate) / E-010 (contradiction). keep: quy tắc nên giữ khi trùng. */
export interface Finding {
  with: string;
  withNo: number;
  withName: string;
  withHash: string;
  verdict: 'duplicate' | 'contradiction';
  condition: 'same' | 'overlap';
  result: 'equal' | 'nested' | 'different';
  aiReason: string;
  keep?: string;
}

export interface ReplacedChange {
  userId: string;
  name: string;
  at: number;
  /** Phiên bản hiện hành sẽ bị thay; gửi lại trong currentVid khi xác nhận khôi phục. */
  vid?: string;
}

/**
 * Kết quả Lưu / Bật-Tắt / Khôi phục. saved=false kèm một trong fields, tariff, newer, findings, replaces = bước hỏi
 * (chưa ghi gì): gọi lại với SaveOptions/confirm tương ứng. saved=true kèm unchecked = đã lưu, chưa kiểm trùng (E-008).
 */
export interface SaveResult {
  saved: boolean;
  id?: string;
  ver?: number;
  no?: number;
  unchecked?: boolean;
  fields?: FieldIssue[];
  tariff?: TariffNotice;
  newer?: NewerNotice;
  findings?: Finding[];
  replaces?: ReplacedChange;
  discarded?: boolean;
  same?: boolean;
  unchanged?: boolean;
}

export interface ToggleInput {
  token?: string;
  id: string;
  on: boolean;
  opts?: SaveOptions;
}

export interface RuleRestoreInput {
  token?: string;
  id: string;
  vid: string;
  reason: string;
  /** Đã xem cảnh báo "Sẽ thay thế thay đổi của {tên} lúc {giờ}". */
  confirm?: boolean;
  /** Phiên bản hiện hành lúc cảnh báo được cho xem; đã khác thì Go cảnh báo lại cho bản mới (replaces). */
  currentVid?: string;
  opts?: SaveOptions;
}

export interface RecheckInput {
  ids?: string[];
  all?: boolean;
  /** Quyết định theo mã quy tắc cho kết quả lượt trước. */
  decisions?: Record<string, Decision[]>;
}

export interface RecheckItem {
  id: string;
  no: number;
  name: string;
  cleared?: boolean;
  unchecked?: boolean;
  reason?: string;
  findings?: Finding[];
  fields?: FieldIssue[];
  disabled?: boolean;
  kept?: boolean;
}

export interface RecheckResult {
  items: RecheckItem[];
}

/** group: đã thêm. existing: tên đã có (E-019, "Dùng nhóm này"). fields: thiếu tên hoặc chương. */
export interface AddGroupResult {
  group?: Group;
  existing?: Group;
  fields?: FieldIssue[];
}

// ---------- Chạy thử ----------

export interface TestExample {
  name: string;
  specs: string;
  description?: string;
  images?: string[];
}

/** token + body: chạy bản soạn; ruleId (không token): chạy từ sổ trên quy tắc đã lưu. */
export interface TestSpec {
  token?: string;
  ruleId?: string;
  body?: RuleBody;
  selected?: string[];
  examples?: TestExample[];
  compare?: boolean;
  confirmTariff?: boolean;
}

export interface TestNotice {
  code: string;
  params?: Record<string, string | number>;
}

export interface SampleItem {
  id: string;
  name: string;
  use: string;
  specs: string;
  description: string;
  brand: string;
  maker: string;
  images: string[];
  hs: string;
  declaredName: string;
  approvedAt: number;
  createdAt: number;
}

/** code: rules_ai_budget (E-007) hoặc mã lỗi khi không đọc được ngân sách; ceiling: thêm câu rules_ai_ceiling. */
export interface TestEstimate {
  costVnd: number;
  calls: number;
  remainingVnd: number;
  ceilingLeftVnd: number;
  ceilingPercent: number;
  canRun: boolean;
  code?: string;
  ceiling?: boolean;
}

export interface TestSetup {
  type: RuleType | '';
  groupName?: string;
  samples: SampleItem[];
  /** E-005: nhập tối đa maxExamples ví dụ tay hoặc bỏ qua chạy thử. */
  noSamples?: TestNotice;
  maxExamples: number;
  estimate?: TestEstimate;
  fields?: FieldIssue[];
  tariff?: TariffNotice;
}

/** runId rỗng = chưa chạy: fields/tariff cần sửa hoặc xác nhận, estimate khoá nút (E-007). */
export interface TestStart {
  runId?: string;
  fields?: FieldIssue[];
  tariff?: TariffNotice;
  estimate?: TestEstimate;
}

export interface TestAnswer {
  hs: string;
  declaredName: string;
  ruleIds?: string[];
}

export interface TestItem {
  id: string;
  name: string;
  manual: boolean;
  done: boolean;
  beforeApproved: boolean;
  before?: TestAnswer;
  after?: TestAnswer;
  diff: boolean;
  inGroup: boolean;
}

export interface TestRun {
  id: string;
  type: RuleType;
  state: 'running' | 'done' | 'stopped' | 'cancelled';
  done: number;
  total: number;
  items: TestItem[];
  costVnd: number;
  compare: boolean;
  /** E-006 (rules_test_stopped) hoặc E-007 khi dừng. */
  stop?: TestNotice;
  ceiling?: boolean;
  bodyHash: string;
}

// ---------- Từ Sổ dạy AI ----------

export interface LessonInput {
  lessonId: string;
  kind: 'hs' | 'name';
  itemName?: string;
  correctHs?: string;
  correctName?: string;
  reason?: string;
}

/** Phiên soạn mở từ bài học: body điền sẵn, example = tên khai đúng (bài sửa tên khai). */
export interface LessonPrefill {
  session: RuleDraft;
  lessonId: string;
  kind: 'hs' | 'name';
  body: RuleBody;
  example?: string;
}

export interface LessonLink {
  lessonId: string;
  ruleId: string;
  no: number;
  /** "Quy tắc #n" | "Quy tắc mới (chưa có số)" | "Công thức đặt tên". */
  display: string;
}

export interface LessonSave {
  result: SaveResult;
  link?: LessonLink;
}

// ---------- Cho các phân hệ sau ----------

export interface AnalysisRule {
  id: string;
  no: number;
  ver: number;
  vid: string;
  name: string;
  groupId: string;
  groupName: string;
  chapters: TariffChapter[];
  features: string[];
  hs: string;
  hsLen: number;
  explain: string;
  contradictsWith: string[];
}

export interface AnalysisRules {
  rules: AnalysisRule[];
  naming: { ver: number; vid: string; body: NamingBody };
  maker: { ver: number; vid: string; body: MakerBody };
  colours: string[];
}

export interface AIResult {
  hs: string;
  cited: { ruleId: string; vid: string }[];
  groupIds: string[];
}

export interface RuleDeviation {
  ruleId: string;
  no: number;
  ver: number;
  vid: string;
  hs: string;
  cited: boolean;
}

export interface RuleChange {
  seq: number;
  ruleId: string;
  type: RuleType;
  no: number;
  ver: number;
  vid: string;
  cause: string;
  at: number;
}

/** next: con trỏ cho lần gọi sau. */
export interface RuleChangesPage {
  changes: RuleChange[];
  next: number;
}

/**
 * Sổ quy tắc (chỉ desktop): mỗi hàm gọi đúng một hàm rules.Service.<Hàm> ở Go (cùng tên, viết hoa chữ đầu).
 * Mọi thao tác thay đổi sổ bị Go từ chối khi thiếu quyền: rules_forbidden (E-016) hoặc rules_perm_lost (E-012).
 */
export interface RulesApi {
  list(filter?: RuleFilter): Promise<RuleList>;
  get(id: string): Promise<RuleView>;
  history(id: string): Promise<RuleHistory>;
  /** vid, hoặc ver khi vid rỗng. Chưa có trên máy: rules_version_missing với params {x, vid, ruleId, action}. */
  openAt(id: string, vid: string, ver: number): Promise<RuleVersionView>;
  openRuleAt(id: string, vid: string, ver: number): Promise<RuleAtVersion>;
  groups(query?: string): Promise<Group[]>;
  chapters(): Promise<TariffChapter[]>;
  generalRules(): Promise<GeneralRulesView>;
  contradictions(): Promise<ContradictionPair[]>;
  budget(): Promise<BudgetView>;
  previewName(naming: NamingBody, maker: MakerBody): Promise<NamePreview[]>;
  rulesForAnalysis(): Promise<AnalysisRules>;
  checkAIResult(input: AIResult): Promise<RuleDeviation[]>;
  ruleChangesSince(cursor: number, limit: number): Promise<RuleChangesPage>;

  beginEdit(id: string): Promise<RuleDraft>;
  /** Chỉ 'classify'; công thức đặt tên, quy tắc tên NSX mở bằng beginEdit. */
  newDraft(type: RuleType): Promise<RuleDraft>;
  endEdit(token: string): Promise<void>;
  save(input: SaveInput): Promise<SaveResult>;
  toggle(input: ToggleInput): Promise<SaveResult>;
  restore(input: RuleRestoreInput): Promise<SaveResult>;
  recheck(input: RecheckInput): Promise<RecheckResult>;
  addGroup(name: string, chapters: string[]): Promise<AddGroupResult>;
  openTest(spec: TestSpec): Promise<TestSetup>;
  estimateTest(spec: TestSpec): Promise<TestEstimate>;
  startTest(spec: TestSpec): Promise<TestStart>;
  testRunStatus(runId: string): Promise<TestRun>;
  /** Gọi khi Huỷ và khi đóng màn Chạy thử. */
  cancelTest(runId: string): Promise<void>;
  prefillFromLesson(input: LessonInput): Promise<LessonPrefill>;
  saveFromLesson(input: SaveInput): Promise<LessonSave>;
}
