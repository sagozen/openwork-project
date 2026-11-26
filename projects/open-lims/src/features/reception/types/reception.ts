import type { StatusValue, Tone } from "@/lib/api";

export interface PersonRef {
  id: string;
  fullName: string;
  unit?: string;
}

/** UserRefResponse.of(id) - id luôn có, fullName chưa được enrich cho mọi field nên optional
 *  (khác PersonRef, vốn hứa fullName luôn có giá trị). */
export interface HandoverPersonRef {
  id: string;
  fullName?: string;
  unit?: string;
}

export interface TestParameter {
  code: string;
  name: string;
}

export interface ReceptionWorklistItem {
  /** Hàng chờ trả cả hồ sơ còn DRAFT, mà DRAFT thì chưa có mã (BR-003) - `ReceptionQueueItemResponse`
   *  bỏ hẳn khoá này thay vì gửi null. Mọi thao tác tiếp nhận đều định danh bằng mã, nên dòng
   *  không mã không thao tác được. */
  requestCode?: string;
  /** Number of parent samples in this dossier; queue pagination counts dossiers, not samples. */
  sampleCount: number;
  productName: string;
  /** `Integer declaredQuantity` bên `ReceptionQueueItemResponse`: hồ sơ không khai số mẫu dự kiến
   *  thì khoá này vắng mặt. Hiển thị phải bỏ qua, không được in ra "undefined". */
  declaredQuantity?: number;
  /** ReceptionQueueItemResponse (backend) trả từ join sang lượt lấy mẫu (sampling) gần nhất;
   *  vẫn absent trước khi có lượt lấy mẫu nào được ghi nhận. Optional để FE không giả định luôn
   *  có giá trị. */
  quantityUnit?: string;
  customer?: { id: string; name: string };
  containerNo?: string;
  sealNo?: string;
  arrivedAt?: string;
  /** Populated từ bước bàn giao DELIVER gần nhất (ops.handover); absent trước khi có bàn giao
   *  nào. `fullName` trên mỗi bên có thể null - chưa enrich hàng loạt để tránh N+1 trên danh
   *  sách phân trang (tới 200 dòng/trang). */
  handover?: { fromUser?: HandoverPersonRef; toUser?: HandoverPersonRef };
  /** Trạng thái của MẪU vật lý (`ops.sample`). */
  status: StatusValue;
  /** Trạng thái hồ sơ tổng hợp: RECEIVED khi đã nhận đủ mẫu tại một cửa;
   *  khác trạng thái của từng mẫu và mốc IN_TESTING khi lab nhận bàn giao. */
  requestStatus?: StatusValue;
  paymentStatus?: StatusValue;
  testParameters: TestParameter[];
  allowedActions: string[];
}

export interface ReceptionSummaryItem {
  key: string;
  label: string;
  value: number;
  tone: Tone;
}

export interface ReceptionWorklist {
  content: ReceptionWorklistItem[];
  page: { number: number; size: number; totalElements: number; totalPages: number };
  summary: ReceptionSummaryItem[];
}

export interface ReceptionFilters {
  page?: number;
  size?: number;
  sort?: string;
  q?: string;
  status?: string[];
  branchId?: string;
  fromDate?: string;
  toDate?: string;
}

export interface ReceptionChecklistItem {
  key: string;
  name: string;
  rule: string;
  declaredValue?: string;
  actualValue?: string | null;
  verdict?: ChecklistVerdict | null;
  requiresReasonOnMismatch: boolean;
  required?: boolean;
}

export type ChecklistVerdict = "MATCH" | "MISMATCH" | "NOT_APPLICABLE";

export interface ReceptionChangeField {
  field: string;
  oldValue?: string;
  newValue?: string;
}

export interface ReceptionChangeRequest {
  id: string;
  title?: string;
  requestedBy?: PersonRef;
  requestedAt?: string;
  reason: string;
  fields: ReceptionChangeField[];
  status?: StatusValue;
}

