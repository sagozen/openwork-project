import { ResultConfigurationEditor } from "@/components/lims/ResultConfigurationEditor";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Badge,
  MessageBar,
  MessageBarBody,
  Spinner,
  Switch,
  Tab,
  TabList,
} from "@fluentui/react-components";
import { AdminSettingsShell } from "@/components/lims/AdminSettingsShell";
import { NoAccess } from "@/components/lims/NoAccess";
import { useAdminData } from "@/lib/admin/admin-store";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { CATALOG_GROUPS } from "@/lib/admin/mock-data";
import { useCatalogItems, usePatchCatalogItem, type CatalogGroup } from "@/features/config";
import { apiErrorMessage } from "@/lib/api";

export const Route = createFileRoute("/_app/admin/danh-muc")({
  head: () => ({
    meta: [
      { title: "Danh mục dùng chung - Quản trị DLP LIMS" },
      {
        name: "description",
        content: "Quản lý chỉ tiêu thử nghiệm, phương pháp, đơn vị đo và loại mẫu.",
      },
    ],
  }),
  component: CatalogScreen,
});

function CatalogScreen() {
  const { can, usesClerk } = useAuth();
  const demo = useAdminData();
  const [tab, setTab] = useState<string>(CATALOG_GROUPS[0].id);
  // Máy chủ lọc theo nhóm, nên đổi tab là một lượt tải khác chứ không phải lọc lại mảng cũ.
  const remote = useCatalogItems(tab as CatalogGroup);
  const patch = usePatchCatalogItem();

  const canWrite = can(PERM.CONFIG_MANAGE);

  const rows = usesClerk
    ? (remote.data?.items ?? []).map((item) => ({
        id: item.id,
        code: item.code,
        name: item.name,
        // Nhóm không phải chỉ tiêu thì không có đơn vị - hiện gạch ngang thay vì ô trống, để
        // phân biệt với "chưa điền".
        unit: item.unit ?? "-",
        active: item.active,
      }))
    : demo.catalog.filter((c) => c.group === tab);

  const toggle = (id: string, active: boolean) => {
    if (!usesClerk) {
      demo.toggleCatalogItem(id);
      return;
    }
    patch.mutate({ id, patch: { active: !active } });
  };

  if (!can(PERM.USER_MANAGE)) return <NoAccess screen="Danh mục dùng chung" />;

  return (
    <>
      <AdminSettingsShell code="A-03">
        <TabList
          selectedValue={tab}
          onTabSelect={(_, d) => setTab(d.value as string)}
          style={{ marginBottom: 12 }}
        >
          {CATALOG_GROUPS.map((g) => (
            <Tab key={g.id} value={g.id}>
              {g.label}
            </Tab>
          ))}
        </TabList>

        {usesClerk && remote.isLoading ? <Spinner label="Đang tải danh mục..." /> : null}
        {usesClerk && remote.error ? (
          <MessageBar intent="error">
            <MessageBarBody>
              {apiErrorMessage(remote.error, "Không tải được danh mục.")}
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {patch.error ? (
          <MessageBar intent="error">
            <MessageBarBody>
              {apiErrorMessage(patch.error, "Không đổi được trạng thái mục danh mục.")}
            </MessageBarBody>
          </MessageBar>
        ) : null}
        <div className="dlp-card" style={{ overflow: "auto" }}>
          <table className="dlp-datagrid" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th style={{ width: 110 }}>Mã</th>
                <th>Tên</th>
                <th style={{ width: 120 }}>Đơn vị</th>
                <th className="dlp-stickycol dlp-stickycol--head" style={{ width: 150 }}>
                  Sử dụng
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Badge appearance="outline" color="informative">
                      {c.code}
                    </Badge>
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    {c.name}
                    {usesClerk &&
                    tab === "chi-tieu" &&
                    remote.data?.items.find((i) => i.id === c.id) ? (
                      <ResultConfigurationEditor
                        key={`${c.id}-${remote.data?.items.find((i) => i.id === c.id)?.configurationVersion}`}
                        item={remote.data!.items.find((i) => i.id === c.id)!}
                        canWrite={canWrite}
                      />
                    ) : null}
                  </td>
                  <td className="dlp-num">{c.unit}</td>
                  <td className="dlp-stickycol">
                    <Switch
                      checked={c.active}
                      disabled={!canWrite || patch.isPending}
                      onChange={() => toggle(c.id, c.active)}
                      label={c.active ? "Đang dùng" : "Ngừng dùng"}
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
