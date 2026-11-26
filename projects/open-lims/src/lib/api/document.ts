import type { ApiClient } from "./http-client";
import type { Attachment } from "./types";

/** `DocumentResource.DocumentResponse`: `Attachment` cộng thêm mã người tải lên. */
export interface StoredDocument extends Attachment {
  uploadedBy?: string;
}

// DocumentResource: GET {baseUrl}/documents/{id} - metadata của một tệp đã tải lên, để màn hình
// gọi được tên chứng từ nó đang mời tải về thay vì chỉ hiện một mã số.
export function fetchDocument(api: ApiClient, id: string): Promise<StoredDocument> {
  return api.get<StoredDocument>(`/documents/${encodeURIComponent(id)}`);
}

// GET {baseUrl}/documents/{id}/content - server trả `Content-Disposition: attachment` +
// `X-Content-Type-Options: nosniff` (FR-DOC-014: tài liệu người dùng tải lên KHÔNG được render
// nội tuyến). Vì vậy chỗ gọi phải lưu file xuống máy, tuyệt đối không mở trong iframe/tab xem PDF.
export function downloadDocument(api: ApiClient, id: string): Promise<Blob> {
  return api.getBlob(`/documents/${encodeURIComponent(id)}/content`);
}
