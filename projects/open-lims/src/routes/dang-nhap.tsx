import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SignIn } from "@clerk/tanstack-react-start";
import {
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
} from "@fluentui/react-components";
import { clerkEnabled, useAuth } from "@/lib/auth/AuthProvider";
import { useRestrictedSignInError } from "@/lib/auth/restricted-signup-guard";
import { currentClerkDomain, SIGN_UP_PATH } from "@/lib/auth/clerk-domains";
import { PERSONAS } from "@/lib/admin/rbac";

// Chỉ chấp nhận đường dẫn nội bộ, không phải trang đăng nhập => tránh lồng redirect.
function safeRedirect(value: unknown): string {
  if (typeof value !== "string") return "/";
  let path = value;
  for (let i = 0; i < 5 && /%25|%2F|%3F/i.test(path); i++) {
    try {
      path = decodeURIComponent(path);
    } catch {
      break;
    }
  }
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  if (path.startsWith("/dang-nhap")) return "/";
  return path;
}

export const Route = createFileRoute("/dang-nhap")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: safeRedirect(search["redirect"]),
  }),
  head: () => ({
    meta: [
      { title: "Đăng nhập - DLP LIMS" },
      {
        name: "description",
        content: "Đăng nhập vào hệ thống quản lý phòng thí nghiệm Đa Liên Phát.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LoginScreen,
});

/**
 * Thẻ đăng nhập Clerk + xử lý trường hợp email chưa được mời (chế độ Restricted).
 *
 * Tách riêng vì `useRestrictedSignInError` gọi `useClerk()`, chỉ hợp lệ bên trong
 * <ClerkProvider/>; ở chế độ demo không có provider nên không được gọi hook này.
 */
function ClerkSignInCard({ target }: { target: string }) {
  const { message, resetKey } = useRestrictedSignInError();

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        justifyItems: "center",
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      {message ? (
        <MessageBar intent="error" layout="multiline" style={{ width: "100%", minWidth: 0 }}>
          <MessageBarBody style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <MessageBarTitle>Không thể đăng nhập</MessageBarTitle>
            {message}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {/* resetKey đổi => <SignIn/> mount lại, thoát khỏi bước SSO callback đang kẹt spinner. */}
      <SignIn
        key={resetKey}
        routing="hash"
        signUpUrl={currentClerkDomain()?.signUpUrl ?? SIGN_UP_PATH}
        forceRedirectUrl={target}
        fallbackRedirectUrl={target}
      />
    </div>
  );
}

function LoginScreen() {
  const { isLoaded, isSignedIn, signInDemo } = useAuth();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const target = search.redirect || "/";

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
      <div style={{ width: "100%", maxWidth: 440, minWidth: 0 }}>
        {!isLoaded ? (
          <div style={{ display: "grid", placeItems: "center", minHeight: 200 }}>
            <Spinner label="Đang tải…" />
          </div>
        ) : clerkEnabled() ? (
          <ClerkSignInCard target={target} />
        ) : (
          <div className="dlp-card" style={{ padding: 16 }}>
            <div className="dlp-chiprow" style={{ marginBottom: 12 }}>
              <span
                style={{
                  color: "var(--foreground-secondary)",
                  fontSize: "var(--font-size-200)",
                }}
              >
                Chọn tài khoản được cấp quyền để tiếp tục.
              </span>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {PERSONAS.map((p) => (
                <Button
                  key={p.id}
                  appearance={p.id === "admin" ? "primary" : "secondary"}
                  size="large"
                  onClick={() => {
                    signInDemo(p.id);
                    void navigate({ to: "/", replace: true });
                  }}
                >
                  {p.role}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
