import type { StatusValue } from "@/lib/api";

export interface NamedReference {
  id: string;
  name: string;
}
export interface BranchReference extends NamedReference {
  code: string;
}
/** `UserRefResponse.of(id)` (TestRequestResource) chỉ chắc chắn có `id`; `fullName` chưa được
 *  enrich cho mọi hồ sơ nên là tuỳ chọn - hiển thị phải lùi về `id` thay vì in `undefined`. */
export interface UserReference {
  id: string;
  fullName?: string;
}
export interface RequestTag {
  code: string;
  name: string;
  tone: StatusValue["tone"];
}

export interface RequestListItem {
  id: string;
  // Absent for a DRAFT row: BR-003 only mints a code once a request leaves DRAFT
  // (`TestRequestSummaryResponse` omits the key entirely rather than sending `null`). A row
  // with no `code` links through `id` to `draftRequest()` instead of the usual detail route.
  code?: string;
  status: StatusValue;
  customer?: NamedReference;
  // Multi-sample request (CR-20260831-001): tên mẫu ĐẦU TIÊN trong `samples[]`, không phải tên
  // hồ sơ. Kết hợp với `sampleCount` để hiển thị "Thanh long +2" - client KHÔNG tự đoán số mẫu
  // từ chuỗi này (api-map.md).
  product: string;
  // Số phần tử `samples[]` của hồ sơ - thay cho `expectedSampleCount` cũ đã bỏ khỏi hợp đồng.
  sampleCount: number;
  // Hợp (union) chỉ tiêu của MỌI mẫu trong hồ sơ - server đã tính sẵn, không phải bộ chỉ tiêu của
  // riêng mẫu đầu tiên.
  parameterCodes: string[];
  payment: StatusValue;
  handler?: UserReference;
  receptionBranch: BranchReference;
  tags: RequestTag[];
  createdAt: string;
}

export interface RequestListResponse {
  data: RequestListItem[];
  page: { number: number; size: number; total: number };
  summary: {
    awaitingSampling: number;
    pendingLab: number;
    awaitingApproval: number;
    paymentOverdue: number;
  };
}

export interface RequestListFilters {
  page?: number;
  size?: number;
  sort?: string;
  q?: string;
  status?: string[];
  paymentStatus?: string[];
  tag?: string[];
  tagMode?: "any" | "all" | "none";
  branchId?: string;
  fromDate?: string;
  toDate?: string;
}

/** Một lựa chọn của bộ lọc: cùng bộ ba code/name/tone mà chính các dòng hồ sơ dùng, nên chip lọc
 *  và badge trên bảng không bao giờ nói hai kiểu khác nhau về cùng một trạng thái. */
export interface FilterOption {
  code: string;
  name: string;
  tone: string;
}

/** Một nhãn trong danh mục (`GET /request-tags`), kèm số hồ sơ đang mang nó TRONG PHẠM VI của
 *  người gọi - không phải số của trang đang xem. */
export interface RequestTagCatalogEntry {
  code: string;
  name: string;
  groupName: string;
  tone: string;
  scope: string;
  usageCount: number;
}

export interface RequestTagCatalog {
  tags: RequestTagCatalogEntry[];
}

/** Đáp của `POST`/`DELETE /test-requests/{code}/tags/{tagCode}`: nguyên bộ nhãn sau thay đổi. */
export interface RequestTagList {
  tags: RequestTag[];
}

/** Đáp của `GET /test-requests/filter-options`. */
export interface RequestFilterOptions {
  statuses: FilterOption[];
  paymentStatuses: FilterOption[];
}

export interface CustomerSummary {
  id: string;
  name: string;
  taxCode?: string;
}
export interface CustomerDetail extends CustomerSummary {
  representative?: string;
  phone?: string;
  email?: string;
  address?: string;
}
export interface CustomerSearchResponse {
  data: CustomerDetail[];
}
export interface CreateCustomerInput {
  name: string;
  taxCode?: string;
  address?: string;
  representative?: string;
  phone?: string;
  email?: string;
}

/** `ParameterResponse.from(parameterCodes)` (TestRequestResource) dựng `new ParameterResponse(code,
 *  null, null)`: chỉ mã chỉ tiêu là chắc chắn có. Chưa có `GET /parameters` để tra tên nên UI hiển
 *  thị mã khi thiếu tên, không tự chế tên. */
