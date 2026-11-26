import type { CSSProperties, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { RecordRow } from "@/lib/admin/records-data";

/** Liên kết tới hồ sơ: hồ sơ đã có mã lượt mở màn chi tiết, hồ sơ còn DRAFT (BR-003, chưa
 *  được cấp mã) quay lại màn tạo yêu cầu để làm tiếp. */
export function RecordLink({
  row,
  style,
  className,
  children,
}: {
  row: RecordRow;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
}) {
  const props = { ...(className ? { className } : {}), ...(style ? { style } : {}) };
  return row.draftId ? (
    <Link to="/tao-yeu-cau" search={{ draftId: row.draftId }} {...props}>
      {children ?? "Nháp · tiếp tục"}
    </Link>
  ) : (
    <Link to="/ho-so-chi-tiet/$id" params={{ id: row.id }} {...props}>
      {children ?? row.id}
    </Link>
  );
}
