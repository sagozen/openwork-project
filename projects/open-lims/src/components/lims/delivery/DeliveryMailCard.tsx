import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from "@fluentui/react-components";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";
import { FieldLabel } from "@/components/lims/common";
import { toneToColor } from "@/lib/admin/tone";
import {
  attachmentName,
  attachmentNote,
  deliveryLog,
  deliveryMessage,
  mailHint,
  printCta,
  sendCta,
  type CertStatus,
} from "@/lib/admin/delivery-data";

/* S-16 · Cột trái: gửi email kèm PDF phát hành và lịch sử trả kết quả. */
export function DeliveryMailCard({
  status,
  mailTo,
  bounced,
  sentTimes,
  sent,
  sentKind,
  confirmResend,
  canWrite,
  onMailTo,
  onConfirmResend,
  onSend,
  onPrint,
  onPreview,
  onDownload,
}: {
  status: CertStatus;
  mailTo: string;
  bounced: boolean;
  sentTimes: number;
  sent: boolean;
  sentKind: CertStatus;
  confirmResend: boolean;
  canWrite: boolean;
  onMailTo: (v: string) => void;
  onConfirmResend: (v: boolean) => void;
  onSend: () => void;
  onPrint: () => void;
  onPreview: () => void;
  onDownload: () => void;
}) {
  const alreadySent = sentTimes > 0;
  const cannotSend = !canWrite || (alreadySent && !confirmResend);
  const msg = deliveryMessage(status, bounced, sent, mailTo);
  const log = deliveryLog(status, sentTimes, sent, sentKind, mailTo);

  return (
    <div
      className="dlp-pane"
      style={{ flex: "2 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div style={card}>
        <div style={sectionTitle}>Gửi email kèm PDF phát hành</div>

        <Field label={<FieldLabel label="Địa chỉ người nhận" tooltip={mailHint(bounced)} />}>
          <Input value={mailTo} onChange={(_, d) => onMailTo(d.value)} />
        </Field>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-control)",
            padding: "10px 12px",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              width: 32,
              height: 40,
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              background: "var(--background-subtle)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              font: "10px/12px var(--font-family-base)",
              color: "var(--foreground-secondary)",
            }}
          >
            PDF
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              className="dlp-num dlp-truncate"
              style={{ font: "14px/20px var(--font-family-base)" }}
            >
              {attachmentName(status)}
            </div>
            <div style={hintText}>{attachmentNote(status)}</div>
          </div>
          <Button size="small" onClick={onPreview}>
            Xem lại file
          </Button>
          <Button size="small" appearance="subtle" onClick={onDownload}>
            Tải PDF
          </Button>
        </div>

        {alreadySent ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Đã gửi cho địa chỉ này:</MessageBarTitle>
              {` Đã gửi ${sentTimes} lần tới ${mailTo} - lần cuối vừa xong. Gửi lại chỉ dùng khi khách báo chưa nhận - hệ thống ghi nhận là lần gửi lại, không tạo bản phát hành mới.`}
            </MessageBarBody>
          </MessageBar>
        ) : null}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Button
            appearance={alreadySent ? "secondary" : "primary"}
            disabled={cannotSend}
            onClick={onSend}
          >
            {sendCta(status, sentTimes)}
          </Button>
          {alreadySent ? (
            <Checkbox
              checked={confirmResend}
              onChange={(_, d) => onConfirmResend(!!d.checked)}
              label="Xác nhận gửi lại"
            />
          ) : null}
          <Button disabled={status !== "valid" || !canWrite} onClick={onPrint}>
            {printCta(status)}
          </Button>
        </div>

        {msg ? (
          <MessageBar
            intent={
              msg.tone === "danger" ? "error" : msg.tone === "warning" ? "warning" : "success"
            }
          >
            <MessageBarBody>
              <MessageBarTitle>{msg.title}</MessageBarTitle> {msg.body}
            </MessageBarBody>
          </MessageBar>
        ) : null}
      </div>

      <div
        style={{
          background: "var(--background-card)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-surface)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border-subtle)",
            ...sectionTitle,
          }}
        >
          Lịch sử trả kết quả
        </div>
        {log.map((d, i) => (
          <div
            key={`${d.what}-${i}`}
            className="dlp-rowgrid"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,1fr) 150px 140px",
              gap: 12,
              alignItems: "center",
              padding: "12px 16px",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="dlp-truncate" style={{ font: "14px/20px var(--font-family-base)" }}>
                {d.what}
              </div>
              <div className="dlp-truncate" style={hintText}>
                {d.who}
              </div>
            </div>
            <Badge appearance="tint" size="small" color={toneToColor(d.tone)}>
              {d.state}
            </Badge>
            <span className="dlp-num" style={{ ...hintText, textAlign: "right" }}>
              {d.at}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
