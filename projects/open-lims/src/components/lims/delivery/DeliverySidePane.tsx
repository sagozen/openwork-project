import {
  Badge,
  Button,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Textarea,
} from "@fluentui/react-components";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";
import { toneToColor } from "@/lib/admin/tone";
import {
  DRAFT_INFO,
  DRAFT_TITLE,
  LOOKUP_NOTE,
  REPLACE_NOTE,
  certState,
  certTone,
  type CertStatus,
} from "@/lib/admin/delivery-data";

/* S-16 · Cột phải: trạng thái phiếu, bản nháp và thay thế. */
export function DeliverySidePane({
  status,
  reason,
  draftSent,
  canWrite,
  onReason,
  onDraft,
  onViewDraft,
  onDownloadPrint,
  onReplace,
}: {
  status: CertStatus;
  reason: string;
  draftSent: boolean;
  canWrite: boolean;
  onReason: (v: string) => void;
  onDraft: () => void;
  onViewDraft: () => void;
  onDownloadPrint: () => void;
  onReplace: () => void;
}) {
  const blocked = !reason.trim() || status !== "valid" || !canWrite;

  return (
    <div
      className="dlp-pane"
      style={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div style={{ ...card, gap: 12 }}>
        <div style={sectionTitle}>Trạng thái phiếu</div>
        <Badge appearance="filled" size="medium" color={toneToColor(certTone(status))}>
          {certState(status)}
        </Badge>
        <span style={hintText}>{LOOKUP_NOTE}</span>
      </div>

      <div style={{ ...card, gap: 10 }}>
        <div style={sectionTitle}>{DRAFT_TITLE}</div>
        <span style={hintText}>{DRAFT_INFO}</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button size="small" onClick={onViewDraft}>
            Xem bản nháp
          </Button>
          <Button size="small" onClick={onDownloadPrint}>
            Tải phiếu để ký
          </Button>
          <Button size="small" appearance="primary" disabled={!canWrite} onClick={onDraft}>
            Gửi email bản nháp
          </Button>
        </div>
        {draftSent ? (
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Đã gửi bản nháp:</MessageBarTitle> Bản nháp có watermark đã gửi tới
              khách - không đổi trạng thái hồ sơ và không cấp mã tra cứu.
            </MessageBarBody>
          </MessageBar>
        ) : null}
      </div>

      <div style={{ ...card, gap: 12 }}>
        <div style={sectionTitle}>Thay thế phiếu đã phát hành</div>
        <Field label="Lý do - bắt buộc">
          <Textarea
            rows={2}
            value={reason}
            onChange={(_, d) => onReason(d.value)}
            placeholder="Ví dụ: sai đơn vị trên chỉ tiêu Cadimi"
          />
        </Field>
        <Button disabled={blocked} onClick={onReplace}>
          Tạo phiên bản thay thế
        </Button>
        <span style={hintText}>{REPLACE_NOTE}</span>
      </div>
    </div>
  );
}
