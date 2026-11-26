import { formatFileSize } from "@/lib/format";
import type { ApiClient } from "./http-client";
import type { Attachment } from "./types";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "./upload-limits";

export interface UploadFileOptions {
  grant: string;
  documentId?: string;
  idempotencyKey?: string;
  fileName?: string;
  fields?: Record<string, string>;
}

// UploadFileResource: POST {baseUrl}/upload-file (baseUrl đã có /api/v1) - chỉ đọc phần
// multipart "file", không đọc "grant"/"documentId"/field nào khác. Bản cũ dựng URL cứng
// "/api/upload-file" (thiếu /v1) nên mọi lượt tải lên thật đều 404.
export async function uploadFile(
  api: ApiClient,
  file: File | Blob,
  options: UploadFileOptions,
): Promise<Attachment> {
  const name = options.fileName ?? (file instanceof File ? file.name : "upload");
  // Chốt chặn cuối cùng, đứng ở đây chứ không chỉ ở từng màn: mọi chỗ đính kèm trong sản phẩm
  // đều đi qua hàm này, nên một màn quên kiểm trước khi gọi vẫn không đẩy được tệp quá trần lên
  // sóng di động rồi nhận 413 trắng.
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Tệp "${name}" nặng ${formatFileSize(file.size)}, vượt mức tối đa ${MAX_UPLOAD_LABEL} mỗi tệp.`,
    );
  }
  const form = new FormData();
  form.append("file", file, name);
  return api.post<Attachment>("/upload-file", form, { idempotencyKey: options.idempotencyKey });
}
