import { Link, useRouterState } from "@tanstack/react-router";
import { Button } from "@fluentui/react-components";
import {
  Beaker20Regular,
  Building20Regular,
  History20Regular,
  ChevronLeft16Regular,
  ChevronRight16Regular,
  CircleHalfFill20Regular,
  PeopleTeam20Regular,
  Person20Regular,
  Settings20Regular,
} from "@fluentui/react-icons";
import { useState, type ReactNode } from "react";
import { PageHead } from "@/components/lims/common";
import { ADMIN_MENU } from "@/lib/admin/mock-data";
import { useAuth } from "@/lib/auth/AuthProvider";

const ICONS: Record<string, ReactNode> = {
  "A-00": <CircleHalfFill20Regular />,
  "A-01a": <PeopleTeam20Regular />,
  "A-01d": <Person20Regular />,
  "A-02": <Building20Regular />,
  "A-03": <Beaker20Regular />,
  "A-09": <History20Regular />,
  "A-12": <Settings20Regular />,
};

/** Khuôn màn cài đặt hệ thống (A-00 … A-12) theo mockup:
 *  page head (breadcrumb · tiêu đề · mô tả · nút hành động) + menu mục cài đặt thu gọn được. */
export function AdminSettingsShell({
  code,
  actions,
  children,
}: {
  code: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { can } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [collapsed, setCollapsed] = useState(false);

  const current =
    ADMIN_MENU.flatMap((g) => g.items).find((i) => i.code === code) ?? ADMIN_MENU[0]!.items[0]!;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1400, minWidth: 0 }}>
      <PageHead
        crumbs={[{ label: "Cài đặt hệ thống" }, { label: current.crumb }]}
        title={current.title}
        description={current.subtitle}
        actions={actions}
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div
          className="dlp-pane dlp-card"
          style={{ flex: `0 0 ${collapsed ? "52px" : "250px"}`, overflow: "hidden" }}
        >
          <div className="dlp-setmenu__head">
            {!collapsed ? (
              <span
                style={{
                  flex: 1,
                  font: "600 12px/16px var(--font-family-base)",
                  color: "var(--foreground-secondary)",
                  paddingLeft: 4,
                }}
              >
                Mục cài đặt
              </span>
            ) : null}
            <Button
              appearance="subtle"
              size="small"
              aria-label="Thu gọn menu cài đặt"
              icon={collapsed ? <ChevronRight16Regular /> : <ChevronLeft16Regular />}
              onClick={() => setCollapsed((v) => !v)}
            />
          </div>

          {ADMIN_MENU.map((g) => {
            const items = g.items.filter((i) => can(i.perm));
            if (items.length === 0) return null;
            return (
              <div key={g.group}>
                {!collapsed ? <div className="dlp-setmenu__group">{g.group}</div> : null}
                {items.map((i) => (
                  <Link
                    key={i.code}
                    to={i.to}
                    className="dlp-setmenu__item"
                    data-selected={pathname === i.to}
                    title={i.label}
                  >
                    <span className="dlp-setmenu__icon">{ICONS[i.code]}</span>
                    {!collapsed ? (
                      <>
                        <span
                          style={{
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {i.label}
                        </span>
                      </>
                    ) : null}
                  </Link>
                ))}
              </div>
            );
          })}
        </div>

        <div
          className="dlp-pane"
          style={{
            flex: "3 1 640px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minWidth: 0,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
