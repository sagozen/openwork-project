import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SignUp } from "@clerk/tanstack-react-start";
import { Button, MessageBar, MessageBarBody, MessageBarTitle } from "@fluentui/react-components";
import { clerkEnabled, useAuth } from "@/lib/auth/AuthProvider";
import { currentClerkDomain, SIGN_IN_PATH } from "@/lib/auth/clerk-domains";

// Chỉ chấp nhận đường dẫn nội bộ, không phải trang đăng nhập/đăng ký.
function safeRedirect(value: unknown): string {
  if (typeof value !== "string") return "/admin";
  let path = value;
  for (let i = 0; i < 5 && /%25|%2F|%3F/i.test(path); i++) {
    try {
      path = decodeURIComponent(path);
    } catch {
      break;
    }
  }
  if (!path.startsWith("/") || path.startsWith("//")) return "/admin";
  if (path.startsWith("/dang-nhap") || path.startsWith("/dang-ky")) return "/admin";
  return path;
}

export const Route = createFileRoute("/dang-ky")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: safeRedirect(search["redirect"]),
  }),
  head: () => ({
    meta: [
      { title: "Tạo tài khoản - DLP LIMS" },
      { name: "description", content: "Đăng ký tài khoản LIMS Đa Liên Phát." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SignUpScreen,
});

/**
 * Đích đến của bước "transfer sang sign-up" mà Clerk thực hiện sau SSO callback.
 * Ở chế độ Restricted, Clerk dựng thẻ `signUp.restrictedAccess` ngay tại đây -
 * nếu không có route nào mount <SignUp/> thì luồng transfer không có chỗ hiển thị
 * và người dùng chỉ thấy spinner cho tới khi F5.
 */
function SignUpScreen() {
  const { isLoaded, isSignedIn } = useAuth();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const target = search.redirect || "/admin";

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      void navigate({ to: target, replace: true });
    }
  }, [isLoaded, isSignedIn, navigate, target]);

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        background: "var(--background-canvas)",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 440 }}>
        {clerkEnabled() ? (
          <div style={{ display: "grid", placeItems: "center" }}>
            <SignUp
              routing="hash"
              signInUrl={currentClerkDomain()?.signInUrl ?? SIGN_IN_PATH}
              forceRedirectUrl={target}
              fallbackRedirectUrl={target}
            />
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Chỉ dành cho tài khoản nội bộ</MessageBarTitle>
                Hệ thống không mở đăng ký công khai. Vui lòng liên hệ quản trị viên để được mời.
              </MessageBarBody>
            </MessageBar>
            <Button
              appearance="primary"
              onClick={() =>
                void navigate({ to: "/dang-nhap", search: { redirect: target }, replace: true })
              }
            >
              Quay lại đăng nhập
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
