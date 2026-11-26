import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MessageBar, MessageBarBody, MessageBarTitle } from "@fluentui/react-components";
import { NoAccess } from "@/components/lims/NoAccess";
import { RecordsScreen } from "@/components/lims/records/RecordsScreen";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { RECORD_STATS } from "@/lib/admin/records-data";
import {
  BOARD_COLUMNS,
  RECORD_NOTIFS,
  RECORD_QUEUE,
  RECORD_TAGS,
} from "@/lib/admin/records-view-data";
import { useRecordsView } from "@/lib/admin/records-view-state";
import { RemoteRecordsPage } from "@/features/request/ui/remote-records-page";

export const Route = createFileRoute("/_app/ho-so")({
  head: () => ({
    meta: [
      { title: "Hồ sơ kiểm nghiệm - DLP LIMS" },
      {
        name: "description",
        content:
          "Danh sách hồ sơ kiểm nghiệm với chế độ xem đã lưu, nhãn, bộ lọc nâng cao và quản lý cột.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RecordsRoute,
});

function RecordsRoute() {
  const { can, usesClerk } = useAuth();
  if (!can(PERM.REQUEST_READ)) return <NoAccess screen="Hồ sơ kiểm nghiệm" />;
  return usesClerk ? (
    <RemoteRecordsPage canWrite={can(PERM.REQUEST_CREATE)} />
  ) : (
    <DemoRecordsScreen />
  );
}

/** Bản mockup: cùng bố cục với bản chạy thật, chỉ khác nguồn dữ liệu. */
function DemoRecordsScreen() {
  const { can } = useAuth();
  const canPii = can(PERM.REQUEST_CUSTOMER_VIEW);
  const view = useRecordsView(canPii);
  const navigate = useNavigate();

  return (
    <RecordsScreen
      view={view}
      canPii={canPii}
      canWrite={can(PERM.REQUEST_CREATE)}
      stats={RECORD_STATS}
      tagCatalog={RECORD_TAGS}
      boardBaseColumns={BOARD_COLUMNS}
      panels={{ notifs: RECORD_NOTIFS, queue: RECORD_QUEUE }}
      bulkSupported
      showViewCounts
      searchPlaceholder="Tìm mã lượt, khách hàng, sản phẩm"
      onCreate={() => void navigate({ to: "/tao-yeu-cau" })}
      alert={
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Nhắc thanh toán ngày 5:</MessageBarTitle> Hồ sơ 26100012 chưa có chứng
            từ thanh toán - còn 2 ngày trước khi khoá chuyển lab.
          </MessageBarBody>
        </MessageBar>
      }
    />
  );
}
