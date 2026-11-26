import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Spinner } from "@fluentui/react-components";
import { useAuth } from "@/lib/auth/AuthProvider";
import { resolveLandingRoute } from "@/lib/auth/nav-access";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "DLP LIMS - Hệ thống quản lý phòng thí nghiệm" },
      {
        name: "description",
        content: "Hệ thống quản lý phòng thí nghiệm Đa Liên Phát (LIMS) - khu vực nội bộ.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LandingRedirect,
});

function LandingRedirect() {
  const { isLoaded, isSignedIn, can } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      void navigate({ to: "/dang-nhap", search: { redirect: "/" }, replace: true });
      return;
    }
    // Vào thẳng màn đầu tiên trong menu mà tài khoản được phép mở, thay vì một đích cố định
    // có thể chỉ hiện NoAccess.
    void navigate({ to: resolveLandingRoute(can), replace: true });
  }, [isLoaded, isSignedIn, can, navigate]);

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
