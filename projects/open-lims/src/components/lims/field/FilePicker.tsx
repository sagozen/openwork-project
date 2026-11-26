import { useState } from "react";
import { Label } from "@fluentui/react-components";
import { FileDropField } from "@/components/lims/common/FileDropField";
import { formatFileSize } from "@/lib/format";
import { secondary } from "./field-styles";

/**
 * Ô chọn ảnh của màn hiện trường.
 *
 * Ghi kèm tổng dung lượng đã chọn chứ không chỉ đếm số tệp: người lấy mẫu đứng ngoài vườn dùng
 * 4G, biết mình sắp đẩy 24 MB hay 2 MB thì mới ước được là chờ hay chụp lại nhẹ hơn. Việc chặn
 * tệp quá trần nằm trong `FileDropField`, dùng chung cho mọi màn.
 */
export function FilePicker({
  label,
  required = false,
  hint,
  multiple,
  pending,
  pendingLabel = "Đang tải…",
  onFiles,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  multiple?: boolean;
  pending?: boolean;
  pendingLabel?: string;
  onFiles: (files: File[]) => void;
}) {
  const [accepted, setAccepted] = useState<File[]>([]);
  const totalBytes = accepted.reduce((sum, file) => sum + file.size, 0);
  // `FileDropField` đã loại tệp quá trần trước khi gọi tới đây, nên dòng "n tệp đã chọn" nói đúng
  // số tấm thật sự được giữ; mỗi bước vẫn tự kiểm đủ số tối thiểu trước khi gửi.
  const receive = (picked: File[]) => {
    setAccepted(picked);
    onFiles(picked);
  };
  const accept = "image/jpeg,image/png,application/pdf";
  const idle = "Chọn ảnh hoặc tài liệu (JPEG · PNG · PDF)";
  const buttonLabel = accepted.length ? "Chọn lại" : "Chọn tệp";
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <Label required={required} style={secondary}>
        {label}
      </Label>
      {hint ? <span style={secondary}>{hint}</span> : null}
      {multiple ? (
        <FileDropField
          accept={accept}
          multiple
          compact
          pending={pending}
          pendingLabel={pendingLabel}
          idle={idle}
          selected={
            accepted.length
              ? `${accepted.length} tệp đã chọn · ${formatFileSize(totalBytes)}`
              : undefined
          }
          buttonLabel={buttonLabel}
          onFiles={receive}
        />
      ) : (
        <FileDropField
          accept={accept}
          compact
          pending={pending}
          pendingLabel={pendingLabel}
          idle={idle}
          selected={accepted.length ? `Đã chọn 1 tệp · ${formatFileSize(totalBytes)}` : undefined}
          buttonLabel={buttonLabel}
          onFile={(file) => receive([file])}
        />
      )}
    </div>
  );
}
