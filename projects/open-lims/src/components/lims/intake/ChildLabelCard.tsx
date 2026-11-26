import { Button, Dropdown, Field, Input, Option } from "@fluentui/react-components";
import { PrintRegular } from "@fluentui/react-icons";
import { useState } from "react";
import { LabelSticker } from "@/components/lims/intake/LabelSticker";
import { FieldLabel } from "@/components/lims/common";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";
import type { SplitSampleResult } from "@/features/reception/types";

type ChildLabelType = "SUB_SAMPLE" | "ANALYSIS_TASK";

const labelNames: Record<ChildLabelType, string> = {
  SUB_SAMPLE: "Tem mẫu con",
  ANALYSIS_TASK: "Tem công việc phân tích",
};

/* S-08 · Tem mẫu con và tem task in thẳng từ trình duyệt như tem mã cha, không đi qua print job. */
export function ChildLabelCard({
  title,
  result,
  disabled,
  only,
}: {
  title: string;
  result?: SplitSampleResult;
  disabled?: boolean;
  /** Khoá thẻ vào đúng một loại tem: quầy một cửa chỉ in tem mẫu con, lab chỉ in tem task.
   *  Bỏ trống thì người dùng tự chọn loại tem. */
  only?: ChildLabelType;
}) {
  const [picked, setPicked] = useState<ChildLabelType>("SUB_SAMPLE");
  const labelType = only ?? picked;
  const [copies, setCopies] = useState("1");
  const count = Number.parseInt(copies, 10);
  const validCopies = Number.isInteger(count) && count > 0 && count <= 50;

  const stickers =
    labelType === "SUB_SAMPLE"
      ? (result?.subSamples ?? []).map((sample) => ({
          code: sample.code,
          caption: `Mẫu con #${sample.index}`,
        }))
      : (result?.analysisTasks ?? []).map((task) => ({
          code: task.code,
          caption: `${task.subSampleCode} · ${task.parameterCode}`,
        }));
  const printable = validCopies && stickers.length > 0 && !disabled;

  return (
    <div style={{ ...card, gap: 20 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={sectionTitle}>{title}</div>
        <span style={hintText}>
          Quét QR để tra mã mẫu con hoặc mã công việc phân tích. Bấm «In tem» là trình duyệt in ngay
          toàn bộ tem xem trước bên dưới - không tạo lệnh in và không có trạng thái chờ. Tem không
          chứa tên khách hàng.
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: only ? "120px auto 1fr" : "minmax(200px,1fr) 120px auto",
          gap: 16,
          alignItems: "end",
        }}
      >
        {only ? null : (
          <Field label="Loại tem">
            <Dropdown
              value={labelNames[labelType]}
              selectedOptions={[labelType]}
              disabled={disabled}
              onOptionSelect={(_, data) => setPicked(data.optionValue as ChildLabelType)}
            >
              {(Object.keys(labelNames) as ChildLabelType[]).map((type) => (
                <Option key={type} value={type}>
                  {labelNames[type]}
                </Option>
              ))}
            </Dropdown>
          </Field>
        )}
        <Field
          label={<FieldLabel label="Số bản mỗi mã" />}
          validationState={validCopies ? "none" : "error"}
          validationMessage={validCopies ? undefined : "Nhập số nguyên từ 1 đến 50."}
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
          disabled={!printable}
          onClick={() => window.print()}
        >
          In tem
        </Button>
      </div>

      <span style={hintText}>
        {stickers.length === 0
          ? labelType === "SUB_SAMPLE"
            ? "Chưa có mã mẫu con để in - hãy chốt số mẫu thực nhận trước."
            : "Chưa có tem task để in - hãy xác nhận đã nhận mẫu trước."
          : `${stickers.length} mã × ${validCopies ? count : 0} bản = ${
              validCopies ? stickers.length * count : 0
            } tem.`}
      </span>

      {/* Danh sách mã có thể dài (mỗi mẫu con một tem): cuộn trong thẻ thay vì kéo dài trang. */}
      <div
        style={{ display: "flex", gap: 16, flexWrap: "wrap", maxHeight: 360, overflowY: "auto" }}
      >
        {stickers.map((sticker) => (
          <LabelSticker key={sticker.code} code={sticker.code} caption={sticker.caption} />
        ))}
      </div>

      {/* Chỉ hiện khi in: mỗi mã đúng số bản đã chọn, phần còn lại của trang bị ẩn. */}
      <div className="dlp-print-area" aria-hidden="true">
        {validCopies
          ? stickers.flatMap((sticker) =>
              Array.from({ length: count }, (_, index) => (
                <LabelSticker
                  key={`${sticker.code}-${index}`}
                  code={sticker.code}
                  caption={sticker.caption}
                />
              )),
            )
          : null}
      </div>
    </div>
  );
}
