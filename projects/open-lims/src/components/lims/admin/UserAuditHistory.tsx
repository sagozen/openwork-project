import { Spinner } from "@fluentui/react-components";
import { AuditEventList } from "@/components/lims/audit/AuditEventList";
import { flattenAuditPages, useAuditEvents } from "@/features/audit";
import { USER_AUDIT_DEMO } from "@/lib/admin/audit-data";

/** Lịch sử phân quyền và trạng thái của MỘT người dùng, đọc từ nhật ký thật.
 *
 *  Nhật ký nằm sau quyền `audit.read`, khác với quyền `user.manage` mở được drawer này - nên
 *  người quản lý người dùng chưa chắc đọc được nhật ký. Chỗ gọi phải tự kiểm quyền và chỉ dựng
 *  thành phần này khi có; ở đây không đoán hộ. */
export function UserAuditHistory({ userId }: { userId: string }) {
  const query = useAuditEvents({ targetType: "user", targetId: userId, pageSize: 20 });
  if (query.isLoading) return <Spinner size="tiny" label="Đang tải lịch sử..." />;
  return (
    <AuditEventList
      events={flattenAuditPages(query.data?.pages)}
      error={query.error}
      hasNextPage={query.hasNextPage}
      isFetchingNextPage={query.isFetchingNextPage}
      onLoadMore={() => void query.fetchNextPage()}
      emptyTitle="Chưa có thay đổi nào được ghi nhận"
      emptyHint="Việc gán vai trò, vô hiệu hoá và mở khoá tài khoản sẽ xuất hiện ở đây."
    />
  );
}

/** Bản minh hoạ: hai dòng dựng sẵn, không có máy chủ nào để đọc. */
export function DemoUserAuditHistory() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {USER_AUDIT_DEMO.map((line) => (
        <div key={line.what}>
          <div>{line.what}</div>
          <div className="dlp-datagrid__secondary">{line.who}</div>
        </div>
      ))}
    </div>
  );
}
