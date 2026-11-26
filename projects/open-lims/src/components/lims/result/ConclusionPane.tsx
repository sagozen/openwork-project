import { Badge, Button, MessageBar, MessageBarBody, Spinner } from "@fluentui/react-components";
import { ArrowUpload20Regular } from "@fluentui/react-icons";
import { useRef, useState } from "react";
import type { SampleTechnicalFile } from "@/features/sample/sample-api";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";
import { oversizedFilesMessage } from "@/lib/api/upload-limits";
import { formatDateTime } from "@/lib/format";

/* Chỉ chấp nhận tài liệu kỹ thuật; ảnh không mang được dữ liệu chạy máy. Kiểm theo đuôi tệp vì
   nhiều trình duyệt trả contentType rỗng cho .docx/.xlsx. Thuộc tính `accept` chỉ là gợi ý cho
   hộp thoại chọn tệp nên vẫn phải chặn lại ở đây, kèm thông báo thay vì bỏ qua im lặng. */
const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".xlsx"];
const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(",");
const REJECT_MESSAGE = `Chỉ nhận file ${ACCEPTED_EXTENSIONS.join(" · ")}. File này chưa được đính kèm.`;

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function ConclusionPane({
  files,
  requiresFile,
  disabled,
  busy,
  onAddFile,
  onDownload,
}: {
  files: SampleTechnicalFile[];
  requiresFile: boolean;
  disabled: boolean;
  busy: boolean;
  onAddFile: (file: File) => Promise<void>;
  onDownload: (file: SampleTechnicalFile) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  return (
    <aside className="dlp-pane" style={{ flex: "1 1 330px", minWidth: 0 }}>
      <div style={{ ...card, gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={sectionTitle}>File kỹ thuật nội bộ</span>
          <div style={{ flex: 1 }} />
          <Button
            size="small"
            disabled={disabled || busy}
            icon={busy ? <Spinner size="tiny" /> : <ArrowUpload20Regular />}
            onClick={() => input.current?.click()}
          >
            {busy ? "Đang tải…" : "Thêm file"}
          </Button>
        </div>
        {busy ? (
          <MessageBar intent="info">
            <MessageBarBody>Đang tải file lên máy chủ…</MessageBarBody>
          </MessageBar>
        ) : null}
        <input
          ref={input}
          hidden
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            if (!isAcceptedFile(file)) {
              setRejected(`${file.name} · ${REJECT_MESSAGE}`);
              return;
            }
            // Cùng trần dung lượng với mọi chỗ đính kèm khác. Ô này không dùng `FileDropField`
            // (nút "Thêm file" nằm trên thanh tiêu đề của khung hẹp, không có chỗ cho khung đứt
            // nét), nên phải gọi lại phép kiểm chung ở đây thay vì để tệp đi tới 413.
            const oversized = oversizedFilesMessage([file]);
            if (oversized) {
              setRejected(oversized);
              return;
            }
            setRejected(null);
            void onAddFile(file);
          }}
        />
        {rejected ? (
          <MessageBar intent="error">
            <MessageBarBody>{rejected}</MessageBarBody>
          </MessageBar>
        ) : null}
        {requiresFile && !files.some((file) => file.status === "AVAILABLE") ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              Chỉ tiêu này bắt buộc có file kỹ thuật trước khi gửi kiểm tra.
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {files.map((file) => (
          <div
            key={file.id}
            style={{
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-control)",
              padding: 10,
            }}
          >
            <strong>{file.fileName}</strong>
            <div className="dlp-datagrid__secondary">
              {file.uploadedAt ? formatDateTime(file.uploadedAt) : ""}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <Badge appearance="tint" color={file.status === "AVAILABLE" ? "success" : "warning"}>
                {file.status === "AVAILABLE" ? "Sẵn sàng" : file.status}
              </Badge>
              <Button
                size="small"
                disabled={busy || file.status !== "AVAILABLE"}
                onClick={() => void onDownload(file)}
              >
                Tải file
              </Button>
            </div>
          </div>
        ))}
        {!files.length ? <span style={hintText}>Chưa có file.</span> : null}
        <span style={hintText}>
          Nhận {ACCEPTED_EXTENSIONS.join(" · ")}. File chỉ dùng nội bộ, không tự sinh trị số và
          không đính kèm phiếu trả khách hàng.
        </span>
      </div>
    </aside>
  );
}
