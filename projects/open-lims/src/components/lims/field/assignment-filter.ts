import type { SamplingAssignment } from "@/features/sampling";

/* Bộ lọc danh sách lượt lấy mẫu (S-05, bản nối API).
   `/sampling-assignments` không trả trường nhãn nào, nên "nhãn" ở đây là chỉ tiêu xét nghiệm
   (`testParameters`) và trạng thái lượt - đều là dữ liệu thật của lượt. Lọc chạy trên trang đang
   tải: endpoint chỉ nhận `date`/`status`, không có tham số lọc theo chỉ tiêu, nên đẩy lên server
   thì vẫn phải lọc lại phía client mà lại làm phân trang sai. */

export interface AssignmentFilter {
  parameters: string[];
  statuses: string[];
}

export const EMPTY_FILTER: AssignmentFilter = { parameters: [], statuses: [] };

export function filterAssignments(items: SamplingAssignment[], filter: AssignmentFilter) {
  return items.filter((item) => {
    const byParameter =
      !filter.parameters.length ||
      item.testParameters.some((p) => filter.parameters.includes(p.code));
    const byStatus = !filter.statuses.length || filter.statuses.includes(item.status.code);
    return byParameter && byStatus;
  });
}

export interface FilterOption {
  key: string;
  label: string;
  count: number;
  tone?: string;
}

/** Gom lựa chọn kèm số lượng từ chính các lượt đang tải - không có danh mục cứng nào ở FE. */
export function countBy(
  items: SamplingAssignment[],
  pick: (item: SamplingAssignment) => Omit<FilterOption, "count">[],
) {
  const map = new Map<string, FilterOption>();
  for (const item of items) {
    for (const option of pick(item)) {
      const current = map.get(option.key);
      if (current) current.count += 1;
      else map.set(option.key, { ...option, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
