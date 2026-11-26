export type Tone = "info" | "success" | "warning" | "danger" | "brand" | "important";

export interface StatusValue {
  code: string;
  name: string;
  tone: Tone;
}

export interface FieldError {
  field: string;
  message: string;
}

export interface ProblemDetails {
  code?: string;
  message?: string;
  traceId?: string;
  timestamp?: string;
  fieldErrors?: FieldError[];
}

export interface Page<T> {
  content: T[];
  page: number;
  pageSize: number;
  totalElements: number;
  totalPages: number;
}

// UploadFileResource.UploadedDocumentResponse: id/fileName/contentType/sizeBytes/uploadedAt -
// không có "documentId"/"size"/"status" như bản cũ từng giả định.
export interface Attachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}
