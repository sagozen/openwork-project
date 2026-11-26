import type { StatusValue } from "@/lib/api";

export const reconciliationFields = [
  "productName",
  "growingAreaCode",
  "packingHouseCode",
  "vehiclePlate",
  "containerNo",
  "trailerNo",
  "sealNo",
] as const;
export type ReconciliationField = (typeof reconciliationFields)[number];
export type Verdict = "MATCH" | "MISMATCH";

/** `null` cho trường hồ sơ không khai (số rơ-moóc, số seal là hai trường tuỳ chọn của BM01) -
 *  `SamplingAssignmentDetailResponse` gửi thẳng `null` chứ không bỏ khoá. */
export type Declaration = Record<ReconciliationField, string | null>;
export interface Parameter {
  code: string;
  name: string;
}
export interface SamplingSample {
  sampleCode: string;
  sampleIndex: number;
  expectedQuantity: number | null;
  quantityUnit: string | null;
  declaration: Declaration;
  testParameters: Parameter[];
}
export interface SamplingAssignment {
  samples: SamplingSample[];
  assignmentCode: string;
  requestCode: string;
  productName: string;
  testParameters: Parameter[];
  location: string;
  scheduledTime: string;
  status: StatusValue;
  declaration: Declaration;
  /** `expectedSampleCount` của hồ sơ là trường tuỳ chọn ở BM01 (`api-map.md`: "Số quả dự kiến;
   *  số thực lấy ghi ở BM03"), hồ sơ không khai thì API trả `null`. */
  expectedQuantity: number | null;
  /** `SamplingAssignmentResource` ghi rõ "quantityUnit is intentionally still null": `ops.test_request`
   *  chưa có đơn vị tính riêng cho từng hồ sơ. */
  quantityUnit: string | null;
  allowedActions: string[];
}
export interface ReconciliationItem {
  sampleCode?: string;
  field: ReconciliationField;
  /** Tên trường để hiển thị, do máy chủ đặt (`ReconciliationItemResponse.fieldName`). Chỉ có ở
   *  chiều ĐỌC - kiểu này dùng chung cho cả `ReconciliationInput.items` khi ghi, và chiều ghi
   *  không gửi khoá này. Để FE tự đặt tên trường khi vắng, đừng in ra chuỗi rỗng. */
  fieldName?: string;
  actualValue: string;
  verdict: Verdict;
}
export interface ChangeField {
  sampleCode?: string;
  field: ReconciliationField;
  fieldName?: string;
  oldValue: string;
  newValue: string;
  decision?: "APPROVE" | "REJECT" | null;
}
export interface FieldChangeRequest {
  id: string;
  // Backend id nội bộ của lượt (SamplingAssignment.id), KHÔNG phải assignmentCode dùng trên URL.
  assignmentId: string;
  // Mã lượt lấy mẫu dễ đọc (vd. 26100012), dùng để hiển thị - resolve từ assignmentId.
  assignmentCode: string;
  requestedBy: { id: string; fullName: string };
  requestedAt: string;
  reason: string;
  fields: ChangeField[];
  attachmentIds: string[];
  status: StatusValue;
}
export interface SamplingAssignmentDetail extends SamplingAssignment {
  reconciliation?: {
    items: ReconciliationItem[];
    conclusion: "CONFORMED" | "NOT_CONFORMED";
    reason?: string;
  };
  pendingChangeRequest?: FieldChangeRequest | null;
  bm03?: Bm03Snapshot;
  bm02?: Bm02Snapshot;
}
/** BM03 đã chốt, đọc lại từ `Bm03Response`. Khai đủ khoá mà máy chủ thật sự gửi - bản trước chỉ
 *  khai `bm03Id`/`sampleLines` nên mã biểu mẫu, revision và ngày hiệu lực (BR-023) tuy có trong
 *  phản hồi vẫn không dùng được ở FE. */
export interface Bm03Snapshot {
  bm03Id: string;
  formCode: string;
  formRevision: string;
  formEffectiveDate: string;
  sampleLines: Bm03SampleLine[];
  /** Bảy trường truy xuất chụp lại lúc dán tem, khoá theo tên trường của BM01. */
  traceabilitySnapshot: Record<string, string>;
  sealPhotoDocumentIds: string[];
  samplerSignatureMethod: "CANVAS" | "PAPER_SCAN";
  samplerSignatureDocumentId: string;
  status: StatusValue;
}
/** BM02 đã chốt, đọc lại từ `Bm02Response`.
 *
 *  Lưu ý phạm vi: `Bm02LineResponse` chỉ trả `index`/`sampleName`/`quantity`/`quantityUnit`/
 *  `parameterCodes`. Các cột mã vùng trồng, mã CSĐG, mã container, biển số, số rơ-moóc và phương
 *  pháp lấy mẫu mà URD 8.1 khối 5 liệt kê **được nhận vào** ở `Bm02Input` nhưng **không được trả
 *  ra** - nên không khai ở đây. Khai rồi để rỗng sẽ biến khoảng trống của hợp đồng API thành thứ
 *  trông như dữ liệu thiếu. */
