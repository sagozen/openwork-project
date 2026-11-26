import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
} from "@fluentui/react-components";
import { ShieldError24Regular } from "@fluentui/react-icons";
import { AppShell } from "@/components/lims/AppShell";
import { DlpToaster } from "@/components/lims/common/toast";
import { AdminStoreProvider } from "@/lib/admin/admin-store";
import { useAuth } from "@/lib/auth/AuthProvider";

export const Route = createFileRoute("/_app")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Quản trị hệ thống - DLP LIMS" },
      {
        name: "description",
        content:
          "Khu vực quản trị LIMS Đa Liên Phát: người dùng, vai trò, chi nhánh, danh mục và tham số hệ thống.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminLayout,
});

function AdminLayout() {
  const { iamError, iamStatus, isLoaded, isSignedIn, signOut, usesClerk } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      // Chỉ giữ pathname (không kèm query) để tránh lồng redirect vô hạn.
      const target = pathname.startsWith("/dang-") ? "/" : pathname;
      void navigate({ to: "/dang-nhap", search: { redirect: target }, replace: true });
    }
  }, [isLoaded, isSignedIn, pathname, navigate]);

  if (!isLoaded || !isSignedIn) {
    return (
      <div
        className="dlp-screen-transition"
        style={{
          display: "grid",
          placeItems: "center",
          minHeight: "100dvh",
          width: "100%",
          backgroundColor: "var(--color-background)",
          color: "var(--color-foreground)",
        }}
      >
        <Spinner size="medium" label="Đang chuyển màn hình…" />
      </div>
    );
  }

  if (usesClerk && iamStatus !== "ready") {
    const denied = iamStatus === "denied";
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          width: "100%",
          padding: "clamp(16px, 4vw, 48px)",
          background: "var(--background-canvas)",
        }}
      >
        <div
          className="dlp-card"
          style={{
            width: "100%",
            maxWidth: 520,
            minWidth: 0,
            padding: "clamp(16px, 3vw, 24px)",
            display: "grid",
            gap: 16,
            justifyItems: "center",
            textAlign: "center",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 48,
              height: 48,
              borderRadius: "var(--radius-large)",
              background: denied
                ? "var(--status-danger-background)"
                : "var(--status-warning-background)",
              color: denied ? "var(--status-danger-icon)" : "var(--status-warning-icon)",
            }}
          >
            <ShieldError24Regular />
          </div>

          <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
            <h2
              style={{
                margin: 0,
                fontSize: "var(--font-size-500)",
                fontWeight: 600,
                overflowWrap: "anywhere",
              }}
            >
              {denied ? "Tài khoản chưa được cấp quyền IAM" : "Không thể xác minh quyền IAM"}
            </h2>
            <p
              style={{
                margin: 0,
                color: "var(--foreground-secondary)",
                fontSize: "var(--font-size-300)",
                lineHeight: 1.5,
                overflowWrap: "anywhere",
              }}
            >
              {denied
                ? "Tài khoản của bạn chưa được phân quyền trong hệ thống IAM. Liên hệ quản trị viên để được cấp quyền."
                : "Hệ thống không kết nối được dịch vụ IAM. Vui lòng thử lại sau ít phút."}
            </p>
          </div>

          {iamError ? (
            <MessageBar
              intent={denied ? "error" : "warning"}
              layout="multiline"
              style={{ width: "100%", minWidth: 0 }}
            >
              <MessageBarBody style={{ minWidth: 0, overflowWrap: "anywhere", textAlign: "left" }}>
                <MessageBarTitle>Chi tiết lỗi</MessageBarTitle>
                {iamError}
              </MessageBarBody>
            </MessageBar>
          ) : null}

          <div style={{ display: "grid", gap: 8, width: "100%", maxWidth: 280 }}>
            <Button appearance="primary" onClick={() => window.location.reload()}>
              Thử lại
            </Button>
            <Button appearance="secondary" onClick={() => void signOut()}>
              Đăng xuất
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AdminStoreProvider>
      <AppShell>
        <Outlet />
      </AppShell>
      <DlpToaster />
    </AdminStoreProvider>
  );
}
