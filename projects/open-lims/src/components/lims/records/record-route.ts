import type { RecordRow } from "@/lib/admin/records-data";

/** Đích điều hướng của một dòng hồ sơ: hồ sơ đã có mã lượt mở màn chi tiết, hồ sơ còn DRAFT
 *  (BR-003, chưa được cấp mã) quay lại màn tạo yêu cầu để làm tiếp. */
export function recordNavigateTo(row: RecordRow) {
  return row.draftId
    ? ({ to: "/tao-yeu-cau", search: { draftId: row.draftId } } as const)
    : ({ to: "/ho-so-chi-tiet/$id", params: { id: row.id } } as const);
}