export interface RequestParameter {
  code: string;
  name?: string;
  method?: string;
}
// `PaymentResponse` (TestRequestResource.java) projects the whole `ops.payment_record` row, not
// just the badge: số tiền, ghi chú, ai xác nhận lúc nào, và chứng từ - đó là những gì FR-PAY-003
// bắt phải lưu, nên cũng là những gì màn hình phải đọc lại được. Mọi trường dưới đây là read-only
// (`@JsonInclude(NON_NULL)`: hồ sơ chưa xác nhận thì server bỏ hẳn key, không trả null).
// `confirmedBy`/`exceptionGrantedBy` là mã người dùng, không phải tên - server cố ý không join
// `ops.app_user` trên mọi truy vấn có chiếu thanh toán.
export interface PaymentStatus extends StatusValue {
  evidenceDocumentId?: string;
  amount?: number;
  note?: string;
  confirmedBy?: string;
  /** Tên người xác nhận, chỉ có ở màn chi tiết hồ sơ (danh sách và hàng chờ cố ý không join tên).
   *  Không có thì hiển thị phải bỏ trống, KHÔNG in `confirmedBy` ra thay - số id đọc như một câu
   *  trả lời trong khi nó không phải. */
  confirmedByFullName?: string;
  confirmedAt?: string;
  exceptionReason?: string;
  exceptionGrantedBy?: string;
  /** Tên người cấp ngoại lệ, cùng quy tắc với `confirmedByFullName`. */
  exceptionGrantedByFullName?: string;
  exceptionGrantedAt?: string;
}
export interface PaymentActionResponse {
  payment: PaymentStatus;
}

/**
 * Một mẫu trong hồ sơ nhiều mẫu (CR-20260831-001, D46-D48 · `srs-dlp.md` BR-003/BR-021). Field
 * shape mirrors `api-map.md` `samples[]` cho cả ghi (POST/PATCH draft/submit) lẫn đọc
 * (`GET .../{code}`) - ghi gửi `parameterCodes`, đọc trả thêm `parameters[]` đã enrich tên/method
 * cộng các trường chỉ-đọc (`id`/`code`/`sampleIndex`/`status`/`reportCode`).
 *
 * Lưu ý đặt tên: hợp đồng đã chốt (`api-map.md`) dùng field `product` cho tên mẫu, KHÔNG phải
 * `sampleName` - giữ đúng theo hợp đồng để không lệch với backend.
 */
export interface RequestedSample {
  /** Read-only - id nội bộ của Parent Sample. Vắng mặt khi đang soạn payload tạo/sửa. */
  id?: string;
  /** Mã mẫu độc lập {YY}{BRANCH_ID}{SEQ} do hệ thống sinh (BR-003). Vắng mặt tới khi hồ sơ rời `DRAFT`. */
  code?: string;
  /** Mã mẫu khách hàng cung cấp, không bắt buộc; không lấy mã nội bộ khi để trống. */
  customerSampleCode?: string;
  /** Thứ tự khai báo trong hồ sơ, độc lập với dãy sinh mã mẫu (BR-003). */
  sampleIndex?: number;
  /** Read-only - trạng thái RIÊNG của mẫu (FR-REQ-019), khác badge cấp hồ sơ (giá trị suy ra). */
  status?: StatusValue;
  /** Tên sản phẩm / tên mẫu. */
  product?: string;
  growingAreaCode?: string;
  packingHouseCode?: string;
  containerNumber?: string;
  vehiclePlate?: string;
  trailerNumber?: string;
  sealNumber?: string;
  /** Ghi (POST/PATCH draft/submit): mã chỉ tiêu gửi lên. */
  parameterCodes?: string[];
  /** Read-only: chỉ tiêu đã enrich tên/method, trả về ở `GET .../{code}`. */
  parameters?: RequestParameter[];
  /** Read-only: mã phiếu kết quả của MẪU này (D46) - vắng mặt khi mẫu chưa phát hành phiếu. */
  reportCode?: string;
}

export interface TestRequestDetail {
  code: string;
  status: StatusValue;
  customer?: CustomerDetail;
  // Người đại diện và điện thoại liên hệ thuộc về hồ sơ (khai lúc tạo BM01), không phải hồ sơ
  // khách hàng - API trả chúng ở cấp gốc chứ không nằm trong `customer`.
  representative?: string;
  phone?: string;
  samplingLocation?: string;
  // Hồ sơ chứa 1-99 mẫu (CR-20260831-001); bộ trường truy xuất BR-021 và chỉ tiêu thuộc về TỪNG
  // mẫu, không còn ở cấp hồ sơ. `expectedSampleCount` cũ đã bỏ - số mẫu là `samples.length`.
  samples: RequestedSample[];
  resultDeliveryModes: Array<"AT_LAB" | "EMAIL" | "POST">;
  payment: PaymentStatus;
  formTemplate: { code: string; revision: string; effectiveFrom: string };
  receptionBranch: BranchReference;
  fieldGroups: { groupB: string[]; groupC: string[] };
  allowedActions: string[];
  createdBy: UserReference;
  createdAt: string;
}

