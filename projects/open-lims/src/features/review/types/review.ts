import type { StatusValue, Tone } from "@/lib/api";

export interface NamedCode {
  code: string;
  name: string;
}
// User refs may contain only id; fall back to it when a display name is not supplied.
export interface UserRef {
  id: string;
  fullName?: string;
}
export function userLabel(user?: UserRef | null): string {
  return user?.fullName ?? user?.id ?? "-";
}
export interface ServerPage {
  number: number;
  size: number;
  totalElements: number;
  totalPages: number;
}
export interface SummaryItem {
  key: string;
  label: string;
  value: number;
  tone: Tone;
}

export interface TechnicalReviewItem {
  taskCode: string;
  parentSampleCode: string;
  subSampleCode: string;
  parameter: NamedCode;
  sampleType: string;
  assignee: UserRef;
  submittedAt: string;
  status: StatusValue;
  version: number;
  finalResultCount: number;
  expectedFinalResultCount: number;
  technicalFileCount: number;
  allowedActions: string[];
}
export interface TechnicalReviewList {
  content: TechnicalReviewItem[];
  page: ServerPage;
  summary: SummaryItem[];
}
export interface ReviewResult {
  testPart: NamedCode;
  // TaskReviewResource.FinalResultResponse only ever sends value/unit - rawResultId,
  // subSampleCode, measuredAt, selectedBy/selectedAt and note are not part of the real payload.
  finalResult?: {
    value: string;
    unit: string;
  };
  rawResultCount: number;
  reviewState: NamedCode;
}
export interface TechnicalReviewDetail {
  taskCode: string;
  parentSampleCode: string;
  parameter: NamedCode;
  status: StatusValue;
  version: number;
  hasPreviousVersions: boolean;
  results: ReviewResult[];
  technicalFiles: Array<{ id: string; fileName: string; sizeBytes: number; uploadedAt: string }>;
  allowedActions: string[];
}
export interface ResultVersion {
  version: number;
  current: boolean;
  changedBy: UserRef;
  changedAt: string;
  reason: string;
  changes: Array<{ testPart: string; previousValue: string; newValue: string; unit: string }>;
}
export interface ResultVersionHistory {
  taskCode: string;
  versions: ResultVersion[];
}
export interface QuickConfirmItem {
  taskCode: string;
  testPart: string;
  version: number;
}
export interface QuickConfirmResponse {
  results: Array<{
    taskCode: string;
    testPart: string;
    status: "CONFIRMED" | "REJECTED";
    code?: string;
    message?: string;
  }>;
}

// `sort` is deliberately absent: `TechnicalReviewResource#listTechnicalReviews` declares only
// status/parameterCode/taskCode/page/size, so a sort parameter is dropped server-side and ordering
// stays whatever the query itself produces.
export interface ReviewFilters {
  status?: string[];
  /** Cả một chỉ tiêu (`VO`, `HM`) - bộ lọc thô. */
  parameterCode?: string;
  /** Đúng một task theo mã in trên màn hình (`2610001801VO`); máy chủ so không phân biệt hoa thường. */
  taskCode?: string;
  page?: number;
  size?: number;
}
