/**
 * Dung lượng tệp viết theo cách người dùng đọc được (`8,4 MB`), dùng chung cho mọi màn có đính
 * kèm tài liệu.
 *
 * Dấu phẩy thập phân chứ không phải dấu chấm: bảng hồ sơ, danh sách tài liệu và câu báo lỗi
 * dung lượng đứng cạnh nhau trên cùng một màn tiếng Việt, viết `8.4 MB` ở một chỗ và `8,4 MB`
 * ở chỗ kia thì người đọc phải dừng lại nghĩ xem có phải cùng một con số không.
 */
export function formatFileSize(bytes?: number) {
  if (bytes === undefined || bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}
