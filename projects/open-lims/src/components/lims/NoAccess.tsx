import { Button, MessageBar, MessageBarBody, MessageBarTitle } from "@fluentui/react-components";
import { ShieldError24Regular, Mail20Regular, ArrowLeft20Regular } from "@fluentui/react-icons";

/**
 * Trạng thái thiếu quyền - hiển thị như một khối căn giữa, có khoảng đệm và bề
 * rộng giới hạn để không bị kéo giãn hết chiều ngang màn hình lớn.
 */
export function NoAccess({ screen }: { screen: string }) {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        padding: "clamp(16px, 4vw, 48px)",
        minHeight: "min(60vh, 480px)",
        width: "100%",
        minWidth: 0,
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
            background: "var(--status-warning-background)",
            color: "var(--status-warning-icon)",
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
            Không đủ quyền truy cập
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
            Tài khoản của bạn chưa được cấp quyền cho màn hình <strong>{screen}</strong>. Liên hệ
            quản trị hệ thống để được phân quyền.
          </p>
        </div>

        <MessageBar intent="warning" layout="multiline" style={{ width: "100%", minWidth: 0 }}>
          <MessageBarBody style={{ minWidth: 0, overflowWrap: "anywhere", textAlign: "left" }}>
            <MessageBarTitle>Cần hỗ trợ?</MessageBarTitle>
            Gửi yêu cầu cấp quyền kèm tên màn hình để được xử lý nhanh hơn.
          </MessageBarBody>
        </MessageBar>

        <Button
          as="a"
          href="/ho-tro/yeu-cau"
          appearance="primary"
          icon={<Mail20Regular />}
          style={{ width: "100%", maxWidth: 280 }}
        >
          Gửi yêu cầu hỗ trợ
        </Button>

        {/* Màn hiện trường nằm ngoài layout có sidebar, nên khi rơi vào đây người dùng mất luôn
            đường quay lại và phải bấm back của trình duyệt. Một nút quay lại là đủ. */}
        <Button
          appearance="subtle"
          icon={<ArrowLeft20Regular />}
          style={{ width: "100%", maxWidth: 280 }}
          onClick={() => window.history.back()}
        >
          Quay lại
        </Button>
      </div>
    </div>
  );
}
