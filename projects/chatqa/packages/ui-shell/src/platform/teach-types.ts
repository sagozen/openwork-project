// Kiểu dữ liệu của các màn Sổ dạy AI (App 4 `teach`), khớp JSON của Go (internal/modules/lessons/views.go). UI gọi qua
// platform.teach (desktop); PWA từ chối desktop_only. Giờ là Unix giây, UI hiện HH:mm giờ Việt Nam.
import type { LessonInput, LessonLink } from './rules-types';

export type LessonStatus = 'unreviewed' | 'reviewed' | 'removed' | 'cancelled';
export type LessonField = 'declaredName' | 'hs';
export type LessonScope = 'similar' | 'item';
export type LessonSource = 'card' | 'customs' | 'precheck';
export type LedgerLabel = 'contradiction' | 'unchecked' | 'itemOnly' | 'overdue';

/** Bộ lọc Sổ. statuses và labels cùng rỗng = bài hiệu lực (mặc định); from/to = YYYY-MM-DD giờ Việt Nam. */
export interface LedgerFilter {
  authors?: string[];
  statuses?: LessonStatus[];
  labels?: LedgerLabel[];
  fields?: LessonField[];
  sources?: LessonSource[];
  from?: string;
  to?: string;
  query?: string;
  cursor?: string;
  limit?: number;
  includeCancelled?: boolean;
}

export interface RowLabels {
  contradiction?: boolean;
  unchecked?: boolean;
  itemOnly?: boolean;
  customs?: boolean;
  overdue?: boolean;
  createdRule?: string;
  contradictsRule?: number;
}

export interface LedgerRow {
  id: string;
  no?: number;
  itemId: string;
  image?: string;
  itemName: string;
  spec?: string;
  field: LessonField;
  before: string;
  after: string;
  reasonCode: string;
  reasonLabel: string;
  note?: string;
  scope: LessonScope;
  status: LessonStatus;
  source: LessonSource;
  author: string;
  authorId?: string;
  at: number;
  labels: RowLabels;
  applied: number;
  /** Số lần người làm thao tác trên bài: gửi lại làm seenVer để Go kiểm "người khác vừa xử lý" (E-007). */
  ver: number;
}

export interface AuthorOption { id: string; name: string }

export interface LedgerPage {
  rows: LedgerRow[];
  total: number;
  next?: string;
  /** Số bài theo chip (unreviewed, reviewed, removed, cancelled, contradiction, unchecked, itemOnly, overdue, effective). */
  counts: Record<string, number>;
  authors: AuthorOption[];
  canSeeAll: boolean;
}

export interface ItemRef { id: string; batchId?: string; name?: string; status?: string; exists: boolean }

/** source: 1 AI dẫn, 2 Sửa theo bài cũ, 3 chọn ở Khối gợi ý. */
export interface AppliedItem { itemId: string; itemName?: string; itemStatus?: string; source: 1 | 2 | 3; at: number }

export type CloseCause = 'difference' | 'removed' | 'cancelled' | 'itemOnly' | 'sameValue';

export interface LinkView {
  pairId: string;
  otherId: string;
  otherNo?: number;
  otherAuthor?: string;
  otherAfter?: string;
  otherMine?: boolean;
  /** Ver của bài kia: seenVer khi quản lý đóng mâu thuẫn giữ bài đang xem. */
  otherVer: number;
  open: boolean;
  closedBy?: CloseCause;
  note?: string;
  at: number;
}

export interface RelatedLesson { id: string; no?: number; after: string; author?: string; status: LessonStatus; sameKind: boolean; similarity: number }

export interface CreatedRule { id: string; no?: number; display: string }

export type RemovalKind = 'owner' | 'manager' | 'closeKeep' | 'conflictLoss';
export interface Removal { reason: string; kind: RemovalKind; byId?: string; byName?: string; at: number }

export interface HistoryEntry {
  act: string;
  by?: string;
  device?: string;
  deviceTime: number;
  syncedAt?: number;
  offline?: boolean;
  status?: LessonStatus;
  after?: string;
  reason?: string;
}

export type ActionCode =
  | 'review' | 'unreview' | 'remove' | 'restore' | 'managerEdit' | 'ownerEdit' | 'ownerRemove'
  | 'addDifference' | 'withdraw' | 'closeKeep' | 'addRule';

/** Nút trên Chi tiết bài học; enabled=false thì khoá kèm câu lockedKey (contracts/errors.json) với params. */
export interface Action { code: ActionCode; enabled: boolean; lockedKey?: string; params?: Record<string, string> }

