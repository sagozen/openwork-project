import type { ApiClient } from "@/lib/api";
import type {
  AddSupplementaryDocumentInput,
  DeliveryInput,
  DeliveryList,
  DeliveryRecord,
  DraftDeliveryInput,
  ReleaseReportInput,
  RecipientContact,
  ReplaceReportInput,
  ReportList,
  ReportPreviewKind,
  ReportVersion,
  SignedScanInput,
  SupplementaryDocument,
  SupplementaryDocumentReport,
  SupplementaryDocumentList,
} from "../types";

const requestPath = (code: string) => `/test-requests/${encodeURIComponent(code)}/reports`;
const reportPath = (id: string) => `/reports/${encodeURIComponent(id)}`;

export const reportApi = {
  list: (api: ApiClient, requestCode: string) => api.get<ReportList>(requestPath(requestCode)),
  listForSample: (api: ApiClient, sampleCode: string) =>
    api.get<ReportList>(`/samples/${encodeURIComponent(sampleCode)}/reports`),
  supplementaryDocumentReports: (api: ApiClient, sampleCode: string) =>
    api.get<SupplementaryDocumentReport[]>(
      `/samples/${encodeURIComponent(sampleCode)}/supplementary-document-reports`,
    ),
  /** `GET /reports/{id}` - full detail for one version, the same shape every mutating call below
   * already returns. Used to refresh the selected report's data after a page reload instead of
   * relying on a mutation response from earlier this session. */
  get: (api: ApiClient, reportId: string) => api.get<ReportVersion>(reportPath(reportId)),
  recipientContact: (api: ApiClient, reportId: string) =>
    api.get<RecipientContact>(`${reportPath(reportId)}/recipient-contact`),
  /** Builds the named sample only; request codes cannot identify a report family. */
  build: (api: ApiClient, sampleCode: string) =>
    api.post<ReportVersion>(`/samples/${encodeURIComponent(sampleCode)}/reports`),
  updateNote: (api: ApiClient, reportId: string, note: string) =>
    api.put<ReportVersion>(`${reportPath(reportId)}/note`, { note }),
  signedScan: (api: ApiClient, reportId: string, input: SignedScanInput) =>
    api.post<ReportVersion>(`${reportPath(reportId)}/signed-scan`, input),
  release: (api: ApiClient, reportId: string, input: ReleaseReportInput) =>
    api.post<ReportVersion>(`${reportPath(reportId)}/release`, input),
  replace: (api: ApiClient, reportId: string, input: ReplaceReportInput) =>
    api.post<ReportVersion>(`${reportPath(reportId)}/replace`, input),
  deliveries: (api: ApiClient, reportId: string) =>
    api.get<DeliveryList>(`${reportPath(reportId)}/deliveries`),
  sendDelivery: (api: ApiClient, reportId: string, input: DeliveryInput) =>
    api.post<DeliveryRecord>(`${reportPath(reportId)}/deliveries`, input),
  sendDraftDelivery: (api: ApiClient, reportId: string, input: DraftDeliveryInput) =>
    api.post<DeliveryRecord>(`${reportPath(reportId)}/draft-deliveries`, input),
  supplementaryDocuments: (api: ApiClient, reportId: string, forAddition = false) =>
    api.get<SupplementaryDocumentList>(
      `${reportPath(reportId)}/supplementary-documents${forAddition ? "/for-addition" : ""}`,
    ),
  addSupplementaryDocument: (
    api: ApiClient,
    reportId: string,
    input: AddSupplementaryDocumentInput,
  ) => api.post<SupplementaryDocument>(`${reportPath(reportId)}/supplementary-documents`, input),
  downloadSupplementaryDocument: (api: ApiClient, reportId: string, documentId: string) =>
    api.getBlob(
      `${reportPath(reportId)}/supplementary-documents/${encodeURIComponent(documentId)}/content`,
    ),
};

/** Shared report preview client. The server renders a PDF; callers receive a Blob. */
export function getReportPreview(api: ApiClient, reportId: string, kind: ReportPreviewKind) {
  return api.getBlob(`${reportPath(reportId)}/preview?kind=${kind}`);
}

/** Shared immutable released-report download client. */
export function getReportPdf(api: ApiClient, reportId: string) {
  return api.getBlob(`${reportPath(reportId)}/pdf`);
}
