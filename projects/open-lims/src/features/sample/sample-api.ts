import type { StatusValue, ApiClient } from "@/lib/api";
export type ValueType =
  "NUMERIC" | "BELOW_LOD" | "BELOW_LOQ" | "NOT_DETECTED" | "TEXT_KPH" | "CATALOG_CHOICE";
export interface Measurement {
  id: string;
  value?: string;
  unit?: string;
  measuredAt: string;
  sampleMass: number | null;
  massUnit: string | null;
  valueType: ValueType;
  enteredBy: string;
  enteredAt?: string;
  comment?: string;
}
export interface SampleResultSet {
  testPart: string;
  rawResults: Measurement[];
  finalResult: { rawResultId: string | null; value?: string; unit?: string } | null;
}
export interface SampleParameter {
  code: string;
  name: string;
  taskCode: string;
  configurationVersion: number;
  valueType: ValueType;
  allowedValueTypes?: ValueType[];
  allowedUnits: string[];
  catalogChoices: string[];
  method: string;
  testParts: string[];
  editable: boolean;
  taskStatus?: string;
  status?: string | StatusValue;
  allowedActions?: string[];
  resultSets: SampleResultSet[];
  technicalFiles: SampleTechnicalFile[];
  returnedFeedback?: { comment: string };
}
export interface SampleTechnicalFile {
  id: string;
  documentId: string;
  fileName: string;
  status: string;
  uploadedAt?: string;
}
export interface SampleRawInput {
  testPart: string;
  valueType: ValueType;
  value: string;
  unit: string;
  comment?: string;
}
export const RESULT_VALUE_NAMES: Record<ValueType, string> = {
  NUMERIC: "Số",
  BELOW_LOD: "Không phát hiện (KPH)",
  BELOW_LOQ: "Dưới LOQ",
  NOT_DETECTED: "Không phát hiện",
  TEXT_KPH: "Văn bản / KPH",
  CATALOG_CHOICE: "Chọn từ danh mục",
};
export interface SampleWorkspace {
  sampleCode: string;
  requestCode: string;
  status: string | StatusValue;
  version: number;
  failedParameters: string[];
  locked: boolean;
  parameters: SampleParameter[];
  allowedActions: string[];
  hasPreviousVersions?: boolean;
}
export interface SampleApprovalItem {
  sampleCode: string;
  requestCode: string;
  productName: string;
  parameterCount: number;
  status: StatusValue;
  version: number;
  allowedActions: string[];
}
export interface SampleApprovalList {
  content: SampleApprovalItem[];
  page: { number: number; size: number; totalElements: number; totalPages: number };
}
export interface SampleApprovalWorkspace extends SampleWorkspace {
  approvalStatus: StatusValue;
  blockingReasons: string[];
}
export interface SampleResultVersionHistory {
  content: {
    version: number;
    decision: string;
    failedParameters: string[];
    comment: string;
    actorId: string;
    occurredAt: string;
    parameters: {
      code: string;
      name: string;
      resultSets: {
        testPart: string;
        finalResult: { value?: string; unit?: string } | null;
      }[];
    }[];
  }[];
}
export interface ManagedSample {
  code: string;
  requestCode: string;
  product?: string;
  parameterCodes?: string[];
  status: StatusValue;
  requestCreatedAt: string;
  elapsedDays: number;
  approvalStatus: StatusValue;
  approvedAt?: string;
  parameters?: { code: string; name: string }[];
}
export interface ManagedSampleList {
  data: ManagedSample[];
  page: { number: number; size: number; total: number };
}
export const samplePath = (code: string) => `/samples/${encodeURIComponent(code)}`;
export const sampleApi = {
  list: (api: ApiClient, filters: Record<string, string | number>) =>
    api.get<ManagedSampleList>(
      `/samples?${new URLSearchParams(
        Object.entries(filters)
          .filter(([, v]) => v !== "")
          .map(([k, v]) => [k, String(v)]),
      )}`,
    ),
  detail: (api: ApiClient, code: string) => api.get<ManagedSample>(samplePath(code)),
  results: (api: ApiClient, code: string) =>
    api.get<SampleWorkspace>(`${samplePath(code)}/lab-results`),
  submit: (api: ApiClient, code: string, version: number) =>
    api.post(`${samplePath(code)}/submit-review`, { version }),
  review: (api: ApiClient, code: string) =>
    api.get<SampleWorkspace>(`${samplePath(code)}/technical-review`),
  downloadReviewFile: (api: ApiClient, code: string, documentId: string) =>
    api.getBlob(
      `${samplePath(code)}/technical-review/files/${encodeURIComponent(documentId)}/content`,
    ),
  decide: (
    api: ApiClient,
    code: string,
    body: {
      version: number;
      decision: "ACCEPT" | "RETURN";
      comment?: string;
      failedParameters?: string[];
    },
  ) => api.post(`${samplePath(code)}/technical-review`, body),
  approvalQueue: (api: ApiClient, page = 1, size = 50) =>
    api.get<SampleApprovalList>(`/sample-approvals?page=${page}&size=${size}`),
  approval: (api: ApiClient, code: string) =>
    api.get<SampleApprovalWorkspace>(`${samplePath(code)}/approval`),
  approve: (api: ApiClient, code: string, body: { version: number; note?: string }) =>
    api.post<SampleApprovalWorkspace>(`${samplePath(code)}/approval`, body),
  rejectApproval: (
    api: ApiClient,
    code: string,
    body: { version: number; comment: string; failedParameters: string[] },
  ) => api.post<SampleApprovalWorkspace>(`${samplePath(code)}/approval/reject`, body),
  resultVersions: (api: ApiClient, code: string) =>
    api.get<SampleResultVersionHistory>(`${samplePath(code)}/result-versions`),
};
export function statusLabel(status: string | StatusValue) {
  return typeof status === "string" ? status : status.name;
}
