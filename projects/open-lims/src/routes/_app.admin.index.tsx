import { createFileRoute, Link } from "@tanstack/react-router";
import { MessageBar, MessageBarBody, MessageBarTitle } from "@fluentui/react-components";
import { AdminSettingsShell } from "@/components/lims/AdminSettingsShell";
import { NoAccess } from "@/components/lims/NoAccess";
import { ADMIN_SECTIONS } from "@/lib/admin/mock-data";
import { useAuth } from "@/lib/auth/AuthProvider";

export const Route = createFileRoute("/_app/admin/")({
  head: () => ({
    meta: [
      { title: "Cài đặt hệ thống - DLP LIMS" },
      {
        name: "description",
        content: "Quản lý các nhóm cấu hình hệ thống LIMS Đa Liên Phát.",
      },
    ],
  }),
  component: AdminOverview,
});

function AdminOverview() {
  const { can } = useAuth();

  if (!can("admin.view")) return <NoAccess screen="Cài đặt hệ thống" />;

  const cards = ADMIN_SECTIONS.filter((s) => can(s.perm));

  return (
    <AdminSettingsShell code="A-00">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        {cards.map((s) => (
          <Link key={s.code} to={s.to} className="dlp-admincard">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ font: "600 16px/22px var(--font-family-base)" }}>{s.label}</span>
              <div style={{ flex: 1 }} />
            </div>
            <span
              style={{
                font: "12px/16px var(--font-family-base)",
                color: "var(--foreground-secondary)",
              }}
            >
              {s.hint}
            </span>
          </Link>
        ))}
      </div>

      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Truy cập theo phân quyền:</MessageBarTitle> Mỗi mục cài đặt chỉ hiển thị
          khi tài khoản có quyền phù hợp. Mọi thay đổi được ghi vào nhật ký và có hiệu lực với yêu
          cầu mới trong vòng 60 giây.
        </MessageBarBody>
      </MessageBar>
    </AdminSettingsShell>
  );
}