export interface CreateTestRequestInput {
  customerId?: string;
  representative?: string;
  phone?: string;
  samplingLocation?: string;
  // 1-99 phần tử (api-map.md). Rỗng → `E-REQ-011`; quá 99 → `E-REQ-013`. Bản nháp (`draft: true`)
  // được phép chứa mẫu khai dở, kể cả mảng rỗng - server bỏ qua kiểm trường bắt buộc.
  samples: RequestedSample[];
  resultDeliveryModes?: Array<"AT_LAB" | "EMAIL" | "POST">;
  customerCommitmentAcknowledged?: boolean;
  sourceDocumentId?: string;
  note?: string;
  draft?: boolean;
}
export type CreateTestRequestResponse = Omit<TestRequestDetail, "code"> & { code?: string };

/** `GET /test-requests/drafts/{id}` - a saved draft's BM01 fields, for prefilling the create
 * form to resume and complete it. Shape mirrors `CreateTestRequestInput` (what the resumed form
 * re-submits), not `TestRequestDetail` (which only applies once a request has left DRAFT). Mẫu
 * trong nháp CHƯA có `code`/`sampleIndex` (BR-003 chỉ sinh mã mẫu cha ở bước submit). */
export interface DraftTestRequest {
  id: string;
  customer?: CustomerSummary;
  representative?: string;
  phone?: string;
  samplingLocation?: string;
  samples?: RequestedSample[];
  resultDeliveryModes?: Array<"AT_LAB" | "EMAIL" | "POST">;
  customerCommitmentAcknowledged?: boolean;
  sourceDocumentId?: string;
  createdAt: string;
}
export interface PatchTestRequestInput {
  changes: Record<string, unknown>;
  reason: string;
  evidenceDocumentIds: string[];
}
export interface CancelTestRequestInput {
  reason: string;
  evidenceDocumentIds: string[];
}
export interface ConfirmPaymentInput {
  status: "PENDING_CONFIRMATION" | "PAID";
  amount?: number;
  note?: string;
  evidenceDocumentId?: string;
}
export interface PaymentExceptionInput {
  reason: string;
  amount: number;
  evidenceDocumentIds: string[];
}

export interface CreateHandoverInput {
  requestCode: string;
  step: "DELIVER" | "RECEIVE" | "SPLIT_VIAL";
  scannedCodes: string[];
  scanMethod: "QR" | "MANUAL";
  counterpartUserId?: string;
  note?: string;
}
export interface Handover {
  handoverId: string;
  performedBy: UserReference;
  performedAt: string;
}

/** Một dòng nhật ký giao-nhận (`GET /test-requests/{code}/handovers`, mới nhất trước).
 *
 *  `ops.handover` chỉ ghi thêm, không sửa - V10 nói rõ sửa một lượt quét nhầm là ghi dòng MỚI.
 *  Nghĩa là nhật ký có thể có nhiều dòng cùng bước, và đó là dữ liệu đúng chứ không phải rác:
 *  chỉ khi đọc được nó thì người đứng quầy mới phân biệt được bản ghi sửa lỗi với cú bấm thừa. */
export interface HandoverLogEntry {
  handoverId: string;
  step: { code: "DELIVER" | "RECEIVE" | "SPLIT_VIAL"; name: string };
  scannedCodes: string[];
  scanMethod: { code: "QR" | "MANUAL"; name: string };
  performedBy: UserReference;
  counterpart?: UserReference;
  note?: string;
  performedAt: string;
}

/** Compile-time mapping from the Vietnamese prototype keys to the API contract - trường CẤP HỒ
 *  SƠ (gốc thân yêu cầu). CR-20260831-001 tách thân yêu cầu thành hai lớp; trường cấp mẫu đã
 *  chuyển sang `PROTOTYPE_SAMPLE_FIELD_MAP`. */
export const PROTOTYPE_REQUEST_FIELD_MAP = {
  kh: "customerId",
  lienhe: "representative",
  phone: "phone",
  diadiem: "samplingLocation",
  hinhThucTra: "resultDeliveryModes",
  bm01: "sourceDocumentId",
} as const satisfies Record<string, keyof CreateTestRequestInput>;

/** Compile-time mapping from the Vietnamese prototype keys to the API contract - trường CẤP MẪU
 *  (mỗi phần tử `samples[]`). */
export const PROTOTYPE_SAMPLE_FIELD_MAP = {
  sp: "product",
  vungtrong: "growingAreaCode",
  csdg: "packingHouseCode",
  container: "containerNumber",
  bienso: "vehiclePlate",
  romooc: "trailerNumber",
  seal: "sealNumber",
  chiTieu: "parameterCodes",
} as const satisfies Record<string, keyof RequestedSample>;