export interface ReceptionDetail {
  requestCode: string;
  /** Mã mẫu cha của hồ sơ. Đây là chỗ DUY NHẤT đi từ mã hồ sơ sang mã mẫu: hồ sơ chi tiết
   *  (`TestRequestDetailResponse`) không mang mã này, và `GET /analysis-tasks` chỉ lọc theo
   *  `parentSampleCode` chứ không theo mã hồ sơ. Absent khi hồ sơ chưa tiếp nhận mẫu - phản hồi
   *  là `NON_NULL` nên khoá rụng hẳn khỏi payload. Absent nghĩa là «chưa tới bước đó», KHÔNG
   *  phải «tải lỗi». */
  sampleCode?: string;
  /** Mã lượt lấy mẫu của hồ sơ, cùng vai trò và cùng luật absent như `sampleCode`:
   *  `GET /sampling-assignments` chỉ lọc theo ngày và trạng thái nên không có đường nào khác đi
   *  từ mã hồ sơ sang lượt lấy mẫu. Absent khi hồ sơ chưa được phân công lấy mẫu. */
  assignmentCode?: string;
  status: StatusValue;
  traceability: {
    productName?: string;
    growingAreaCode?: string;
    packingHouseCode?: string;
    vehiclePlate?: string;
    containerNo?: string;
    trailerNo?: string;
    sealNo?: string;
  };
  formRevisions: Array<{
    formCode: string;
    revision: string;
    effectiveDate?: string;
    documentId?: string;
  }>;
  checklist: ReceptionChecklistItem[];
  changeRequests?: ReceptionChangeRequest[];
  /** Quyết định đã ghi cho hồ sơ này, đọc ngược lại (`RecordedDecisionResponse`). Absent khi
   *  chưa quyết định lần nào. Trước đây `GET .../reception` dừng ở checklist nên lý do và ghi
   *  chú người tiếp nhận viết ra biến mất ngay khi tải lại màn. */
  decision?: {
    actualQuantity?: number;
    sealIntact?: boolean;
    reason?: string;
    note?: string;
    decidedBy?: HandoverPersonRef;
    decidedAt?: string;
  };
}

export interface ReceptionChecklistInput {
  key: string;
  actualValue: string;
}

export interface RecordReceptionInput {
  sampleCode?: string;
  decision: "ACCEPT" | "HOLD" | "REJECT";
  actualQuantity?: number;
  sealIntact?: boolean;
  checklist?: ReceptionChecklistInput[];
  reason?: string;
  note?: string;
  attachmentIds?: string[];
}

export interface RecordReceptionResult {
  requestCode: string;
  sample?: {
    code: string;
    level: "PARENT";
    actualQuantity?: number;
    status: StatusValue;
    receivedBy?: PersonRef;
    receivedAt?: string;
  };
  subSamples: [];
  analysisTasks: [];
}

export interface SplitSampleInput {
  subSampleCount: number;
  reason?: string;
}

export interface SplitSampleResult {
  parentCode: string;
  subSamples: Array<{ code: string; index: number }>;
  analysisTasks: Array<{
    code: string;
    subSampleCode: string;
    parameterCode: string;
  }>;
  quantityMismatch: boolean;
  notifiedUserIds: string[];
}

/** `SampleDetailResponse` (`GET /samples/{code}`). Cùng hình dạng mẫu con + task với
 *  `SplitSampleResult`, nhưng đọc lại được sau khi tải lại trang - kết quả của lệnh chia mã chỉ
 *  sống trong phiên, nên tem mẫu con phải dựng từ đây thì mới in lại được. */
export interface SampleDetail {
  code: string;
  level: "PARENT" | "SUB";
  status: StatusValue;
  actualQuantity?: number;
  subSamples: Array<{ code: string; index: number }>;
  analysisTasks: Array<{
    code: string;
    subSampleCode: string;
    parameterCode: string;
  }>;
}

/** `GET /test-requests/{code}/handover-context` — legal scans and next step for S-09. */
export interface HandoverContextResponse {
  requestCode: string;
  requestStatus?: string;
  payment?: StatusValue;
  parentSampleCode?: string;
  sampleStatus?: StatusValue;
  declaredQuantity?: number;
  actualQuantity?: number;
  subSamples: Array<{ code: string; index: number }>;
  parameters?: TestParameter[];
  nextStep: { code: string; name: string };
  scanCodes: string[];
  allowed: boolean;
  blockedReason?: string;
}

/** @deprecated Use {@link HandoverContextResponse}; retained for callers compiled against the
 * previous frontend name while the server resolver contract rolls out. */
export type HandoverContext = HandoverContextResponse;

export type LabelType = "PARENT_SAMPLE" | "SUB_SAMPLE" | "ANALYSIS_TASK";
export type PrintJobStatusCode =
  "REQUESTED" | "SENT" | "CONFIRMED" | "FAILED" | "CANCELLED" | "UNKNOWN";

export interface PrintJob {
  id: string;
  labelType: LabelType;
  codes: string[];
  sampleTypeMark?: string;
  qrToken?: string;
  templateVersion?: string;
  printerProfileId?: string;
  copies: number;
  status: StatusValue & { code: PrintJobStatusCode };
  failureReason?: string;
  retryCount?: number;
  createdAt?: string;
}

export interface CreatePrintJobInput {
  labelType: LabelType;
  copies: number;
  printerProfileId?: string;
}

export interface RetryPrintJobInput {
  copies: number;
  reason?: string;
}

/** `HandoverResource.CounterpartResponse` (`GET /handovers/counterparts`) - người trong chi nhánh
 *  của người đang thao tác, để ô «người giao/nhận đối ứng» chọn theo tên thay vì gõ số id. */
export interface HandoverCounterpart {
  id: string;
  fullName: string;
  jobTitle?: string;
}
