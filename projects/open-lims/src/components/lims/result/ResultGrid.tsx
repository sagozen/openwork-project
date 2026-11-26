import { useEffect, useState } from "react";
import {
  Button,
  Dropdown,
  Field,
  Input,
  Option,
  Radio,
  Tab,
  TabList,
  Textarea,
} from "@fluentui/react-components";
import { Add20Regular } from "@fluentui/react-icons";
import { FieldLabel } from "@/components/lims/common";
import { MAX_RAW_RESULTS_PER_TASK, TEST_PART_NAMES } from "@/features/lab";
import {
  RESULT_VALUE_NAMES,
  type SampleResultSet,
  type SampleRawInput,
  type SampleParameter,
  type ValueType,
} from "@/features/sample/sample-api";
import { formatDateTime } from "@/lib/format";

const partName = (part: string) => TEST_PART_NAMES[part as keyof typeof TEST_PART_NAMES] ?? part;

interface Props {
  sets: SampleResultSet[];
  activePart: string;
  unit: string;
  onUnit: (unit: string) => void;
  sampleCode: string;
  parameter: SampleParameter;
  disabled: boolean;
  busy: boolean;
  onPart: (part: string) => void;
  onAddRaw: (input: SampleRawInput) => Promise<void>;
  onSelectFinal: (testPart: string, rawResultId: string, comment?: string) => Promise<void>;
}

