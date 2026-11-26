import { createFileRoute } from "@tanstack/react-router";
import { Badge, MessageBar, MessageBarBody, Spinner, Switch } from "@fluentui/react-components";
import { AdminSettingsShell } from "@/components/lims/AdminSettingsShell";
import { NoAccess } from "@/components/lims/NoAccess";
import { useAdminData } from "@/lib/admin/admin-store";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { useConfigBranches, usePatchBranch } from "@/features/config";
import { apiErrorMessage } from "@/lib/api";

export const Route = createFileRoute("/_app/admin/chi-nhanh")({
  head: () => ({
    meta: [
      { title: "Chi nhánh - Quản trị DLP LIMS" },
      {
        name: "description",
        content: "Danh sách đơn vị trực thuộc, thông tin liên hệ và trạng thái.",
      },
    ],
  }),
  component: BranchesScreen,
});

function BranchesScreen() {
  const { can, usesClerk } = useAuth();
  const demo = useAdminData();
  const remote = useConfigBranches();
  const patch = usePatchBranch();

  // Xem được thì cần quyền quản trị người dùng (màn này nằm trong khu quản trị); SỬA thì cần
  // `config.manage` - hai quyền tách nhau vì đọc danh sách chi nhánh là việc bình thường.
  const canWrite = can(PERM.CONFIG_MANAGE);

  // Một hình dạng dòng cho cả hai chế độ, để phần bảng bên dưới không phải rẽ nhánh.
  const branches = usesClerk
    ? (remote.data?.branches ?? []).map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        address: b.address ?? "-",
        phone: b.phone ?? "-",
        users: b.userCount,
        active: b.active,
      }))
    : demo.branches;

  const toggle = (id: string, active: boolean) => {
    if (!usesClerk) {
      demo.toggleBranch(id);
      return;
    }
    patch.mutate({ id, patch: { active: !active } });
  };

  if (!can(PERM.USER_MANAGE)) return <NoAccess screen="Chi nhánh" />;

  return (
    <>
      <AdminSettingsShell code="A-02">
        {usesClerk && remote.isLoading ? <Spinner label="Đang tải chi nhánh..." /> : null}
        {usesClerk && remote.error ? (
          <MessageBar intent="error">
            <MessageBarBody>
              {apiErrorMessage(remote.error, "Không tải được danh sách chi nhánh.")}
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {patch.error ? (
          <MessageBar intent="error">
            <MessageBarBody>
              {apiErrorMessage(patch.error, "Không đổi được trạng thái chi nhánh.")}
            </MessageBarBody>
          </MessageBar>
        ) : null}
        <div className="dlp-card" style={{ overflow: "auto" }}>
          <table className="dlp-datagrid" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ width: 80 }}>Mã</th>
                <th style={{ width: 200 }}>Tên chi nhánh</th>
                <th>Địa chỉ</th>
                <th style={{ width: 140 }}>Điện thoại</th>
                <th style={{ width: 110 }}>Nhân sự</th>
                <th className="dlp-stickycol dlp-stickycol--head" style={{ width: 150 }}>
                  Hoạt động
                </th>
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Badge appearance="tint" color="brand">
                      {b.code}
                    </Badge>
                  </td>
                  <td style={{ fontWeight: 600 }}>{b.name}</td>
                  <td>{b.address}</td>
                  <td className="dlp-num">{b.phone}</td>
                  <td className="dlp-num">{b.users}</td>
                  <td className="dlp-stickycol">
                    <Switch
                      checked={b.active}
                      disabled={!canWrite || patch.isPending}
                      onChange={() => toggle(b.id, b.active)}
                      label={b.active ? "Đang hoạt động" : "Ngừng"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminSettingsShell>
    </>
  );
}
