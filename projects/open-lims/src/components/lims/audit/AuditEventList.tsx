import { Badge, Button, MessageBar, MessageBarBody, Spinner } from "@fluentui/react-components";
import { EmptyState } from "@/components/lims/common";
import { actionLabel, targetLabel, type AuditEvent } from "@/features/audit";
import { apiErrorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

/** Máy chủ trả `detail` là một map tuỳ hành động (không phải câu dựng sẵn), nên hiển thị theo
 *  từng cặp khoá - giá trị thay vì ép thành một chuỗi. Giá trị lồng nhau in dạng JSON gọn:
 *  thà thấy dữ liệu thô còn hơn im lặng bỏ mất một thay đổi đã được ghi vào nhật ký. */
function detailPairs(detail?: Record<string, unknown>): [string, string][] {
  if (!detail) return [];
  return Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => [
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ]);
}

function AuditEventRow({ event }: { event: AuditEvent }) {
  const pairs = detailPairs(event.detail);
  return (
    <li
      style={{
        display: "grid",
        gap: 4,
        borderTop: "1px solid var(--border-subtle)",
        paddingTop: 10,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Badge appearance="tint">{actionLabel(event.action)}</Badge>
        <span className="dlp-num">{formatDateTime(event.occurredAt)}</span>
        <span className="dlp-datagrid__secondary">
          {targetLabel(event.targetType)} · {event.targetId}
        </span>
      </div>
      <div>
        {/* Máy chủ giấu tên người thực hiện với người gọi không đủ quyền; nói đúng như vậy thay
            vì in một ô trống trông như dữ liệu thiếu. */}
        {event.actor?.fullName ?? "Người thực hiện bị ẩn theo phân quyền"}
        {event.actor?.userId ? (
          <>
            {" · mã người dùng "}
            <span className="dlp-num">{event.actor.userId}</span>
          </>
        ) : null}
      </div>
      <div className="dlp-datagrid__secondary">
        {pairs.length === 0
          ? "Chi tiết bị ẩn theo phân quyền"
          : pairs.map(([key, value]) => `${key}: ${value}`).join(" · ")}
      </div>
    </li>
  );
}

/** Danh sách dòng nhật ký + nút "Tải thêm".
 *
 *  Không có pager số trang: máy chủ phân trang bằng con trỏ giữ-chỗ theo
 *  `(occurred_at DESC, id DESC)`, nên chỉ đi tiếp tuần tự được, không nhảy thẳng tới trang N. */
export function AuditEventList({
  events,
  isLoading,
  error,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  emptyTitle = "Không có dòng nhật ký nào khớp",
  emptyHint = "Nới khoảng thời gian hoặc bỏ bớt điều kiện lọc.",
}: {
  events: AuditEvent[];
  isLoading?: boolean;
  error?: unknown;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  emptyTitle?: string;
  emptyHint?: string;
}) {
  if (isLoading) return <Spinner label="Đang tải nhật ký..." />;
  if (error)
    return (
      <MessageBar intent="error">
        <MessageBarBody>{apiErrorMessage(error, "Không đọc được nhật ký.")}</MessageBarBody>
      </MessageBar>
    );
  if (events.length === 0) return <EmptyState title={emptyTitle} hint={emptyHint} />;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
        {events.map((event) => (
          <AuditEventRow key={event.id} event={event} />
        ))}
      </ol>
      {hasNextPage && onLoadMore ? (
        <Button appearance="secondary" disabled={isFetchingNextPage} onClick={onLoadMore}>
          {isFetchingNextPage ? "Đang tải..." : "Tải thêm"}
        </Button>
      ) : null}
    </div>
  );
}
