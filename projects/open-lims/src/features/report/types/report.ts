import type { StatusValue } from "@/lib/api";

export type ReportPreviewKind = "DRAFT" | "PRINT" | "RELEASED";
export type DeliveryKind = "DRAFT_REVIEW" | "RELEASED_REPORT";

/**
 * A person named on a report version (`PersonResponse`). `title` is the job title printed under
 * the name; absent when nobody has given that person one.
 */
export interface ReportPerson {
  id: string;
  fullName: string;
  title?: string;
}

/**
 * Returned on a `200` from the signed-scan attach when the person recorded as having signed is
 * not the approver printed on the form. The attachment committed and the audit trail names both
 * people - this is information, not a refusal (`report/US-003` AC-010).
 *
 * `code` is `REPORT_SIGNER_MISMATCH` today; `message` is the server's own Vietnamese sentence
 * naming both people, and is what the screen shows.
 */
export interface SignerMismatchWarning {
  code: string;
  message: string;
}

/**
 * One report version. `GET /test-requests/{code}/reports` (list, `ReportListItemResponse`) and
 * `GET /reports/{id}` / the mutating `{id}` endpoints (build/signed-scan/release/replace, all
 * `ReportResponse`) return the same field set - only `current` is list-only, since exactly
 * one version per sample carries it there and the single-report shape has no notion of "current
 * among siblings".
 */
export interface ReportVersion {
  sampleId?: string;
  sampleCode?: string;
  id: string;
  reportCode: string;
  version: number;
  status: StatusValue;
  templateVersion: string;
  legalProfileVersion: string;
  hasSignedScan: boolean;
  /** `null`/absent until the version has ever released. */
  checksum?: string;
  supersedeReason?: string;
  /** Nội dung in ở mục “Nhận xét khác / Comments”, khoá sau khi gắn bản scan đã ký. */
  note?: string | null;
  builtAt?: string;
  releasedAt?: string;
  /** Present once the version has ever released; `null`/absent otherwise. */
  publicUrl?: string;
  /** List-only: exactly one version per sample is current. Absent on `GET /reports/{id}`. */
  current?: boolean;
  /** Người phê duyệt được in trên phiếu, ghim vào phiên bản lúc dựng. `title` là chức danh đã
   * ghim, không phải chức danh hiện tại của người đó - phiếu đã phát hành nói gì thì trường này
   * nói vậy. Absent on a version built before the pins existed: it printed no name. */
  printedApprover?: ReportPerson;
  /** Người được ghi là đã ký bản scan, đọc theo hồ sơ hiện tại. Absent until a scan is attached. */
  signedBy?: ReportPerson;
  /** Only ever set on the signed-scan attach response, and only when the two people above differ. */
  signerMismatchWarning?: SignerMismatchWarning;
}

export type ReportList = ReportVersion[];

/** Minimal version metadata available to supplementary-document editors without report.read. */
export interface SupplementaryDocumentReport {
  id: string;
  reportCode: string;
  version: number;
  status: StatusValue;
  current: boolean;
  sampleCode?: string;
}

/**
 * `signedBy` names the person recorded as having signed the paper. Bỏ trống thì server ghi chính
 * người gọi, đúng mặc định của màn này - nên FE không gửi trường này: chọn người khác cần tra
 * được danh bạ người giữ `report.sign`, mà vai trò nghiệp vụ không đọc được danh bạ. Server kiểm
 * tra chứ không tin: id phải là người dùng đang hoạt động cùng đơn vị và giữ `report.sign`, nếu
 * không thì 422 `E-RPT-013`.
 *
 * `signedAt` vẫn không nhận từ client - dấu thời gian ký trên một hồ sơ pháp lý đã phát hành là
 * đồng hồ của server (`AttachSignedScanService`).
 */
export interface SignedScanInput {
  documentId: string;
  signedBy?: string;
}

/** `channels` is not part of the real request body (`ReportResource.ReleaseRequest` only has
 * `recipients`); release always sends over email once recipients are given. */
export interface ReleaseReportInput {
  recipients?: string[];
}

export interface ReplaceReportInput {
  reason: string;
}

/** Both delivery endpoints take exactly one recipient per call (`RecipientRequest(String
 * recipient)`); callers sending multiple recipients issue one call per recipient. `kind` is
 * implicit server-side (always `RELEASED_REPORT` for `/deliveries`). */
export interface DeliveryInput {
  recipient: string;
}

/** The customer address confirmed for a report, or null while none is on file. */
export interface RecipientContact {
  email?: string | null;
}

/** `note` is optional - accompanies a draft-review send only (`DraftDeliveryRequest`); the
 * released-report resend endpoint (`/deliveries`) has no `note` concept. */
export interface DraftDeliveryInput {
  recipient: string;
  note?: string;
}

export interface DeliveryRecord {
  id: string;
  kind: DeliveryKind;
  recipient: string;
  status: StatusValue;
  retryCount: number;
  failureReason?: string;
  sentAt?: string;
  createdAt: string;
  /** `null`/absent on `DRAFT_REVIEW` rows (a draft is never released). */
  checksum?: string;
  /** Caller who triggered the send. */
  actorId?: string;
  /** Set once the delivery provider (e.g. email) has assigned a tracking id. */
  providerMessageId?: string;
  /** The parent report's version at read time. Populated on `GET .../deliveries` list rows only
   * - `null` on the single-send responses (`POST .../deliveries`, `POST .../draft-deliveries`),
   * which have no report version in hand when building the response. */
  version?: number;
}

export type DeliveryList = DeliveryRecord[];

/** Internal append-only attachment to one exact report version, separate from its signed scan. */
export interface SupplementaryDocument {
  documentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  addedBy: {
    id: string;
    fullName: string;
  };
  addedAt: string;
}

export interface SupplementaryDocumentList {
  items: SupplementaryDocument[];
}

export interface AddSupplementaryDocumentInput {
  documentId: string;
}
