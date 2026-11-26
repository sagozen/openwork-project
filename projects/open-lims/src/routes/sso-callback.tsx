import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useClerk } from "@clerk/tanstack-react-start";
import {
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
} from "@fluentui/react-components";
import { ArrowLeft20Regular, Mail20Regular } from "@fluentui/react-icons";
import { clerkEnabled } from "@/lib/auth/AuthProvider";
import { describeClerkError } from "@/lib/auth/clerk-errors";
import { AppLogo } from "@/components/lims/common";

export const Route = createFileRoute("/sso-callback")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Đang hoàn tất đăng nhập - DLP LIMS" },
      { name: "description", content: "Hoàn tất đăng nhập vào hệ thống LIMS Đa Liên Phát." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SsoCallback,
});

function SsoCallback() {
  // Ở localhost/preview ClerkProvider không được mount (chế độ demo), nên không được
  // gọi useClerk() ở đây. Tách nhánh để hook Clerk chỉ chạy trong cây có ClerkProvider.
  if (!clerkEnabled()) return <DemoFallback />;
  return <ClerkSsoCallback />;
}

function ClerkSsoCallback() {
  const clerk = useClerk();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await clerk.handleRedirectCallback({
          signInFallbackRedirectUrl: "/admin",
          signUpFallbackRedirectUrl: "/admin",
        });
      } catch (err) {
        // Không có bước này thì trang treo spinner vô hạn, người dùng phải F5 mới thấy lỗi.
        if (!cancelled) setError(describeClerkError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clerk]);

  return <CallbackShell error={error} />;
}

function DemoFallback() {
  return (
    <CallbackShell
      error="Môi trường hiện tại không hỗ trợ xác thực SSO. Vui lòng chọn không gian làm việc tại trang đăng nhập."
      isDemo
    />
  );
}

function CallbackShell({ error, isDemo }: { error: string | null; isDemo?: boolean }) {
  const navigate = useNavigate();
  const hasError = !!error;

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
      <div style={{ width: "100%", maxWidth: 520 }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ display: "inline-flex" }}>
            <AppLogo size={56} />
          </div>
          <h1
            style={{
              margin: "12px 0 4px",
              fontSize: "var(--font-size-600)",
              fontWeight: 600,
            }}
          >
            {hasError ? "Không thể đăng nhập" : "Đang hoàn tất đăng nhập…"}
          </h1>
          <p style={{ margin: 0, color: "var(--foreground-secondary)" }}>
            {hasError
              ? "Hệ thống LIMS Đa Liên Phát chỉ dành cho tài khoản đã được cấp quyền."
              : "Vui lòng chờ trong giây lát để hệ thống xác thực."}
          </p>
        </div>

        {hasError ? (
          <div className="dlp-card" style={{ padding: 20, display: "grid", gap: 16 }}>
            <MessageBar intent="error" layout="multiline" style={{ width: "100%", minWidth: 0 }}>
              <MessageBarBody
                style={{ minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-line" }}
              >
                <MessageBarTitle>
                  {isDemo ? "SSO chưa khả dụng" : "Tài khoản chưa được cấp quyền"}
                </MessageBarTitle>
                {error}
              </MessageBarBody>
            </MessageBar>

            <div style={{ display: "grid", gap: 8 }}>
              <Button
                appearance="primary"
                size="large"
                icon={<ArrowLeft20Regular />}
                onClick={() =>
                  void navigate({ to: "/dang-nhap", search: { redirect: "/admin" }, replace: true })
                }
              >
                Quay lại đăng nhập
              </Button>
              {!isDemo ? (
                <Button
                  appearance="secondary"
                  size="large"
                  icon={<Mail20Regular />}
                  onClick={() =>
                    void navigate({
                      to: "/ho-tro/yeu-cau",
                      search: { type: "support" },
                      replace: true,
                    })
                  }
                >
                  Gửi yêu cầu hỗ trợ
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div
            className="dlp-card"
            style={{ padding: 40, display: "grid", placeItems: "center", gap: 12 }}
          >
            <Spinner size="huge" label="Đang hoàn tất đăng nhập…" />
            <p
              style={{
                margin: 0,
                color: "var(--foreground-secondary)",
                fontSize: "var(--font-size-200)",
              }}
            >
              Nếu chờ quá lâu, vui lòng quay lại trang đăng nhập và thử lại.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
