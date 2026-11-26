import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
} from "@fluentui/react-components";
import { DlpToaster } from "@/components/lims/common/toast";
import { FieldSamplingApp } from "@/components/lims/field/FieldSamplingApp";
import { ConnectedFieldSamplingApp } from "@/components/lims/field/ConnectedFieldSamplingApp";
import { NoAccess } from "@/components/lims/NoAccess";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { searchString } from "@/lib/route-search";

interface Search {
  code?: string;
  sampleCode?: string;
}

export const Route = createFileRoute("/lay-mau")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    code: searchString(search["code"]),
    sampleCode: searchString(search["sampleCode"]),
  }),
  ssr: false,
  head: () => ({
    meta: [
      { title: "Lấy mẫu hiện trường - DLP LIMS" },
      {
        name: "description",
        content:
          "Ứng dụng lấy mẫu hiện trường: đối soát BM01, đề nghị sửa thông tin, lập BM03 và ký BM02 ngay trên điện thoại.",
      },
      { name: "robots", content: "noindex" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
    ],
  }),
  component: FieldSamplingRoute,
});

function FieldSamplingRoute() {
  const { can, iamError, iamStatus, isLoaded, isSignedIn, signOut, usesClerk } = useAuth();
  const navigate = useNavigate();
  // Mở từ chi tiết hồ sơ («Mở màn lấy mẫu») mang theo `?code=` mã hồ sơ.
  const { code: requestCode, sampleCode } = Route.useSearch();

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      void navigate({ to: "/dang-nhap", search: { redirect: "/lay-mau" }, replace: true });
    }
  }, [isLoaded, isSignedIn, navigate]);

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
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "60vh", padding: 24 }}>
        <MessageBar intent={iamStatus === "denied" ? "error" : "warning"} style={{ maxWidth: 560 }}>
          <MessageBarBody>
            <MessageBarTitle>
              {iamStatus === "denied"
                ? "Tài khoản chưa được cấp quyền IAM"
                : "Không thể xác minh quyền IAM"}
            </MessageBarTitle>
            {iamError ?? "Vui lòng thử lại sau hoặc liên hệ quản trị viên."}
            <div style={{ marginTop: 12 }}>
              <Button appearance="secondary" onClick={() => void signOut()}>
                Đăng xuất
              </Button>
            </div>
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  if (usesClerk && (!can(PERM.SAMPLING_READ) || !can(PERM.SAMPLING_WORK))) {
    return <NoAccess screen="Lấy mẫu hiện trường" />;
  }

  return (
    <>
      {usesClerk ? (
        <ConnectedFieldSamplingApp
          canManage={can(PERM.SAMPLING_CHANGE_APPROVE)}
          initialRequestCode={requestCode}
          initialSampleCode={sampleCode}
        />
      ) : (
        <FieldSamplingApp canManage={can(PERM.SAMPLING_CHANGE_APPROVE)} />
      )}
      <DlpToaster />
    </>
  );
}