export interface Bm02Snapshot {
  bm02Id: string;
  formCode: string;
  formRevision: string;
  formEffectiveDate: string;
  sampleLines: Bm02ResultLine[];
  startedAt: string;
  finishedAt: string;
  samplerSignatureMethod: "CANVAS" | "PAPER_SCAN";
  samplerSignatureDocumentId: string;
  customerSignatureMethod: "CANVAS" | "PAPER_SCAN";
  customerSignatureDocumentId: string;
  customerSignerName: string;
  scenePhotoDocumentIds: string[];
  status: StatusValue;
  requestStatus: string;
}
export interface ServerPage<T> {
  content: T[];
  page: { number: number; size: number; totalElements: number; totalPages: number };
}
export interface Sampler {
  id: string;
  fullName: string;
  branch: { id: string; name: string };
  assignedCount: number;
  completedCount: number;
  available: boolean;
}
export interface AssignmentInput {
  samplerId: string;
  scheduledDate: string;
  scheduledTime: string;
  location: string;
  note?: string;
}
export interface OpenInput {
  openedAt: string;
  location?: { lat: number; lng: number };
}
export interface ReconciliationInput {
  items: ReconciliationItem[];
  conclusion: "CONFORMED" | "NOT_CONFORMED";
  reason?: string;
  attachmentIds?: string[];
}
export interface ChangeRequestInput {
  fields: Array<{
    sampleCode?: string;
    field: ReconciliationField;
    oldValue: string;
    newValue: string;
  }>;
  reason: string;
  attachmentIds: string[];
}
export interface SignatureReference {
  method: "CANVAS" | "PAPER_SCAN";
  imageDocumentId: string;
  signerName?: string;
}
export interface Bm03SampleLine {
  sampleCode?: string;
  index: number;
  parameterCode: string | null;
  quantity: number;
  quantityUnit: string | null;
  retained: boolean;
}
export interface Bm03Input {
  samplingCriteria: { representative: boolean; sealedOnSite: boolean; preserved: boolean };
  sampleLines: Bm03SampleLine[];
  sealPhotoIds: string[];
  samplerSignature: SignatureReference;
  note?: string;
}
/** Các trường lấy từ khai báo BM01 của hồ sơ nên nhận `null` đúng như hồ sơ để trống - backend
 *  `Bm02LineBody` khai chúng là `String` nullable và không kiểm bắt buộc từng dòng. */
export interface Bm02SampleLine {
  sampleCode?: string;
  index: number;
  sampleName: string;
  growingAreaCode: string | null;
  packingHouseCode: string | null;
  containerNo: string | null;
  vehiclePlate: string | null;
  trailerNo: string | null;
  quantity: number;
  quantityUnit: string | null;
  parameterCodes: string[];
}
export interface Bm02Input {
  startedAt: string;
  finishedAt: string;
  samplingMethod: string;
  sampleLines: Bm02SampleLine[];
  samplerSignature: SignatureReference;
  customerSignature: SignatureReference;
  sceneePhotoIds?: string[];
  location?: { lat: number; lng: number };
}
export interface ApprovalInput {
  decisions: Array<{
    sampleCode?: string;
    field: ReconciliationField;
    decision: "APPROVE" | "REJECT";
    reason?: string;
  }>;
  note?: string;
}
export interface ReconciliationResult {
  conclusion: "CONFORMED" | "NOT_CONFORMED";
  mismatchedFields: ReconciliationField[];
  status: StatusValue | null;
  nextActions: string[];
}
export interface Bm03Result {
  bm03Id: string;
  formCode: string;
  formRevision: string;
  formEffectiveDate: string;
  sampleLines: Bm03SampleLine[];
  traceabilitySnapshot: Record<string, string>;
  status: StatusValue;
}
export interface Bm02ResultLine {
  sampleCode?: string;
  index: number;
  sampleName: string;
  quantity: number;
  quantityUnit: string;
  parameterCodes: string[];
}
export interface Bm02Result {
  bm02Id: string;
  formCode: string;
  formRevision: string;
  formEffectiveDate: string;
  sampleLines: Bm02ResultLine[];
  status: StatusValue;
  requestStatus: string;
}
