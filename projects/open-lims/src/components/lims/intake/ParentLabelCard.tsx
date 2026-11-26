import { Button, Field, Input } from "@fluentui/react-components";
import { PrintRegular } from "@fluentui/react-icons";
import { useState } from "react";
import { LabelSticker } from "@/components/lims/intake/LabelSticker";
import { FieldLabel } from "@/components/lims/common";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";

/* S-08 · Tem mã cha in thẳng từ trình duyệt để dán lên mẫu, không đi qua print job. */
export function ParentLabelCard({
  title,
  requestCode,
  productName,
  disabled,
}: {
  title: string;
  requestCode: string;
  productName?: string;
  disabled?: boolean;
}) {
  const [copies, setCopies] = useState("1");
  const count = Number.parseInt(copies, 10);
  const valid = Number.isInteger(count) && count > 0 && count <= 50;

  return (
    <div style={card}>
      <div style={sectionTitle}>{title}</div>
      <span style={hintText}>
        Quét QR để tra mã cha. Bấm «In tem» là trình duyệt in ngay bản xem trước bên dưới, dán thẳng
        lên mẫu - không tạo lệnh in và không có trạng thái chờ. Tem không chứa tên khách hàng.
      </span>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
        <LabelSticker code={requestCode} caption={productName} />
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 220 }}>
          <Field
            label={<FieldLabel label="Số bản" />}
            validationState={valid ? "none" : "error"}
            validationMessage={valid ? undefined : "Nhập số nguyên từ 1 đến 50."}
          >
            <Input
              inputMode="numeric"
              value={copies}
              disabled={disabled}
              onChange={(_, data) => setCopies(data.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Button
            appearance="primary"
            icon={<PrintRegular />}
            disabled={disabled || !valid}
            onClick={() => window.print()}
          >
            In tem
          </Button>
        </div>
      </div>

      {/* Chỉ hiện khi in: đúng số bản đã chọn, các phần còn lại của trang bị ẩn. */}
      <div className="dlp-print-area" aria-hidden="true">
        {valid
          ? Array.from({ length: count }, (_, index) => (
              <LabelSticker key={index} code={requestCode} caption={productName} />
            ))
          : null}
      </div>
    </div>
  );
}
