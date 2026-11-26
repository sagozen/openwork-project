import type { StatusValue, Tone } from "@/lib/api";

export type LabScope = "unassigned" | "mine" | "all";
export type TestPartCode = "SKIN" | "FLESH" | "WHOLE";
export type ResultValueType = "NUMERIC" | "BELOW_LOD" | "BELOW_LOQ";

/**
 * `AnalysisTaskResource.UserRefResponse` now carries `id` + `fullName` (resolved server-side for
 * assignee/enteredBy/uploadedBy/chosenBy). `fullName` stays optional because the resource omits
 * the key (`@JsonInclude(NON_NULL)`) when the id directory can't resolve a name in scope - every
 * render site falls back to `.id` for that edge case.
 */
export interface LabUserRef {
  id: string;
  fullName?: string;
}
export interface LabNamedCode {
  code: string;
  name: string;
}
/** Tên tiếng Việt của phần thử, lấy đúng từ vựng backend đang dùng (`review.domain.TestPart`):
 *  API lab trả `testPart` là mã trần nên nhãn phải tra ở FE. */
export const TEST_PART_NAMES: Record<TestPartCode, string> = {
  SKIN: "Vỏ",
  FLESH: "Thịt quả",
  WHOLE: "Nguyên trái",
};

/** Tên tiếng Việt của loại trị số. API lab trả `valueType` là mã trần (`BELOW_LOD`) nên nhãn tra
 *  ở FE, cùng cách với {@link TEST_PART_NAMES}. Trước đây nhãn chỉ tồn tại bên trong các thẻ
 *  `<Option>` của ô chọn, nên ô chọn khi đóng lại và cột trong bảng đều in ra mã máy. */
export const VALUE_TYPE_NAMES: Record<ResultValueType, string> = {
  NUMERIC: "Số",
  BELOW_LOD: "Không phát hiện (KPH)",
  BELOW_LOQ: "Dưới LOQ",
};

/** `AnalysisTaskSummaryResponse` (`GET /analysis-tasks` content[]). No `testPart`, `matrix`, or
 * `method` - a task pairs one sub-sample with one chỉ tiêu; part only exists per result set, and
 * matrix is not tracked by `LabParameterCatalog` at all (Cần backend bổ sung nếu cần cột này). */
export interface AnalysisTask {
  code: string;
  /** Request identity is supplied by the queue API; never reconstruct it from a sample/task code. */
  requestCode?: string;
  sampleCode?: string;
  subSampleCode: string;
  parentSampleCode: string;
  /** Latest lab RECEIVE handover timestamp for this sample, not its intake or assignment time. */
  receivedAt?: string;
  parameter: LabNamedCode;
  assignee: LabUserRef | null;
  status: StatusValue;
  /** Server-selected next action. Older servers may omit it, in which case the UI maps status. */
  displayAction?: string;
  allowedActions: string[];
}

export interface ServerPageMeta {
  number: number;
  size: number;
  totalElements: number;
  totalPages: number;
}
/** Một thẻ số liệu đầu màn S-14 (`SummaryEntryResponse`), đếm trên TOÀN phạm vi lab chứ không
 * phải trang đang xem - nên `value` không cộng lại thành `page.totalElements` của một bộ lọc hẹp. */
export interface LabStatusCount {
  key: string;
  label: string;
  value: number;
  tone: Tone;
}

/** Phân bố task theo chỉ tiêu (`ParameterCountResponse`), cùng phạm vi với `summary`. */
export interface LabParameterCount {
  code: string;
  name: string;
  count: number;
}

/** `AnalysisTaskListResponse`. `parentSamples` vẫn chưa có (Cần backend bổ sung); `summary` và
 * `byParameter` thì `ListAnalysisTasksService` đã dựng thật - optional vì bản server cũ hơn
 * không trả chúng, không phải vì chúng là dữ liệu giả. */
export interface AnalysisTaskList {
  content: AnalysisTask[];
  page: ServerPageMeta;
  summary?: LabStatusCount[];
  byParameter?: LabParameterCount[];
}
export interface AnalysisTaskFilters {
  /** Paginate complete sample groups rather than individual parameter tasks. */
  groupBy?: "sample";
  page?: number;
  size?: number;
  scope?: LabScope;
  parameterCode?: string[];
  status?: string[];
  assigneeId?: string;
  sampleCode?: string;
  parentSampleCode?: string;
}

/** `RawResultResponse`. `value`/`valueType` are absent - not present at all - when the caller
 * lacks `lab.result.value.view` (BR-027); both stay optional here to mirror that omission. */
export interface RawResult {
  id: string;
  subSampleCode: string;
  measuredAt: string;
  sampleMass: number;
  massUnit: string;
  value?: string;
  valueType?: ResultValueType;
  comment?: string;
  enteredBy: LabUserRef;
}
/** `FinalResultResponse`. Field names follow the wire shape (`chosenBy`/`chosenAt`, not
 * `selectedBy`/`selectedAt`). `value`/`valueType` are present in `GET /{code}`'s
 * `resultSets[].finalResult` only when BR-027 allows it, and are never present on the
 * `PUT /final-result` response itself (the resource always nulls them there). */