export function ResultGrid({
  sets,
  activePart,
  unit,
  onUnit,
  sampleCode,
  parameter,
  disabled,
  busy,
  onPart,
  onAddRaw,
  onSelectFinal,
}: Props) {
  const active = sets.find((set) => set.testPart === activePart) ?? sets[0];
  const [adding, setAdding] = useState(false);
  const allowedTypes = parameter.allowedValueTypes ?? [parameter.valueType];
  const [valueType, setValueType] = useState<ValueType>(parameter.valueType);
  const [value, setValue] = useState("");
  const [comment, setComment] = useState("");
  /* Ghi chú theo TỪNG thành phần thử, không phải một ô dùng chung: chuyển tab mà ô giữ nguyên
     nội dung của tab trước thì một cú bấm «Chọn» sẽ gắn chú thích của Vỏ sang Thịt quả, và kết
     quả cuối là thứ đi thẳng lên phiếu trả khách. */
  const [finalComments, setFinalComments] = useState<Partial<Record<string, string>>>({});
  useEffect(() => {
    if (sets.length && !sets.some((set) => set.testPart === activePart)) onPart(sets[0]!.testPart);
  }, [sets, activePart, onPart]);
  if (!active)
    return (
      <div className="dlp-pane" style={{ padding: 20 }}>
        Chỉ tiêu chưa có bộ kết quả.
      </div>
    );
  const measuredHere = active.rawResults;
  const remaining = Math.max(0, MAX_RAW_RESULTS_PER_TASK - active.rawResults.length);
  const finalComment = finalComments[active.testPart] ?? "";
  /* Cùng một luật với `parseRawResultRows` của đường dán Excel ("Trị số phải là số không âm").
     Trước đây chỉ đường dán chặn, nên trị số âm đi lọt qua form nhập từng dòng - mà kết quả gốc
     không sửa cũng không xoá được, nên một lần lọt là nằm lại trong hồ sơ vĩnh viễn. Máy chủ đã
     chặn bằng E-LAB-015; đây là để nói ra trước khi bấm, không phải lớp bảo vệ duy nhất. */
  const numericValue = valueType === "NUMERIC" ? Number(value.trim()) : null;
  const valueError =
    valueType !== "NUMERIC" || !value.trim()
      ? undefined
      : !Number.isFinite(numericValue)
        ? "Trị số phải là một số."
        : numericValue! < 0
          ? "Trị số không được âm."
          : undefined;
  const invalid = !allowedTypes.includes(valueType) || !value.trim() || Boolean(valueError);
  const openForm = () => {
    setValue(
      valueType === "BELOW_LOD" || valueType === "NOT_DETECTED"
        ? "KPH"
        : valueType === "BELOW_LOQ"
          ? "<LOQ"
          : "",
    );
    setAdding(true);
  };
  const save = async () => {
    if (invalid || disabled || busy || remaining === 0) return;
    try {
      await onAddRaw({
        testPart: active.testPart,
        unit: unit,
        valueType,
        value: value.trim(),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
    } catch {
      // The workspace displays the server error; retain this form for correction/retry.
      return;
    }
    setAdding(false);
    setComment("");
    setValue("");
  };

  return (
    <section
      className="dlp-pane"
      style={{
        flex: "2 1 700px",
        minWidth: 0,
        background: "var(--background-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-surface)",
        /* `clip` chứ không phải `hidden`: cả hai cắt phần tràn như nhau, nhưng `hidden` dựng một
           hộp cuộn được - hộp này không có gì để cuộn nên nó nuốt cú lăn chuột thay vì trả về cho
           trang. Trỏ chuột vào bảng rồi lăn thì trang đứng im, trông y như treo. */
        overflow: "clip",
      }}
    >
      <div style={{ padding: "12px 16px 0" }}>
        <TabList
          selectedValue={active.testPart}
          onTabSelect={(_, data) => onPart(data.value as string)}
        >
          {sets.map((set) => (
            <Tab key={set.testPart} value={set.testPart} disabled={busy}>
              {partName(set.testPart)} · {set.testPart}
              {set.finalResult?.rawResultId ? " · đã chốt" : " · chưa chốt"}
            </Tab>
          ))}
        </TabList>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table
          className="dlp-datagrid dlp-datagrid--medium"
          style={{ width: "100%", minWidth: 760 }}
        >
          <thead>
            <tr>
              <th>Kết quả cuối</th>
              <th>Thời gian nhập</th>
              <th>Loại trị số</th>
              <th>Trị số</th>
              <th>Đơn vị</th>
              <th>Ghi chú / người nhập</th>
            </tr>
          </thead>
          <tbody>
            {active.rawResults.map((result) => (
              <tr key={result.id}>
                <td>
                  <Radio
                    checked={active.finalResult?.rawResultId === result.id}
                    label="Chọn"
                    disabled={disabled || busy}
                    onChange={() =>
                      void onSelectFinal(
                        active.testPart,
                        result.id,
                        finalComment.trim() || undefined,
                      ).catch(() => {})
                    }
                  />
                </td>
                <td className="dlp-num">{formatDateTime(result.enteredAt ?? result.measuredAt)}</td>
                <td>{result.valueType ? RESULT_VALUE_NAMES[result.valueType] : "-"}</td>
                <td className="dlp-num">{result.value ?? "Không có quyền xem trị số"}</td>
                <td>{result.unit ?? unit}</td>
                <td>
                  {result.comment ?? "-"}
                  <div className="dlp-datagrid__secondary">{result.enteredBy}</div>
                </td>
              </tr>
            ))}
            {!active.rawResults.length ? (
              <tr>
                <td colSpan={6}>Chưa có kết quả gốc cho thành phần này.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div
        style={{
          padding: 16,
          borderTop: "1px solid var(--border-subtle)",
          display: "grid",
          gap: 12,
        }}
      >
        <Field
          label={
            <FieldLabel
              label={`Ghi chú khi chọn kết quả cuối · ${partName(active.testPart)}`}
              tooltip="Ghi chú riêng cho thành phần này. Lựa chọn chỉ trỏ tới một kết quả gốc trong bộ; gọi lại sẽ thay lựa chọn cũ."
            />
          }
        >
          <Textarea
            rows={2}
            disabled={disabled || busy}
            value={finalComment}
            onChange={(_, data) =>
              setFinalComments((current) => ({ ...current, [active.testPart]: data.value }))
            }
          />
        </Field>
        {adding ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
              columnGap: 16,
              rowGap: 14,
              alignItems: "start",
            }}
          >
            <Field label="Loại trị số" required style={{ minWidth: 0 }}>
              <Dropdown
                style={{ minWidth: 0 }}
                disabled={disabled || busy}
                value={RESULT_VALUE_NAMES[valueType]}
                selectedOptions={[valueType]}
                onOptionSelect={(_, data) => {
                  const type = data.optionValue as ValueType;
                  setValueType(type);
                  setValue(
                    type === "BELOW_LOD" || type === "NOT_DETECTED"
                      ? "KPH"
                      : type === "BELOW_LOQ"
                        ? "<LOQ"
                        : "",
                  );
                }}
              >
                {allowedTypes.map((type) => (
                  <Option key={type} value={type}>
                    {RESULT_VALUE_NAMES[type]}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field
              label="Trị số đo"
              required
              style={{ minWidth: 0 }}
              validationState={valueError ? "error" : "none"}
              validationMessage={valueError}
            >
              {valueType === "CATALOG_CHOICE" ? (
                <Dropdown
                  style={{ minWidth: 0 }}
                  disabled={disabled || busy}
                  value={value}
                  selectedOptions={value ? [value] : []}
                  placeholder="Chọn trị số"
                  onOptionSelect={(_, data) => setValue(data.optionValue ?? "")}
                >
                  {parameter.catalogChoices.map((item) => (
                    <Option key={item} value={item}>
                      {item}
                    </Option>
                  ))}
                </Dropdown>
              ) : (
                <Input
                  value={value}
                  disabled={disabled || busy}
                  readOnly={["BELOW_LOD", "BELOW_LOQ", "NOT_DETECTED"].includes(valueType)}
                  placeholder={valueType === "NUMERIC" ? "0.012" : "KPH"}
                  onChange={(_, data) => setValue(data.value)}
                />
              )}
            </Field>
            <Field label="Đơn vị kết quả" style={{ minWidth: 0 }}>
              <Dropdown
                style={{ minWidth: 0 }}
                disabled={disabled || busy}
                value={unit || "Không đơn vị"}
                selectedOptions={[unit]}
                onOptionSelect={(_, data) => onUnit(data.optionValue ?? "")}
              >
                {(parameter.allowedUnits.length ? parameter.allowedUnits : [""]).map((item) => (
                  <Option key={item} value={item}>
                    {item || "Không đơn vị"}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Ghi chú kỹ thuật" style={{ minWidth: 0 }}>
              <Input
                disabled={disabled || busy}
                value={comment}
                onChange={(_, data) => setComment(data.value)}
              />
            </Field>
            <div
              style={{
                gridColumn: "1 / -1",
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                justifyContent: "flex-end",
                marginTop: 2,
              }}
            >
              <Button disabled={busy} onClick={() => setAdding(false)}>
                Huỷ
              </Button>
              <Button
                appearance="primary"
                disabled={invalid || disabled || busy || remaining === 0}
                onClick={() => void save()}
              >
                Lưu kết quả gốc
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              icon={<Add20Regular />}
              disabled={disabled || busy || remaining === 0}
              onClick={openForm}
            >
              Thêm kết quả gốc
            </Button>
          </div>
        )}
        <span className="dlp-datagrid__secondary">
          Mẫu {sampleCode} · tối đa {MAX_RAW_RESULTS_PER_TASK} lần đo mỗi thành phần thử. Đã dùng{" "}
          {measuredHere.length}/{MAX_RAW_RESULTS_PER_TASK} · còn {remaining} lần. Kết quả đã lưu
          không sửa hoặc xoá. Kiểu trị số: {RESULT_VALUE_NAMES[valueType]}.
        </span>
      </div>
    </section>
  );
}