export interface LessonDetail {
  lesson: LedgerRow;
  item: ItemRef;
  applied: AppliedItem[];
  links: LinkView[];
  related: RelatedLesson[];
  rule?: CreatedRule;
  removal?: Removal;
  history: HistoryEntry[];
  actions: Action[];
  mine: boolean;
}

export interface ActionResult { lesson: LedgerRow; noticeKey?: string }
export interface BulkResult { done: number; skipped: number }

export interface RemoveInput { id: string; seenVer: number; reason: string }
export interface LessonEdit { id: string; seenVer: number; after: string; reason: string; note?: string; scope: LessonScope }
export interface CloseKeepInput { keepId: string; otherId: string; seenVer: number }
export type RulePrefillInput = LessonInput;
export interface LinkRuleInput { lessonId: string; seenVer: number; link: LessonLink }

export type PairSource = 'auto' | 'manual';
export interface PairRow {
  id: string;
  codeA: string;
  codeB: string;
  count: number;
  lastAt?: number;
  note?: string;
  on: boolean;
  source: PairSource;
  /** Quyết định mới nhất của cặp: gửi lại làm seenEventId (E-007). */
  eventId?: string;
  new?: boolean;
}
export interface Threshold { count: number; days: number; eventId?: string }
export interface PairsView { rows: PairRow[]; threshold: Threshold; canManage: boolean; hasTariff: boolean }
export interface PairInput { codeA: string; codeB: string; note?: string; confirmOutside?: boolean }
export interface SetPairInput { codeA: string; codeB: string; on: boolean; note?: string; seenEventId?: string }
export interface ThresholdInput { count: number; days: number; seenEventId?: string }

export interface ReasonRow { code: string; label: string; builtin: boolean; hidden: boolean; used: boolean; canHide: boolean }

export interface ManagerBadges { unreviewed: number; newPairs: number; unchecked: number }
export type StaffBadgeKind = 'removed' | 'contradiction' | 'linkClosed' | 'restored';
export interface StaffBadge { kind: StaffBadgeKind; key: string; lessonId: string; no?: number; other?: number; at: number }
export interface Badges { manager?: ManagerBadges; staff: StaffBadge[]; total: number }
export interface Reminder { count: number; showBanner: boolean }

/**
 * API Sổ dạy AI: mỗi hàm gọi đúng một hàm exported cùng tên của lessons.Service (Go). Lỗi dạng "code: k=v,..."
 * (teach_stale: name=..,act=..,at=.. | teach_perm_lost: perm=.. | teach_restore_blocked: m=..).
 */
export interface TeachApi {
  list(filter: LedgerFilter): Promise<LedgerPage>;
  detail(id: string): Promise<LessonDetail>;
  review(id: string, seenVer: number): Promise<ActionResult>;
  unreview(id: string, seenVer: number): Promise<ActionResult>;
  bulkReview(filter: LedgerFilter, seenTotal: number): Promise<BulkResult>;
  remove(input: RemoveInput): Promise<ActionResult>;
  restore(id: string, seenVer: number): Promise<ActionResult>;
  managerEdit(input: LessonEdit): Promise<ActionResult>;
  ownerEdit(input: LessonEdit): Promise<ActionResult>;
  ownerRemove(input: RemoveInput): Promise<ActionResult>;
  addDifference(id: string, seenVer: number, text: string): Promise<ActionResult>;
  withdraw(id: string, seenVer: number): Promise<ActionResult>;
  closeKeep(input: CloseKeepInput): Promise<ActionResult>;
  rulePrefill(id: string): Promise<RulePrefillInput>;
  linkRule(input: LinkRuleInput): Promise<ActionResult>;
  pairs(): Promise<PairsView>;
  seenPairs(): Promise<void>;
  setPair(input: SetPairInput): Promise<PairsView>;
  addPair(input: PairInput): Promise<PairsView>;
  setThreshold(input: ThresholdInput): Promise<PairsView>;
  allReasons(): Promise<ReasonRow[]>;
  addReason(label: string): Promise<ReasonRow[]>;
  hideReason(code: string, hidden: boolean): Promise<ReasonRow[]>;
  badges(): Promise<Badges>;
  seen(lessonId: string): Promise<Badges>;
  reminder(): Promise<Reminder>;
  dismissBanner(): Promise<Reminder>;
}