export interface FinalResult {
  /** Nullable vì object `finalResult` có thể tồn tại với mọi field null khi bộ chưa chốt; đọc
   *  trạng thái chốt qua `hasFinalResult` thay vì kiểm tra bản thân `finalResult`. */
  rawResultId: string | null;
  value?: string;
  valueType?: ResultValueType;
  comment?: string;
  chosenBy: LabUserRef;
  chosenAt: string;
}
export interface ResultSet {
  /** `ResultSetResponse.testPart` là `String` (mã enum trần: SKIN/FLESH/WHOLE), không phải object
   *  có `name` - FE từng khai nhầm là object nên tab phần thử hiện "/ · chưa chốt" và không chọn
   *  được phần nào. */
  testPart: TestPartCode;
  rawResults: RawResult[];
  finalResult: FinalResult | null;
}
/** Một bộ chỉ được coi là đã chốt khi `finalResult` trỏ tới một kết quả gốc có thật. Không dùng
 *  `!!set.finalResult`: `FinalResultResponse` vẫn có thể về dưới dạng object rỗng (mọi field null,
 *  gồm cả `rawResultId`) khi chưa ai chọn, nên phép kiểm truthy đếm nhầm bộ chưa chốt là đã chốt -
 *  đúng lỗi "Kết quả cuối 2/2" và tab hiện "đã chốt" ngay lúc mới mở task. */
export function hasFinalResult(set: ResultSet): boolean {
  return Boolean(set.finalResult?.rawResultId);
}
/** BR-008: mỗi **mẫu con** nhận từ 1 đến 5 kết quả gốc cho mỗi thành phần thử, mỗi phiên. Năm chỗ
 *  đó là năm **lần đo lặp** - chạy máy lại trên chính mẫu con này cũng tính, không bắt buộc phải
 *  chia thêm mẫu con.
 *
 *  Trần này thuộc phạm vi MẪU CON, không phải phạm vi bộ: task anh em có năm chỗ riêng của nó, vì
 *  số mẫu con của một bộ do khâu tiếp nhận chốt lúc chia mẫu, không phải do người đứng máy quyết.
 *  Đếm cả bộ (cách làm trước V26) khiến năm lần lặp của một mẫu con chiếm hết chỗ của các mẫu con
 *  còn lại. */
export const MAX_RAW_RESULTS_PER_TASK = 5;

/** Các kết quả gốc mà **mẫu con của task đang mở** đã ghi cho bộ này. `resultSets[].rawResults` là
 *  dữ liệu của CẢ bộ (gồm cả mẫu con anh em), nên trần của người đang đứng ở màn này phải lọc lại
 *  theo mẫu con thay vì đếm thẳng độ dài mảng. */
export function ownRawResults(set: ResultSet, subSampleCode: string): RawResult[] {
  return set.rawResults.filter((raw) => raw.subSampleCode === subSampleCode);
}

/** Số chỗ còn lại cho mẫu con của task đang mở, ở bộ này. */
export function remainingCapacity(set: ResultSet, subSampleCode: string): number {
  return Math.max(0, MAX_RAW_RESULTS_PER_TASK - ownRawResults(set, subSampleCode).length);
}

export interface TechnicalFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: LabUserRef;
  uploadedAt: string;
}
/** `ReturnedFeedbackResponse` - present only when the task has been through at least one review
 * return (`GET /{code}` omits the key otherwise, `@JsonInclude(NON_NULL)`). */
export interface ReturnedFeedback {
  version: number;
  comment: string;
  returnedAt: string;
}
/** `AnalysisTaskDetailResponse` (`GET /analysis-tasks/{code}`). `returnedFeedback` is optional -
 * absent until the task has been returned at least once. */
export interface AnalysisTaskDetail extends AnalysisTask {
  unit: string;
  method: string;
  lod?: number;
  loq?: number;
  splitsByPart: boolean;
  requiresTechnicalFile: boolean;
  locked: boolean;
  resultSets: ResultSet[];
  technicalFiles: TechnicalFile[];
  /** Những gì `submit-review` sẽ từ chối task này ngay lúc này, đúng câu chữ của lời từ chối;
   *  rỗng nghĩa là gửi được. Phải hiển thị: một phần trong đó (kết quả gốc của chính mẫu con này)
   *  không suy ra được từ `resultSets`, vốn là dữ liệu của cả bộ gồm cả mẫu con anh em. */
  submitBlockers: string[];
  returnedFeedback?: ReturnedFeedback;
}

/** `TaskActionResponse` - the shared shape `claim`/`start`/`submit-review` all return. Not the
 * full task: no `parameter`, `parentSampleCode`, `allowedActions`. */
export interface TaskActionResult {
  code: string;
  status: StatusValue;
  assignee: LabUserRef | null;
  startedAt?: string;
}

/** `EligibleAssigneeResponse` (`GET /analysis-tasks/{code}/eligible-assignees`) - real users
 * holding `lab.task.work` at the task's own branch, mirroring sampling's `SamplerResponse`. */
export interface EligibleAssignee {
  id: string;
  fullName: string;
  branch: { id: string; name: string };
  activeTaskCount: number;
  available: boolean;
}
export interface AssignTasksInput {
  taskCodes: string[];
  assigneeId: string;
  reason?: string;
}
export interface AssignTasksResponse {
  results: Array<{
    taskCode: string;
    outcome: "ASSIGNED" | "FAILED";
    code?: string;
    message?: string;
  }>;
}
export interface CreateRawResultInput {
  testPart: TestPartCode;
  subSampleCode: string;
  measuredAt: string;
  sampleMass: number;
  massUnit: string;
  valueType: ResultValueType;
  value: string;
  comment?: string;
}
/** `EnterRawResultResponse` (`201` of `POST /raw-results`) - carries only the write's own
 * identity plus the task's post-write status, not the measurement fields just submitted. */
export interface CreateRawResultResponse {
  id: string;
  testPart: TestPartCode;
  subSampleCode: string;
  enteredBy: LabUserRef;
  enteredAt: string;
  task: { code: string; status: StatusValue };
}
export interface SelectFinalResultInput {
  testPart: TestPartCode;
  rawResultId: string;
  comment?: string;
}
export interface RegisterTechnicalFileInput {
  documentId: string;
}
