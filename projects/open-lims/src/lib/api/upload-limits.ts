import { formatFileSize } from "@/lib/format";

/**
 * Trần dung lượng cho MỘT tệp tải lên.
 *
 * Đây là luật sản phẩm, không phải hằng số kỹ thuật. Máy chủ chặn ở
 * `quarkus.http.limits.max-body-size` (15M) và chặn theo **cả thân yêu cầu**, tức là gồm cả phần
 * bao multipart: ranh giới, tên tệp, header từng phần. Lấy trần người dùng thấp hơn trần máy chủ
 * để một tệp vừa đúng 10 MB không bị từ chối vì mấy trăm byte đóng gói - phần chênh là chỗ cho
 * lớp bao đó, không phải con số tuỳ tiện.
 *
 * Kiểm ngay lúc chọn tệp chứ không đợi máy chủ trả lời: người lấy mẫu đứng ngoài hiện trường
 * dùng 3G/4G, để họ đẩy hết một tấm ảnh 18 MB rồi mới nhận 413 là đổi vài phút sóng lấy một câu
 * báo lỗi.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Trần viết ra chữ, dùng trong mọi câu nhắc và câu báo lỗi để chỉ có một con số người dùng thấy. */
export const MAX_UPLOAD_LABEL = formatFileSize(MAX_UPLOAD_BYTES);

export function isOversized(file: File | Blob) {
  return file.size > MAX_UPLOAD_BYTES;
}

/**
 * Câu báo cho những tệp vượt trần, gọi thẳng tên tệp và dung lượng thật của nó.
 *
 * Chọn 5 ảnh mà chỉ 1 ảnh quá nặng thì câu "Tệp quá lớn" không nói được là ảnh nào, người dùng
 * phải mở lại thư viện ảnh dò từng tấm. Lời khuyên cuối câu để chung cho mọi loại tệp: ô file kỹ
 * thuật nhận .pdf/.docx/.xlsx, bảo người ta "chụp lại" một file Word là câu vô nghĩa.
 */
export function oversizedFilesMessage(files: File[]): string | undefined {
  const rejected = files.filter(isOversized);
  if (!rejected.length) return undefined;
  return `${rejected
    .map((file) => `${file.name} (${formatFileSize(file.size)})`)
    .join(
      ", ",
    )} - mỗi tệp tối đa ${MAX_UPLOAD_LABEL}. Hãy giảm dung lượng rồi chọn lại; nếu là ảnh thì chụp lại ở độ phân giải thấp hơn.`;
}
