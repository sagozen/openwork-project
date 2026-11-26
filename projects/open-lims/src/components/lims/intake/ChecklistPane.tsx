import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from "@fluentui/react-components";
import type { ChecklistVerdict, ReceptionChecklistItem } from "@/features/reception/types";

export interface ChecklistDraft {
  actualValue: string;
}

const verdictLabels: Record<ChecklistVerdict, string> = {
  MATCH: "Khớp",
  MISMATCH: "Không khớp",
  NOT_APPLICABLE: "Không áp dụng",
};

/* S-08 · Hạng mục và quy tắc luôn đến từ reception detail; client chỉ giữ phần nhập tạm. */
export function ChecklistPane({
  items,
  drafts,
  disabled,
  fieldErrors = {},
  onChange,
}: {
  items: ReceptionChecklistItem[];
  drafts: Record<string, ChecklistDraft>;
  disabled?: boolean;
  fieldErrors?: Record<string, string>;
  onChange: (key: string, value: ChecklistDraft) => void;
}) {
  const done = items.filter((item) => drafts[item.key]?.actualValue.trim()).length;
  const ok = items.length > 0 && done === items.length;
  const canCopyAllDeclared = items.length > 0 && items.every((item) => item.declaredValue?.trim());
  const allMatchDeclared =
    canCopyAllDeclared &&
    items.every((item) => drafts[item.key]?.actualValue === item.declaredValue);

  const copyDeclaredValue = (key: string, declaredValue: string) => {
    onChange(key, { actualValue: declaredValue });
  };

  const copyAllDeclaredValues = () => {
    for (const item of items) {
      if (item.declaredValue?.trim()) copyDeclaredValue(item.key, item.declaredValue);
    }
  };

  return (
    <div
      className="dlp-pane dlp-checklist"
      style={{
        minWidth: 0,
        background: "var(--background-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-surface)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <span style={{ font: "600 16px/22px var(--font-family-base)" }}>Checklist đối chiếu</span>
        <div style={{ flex: 1 }} />
        <span className="dlp-datagrid__secondary">
          Đã nhập thực nhận {done}/{items.length} hạng mục
        </span>
        <Button
          size="small"
          appearance="secondary"
          disabled={disabled || !canCopyAllDeclared || allMatchDeclared}
          onClick={copyAllDeclaredValues}
        >
          Điền tất cả theo khai báo
        </Button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="dlp-datagrid dlp-datagrid--medium" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Hạng mục</th>
              <th style={{ width: 180 }}>Giá trị khai báo</th>
              <th style={{ width: 200 }}>Thực nhận</th>
              <th style={{ width: 180 }}>Kết luận</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const draft = drafts[item.key] ?? {
                actualValue: item.actualValue ?? "",
              };
              const error = fieldErrors[item.key] ?? fieldErrors[`checklist.${item.key}`];
              return (
                <tr key={item.key}>
                  <td>
                    <div>{item.name}</div>
                    <div className="dlp-datagrid__secondary">{item.rule}</div>
                    {item.requiresReasonOnMismatch ? (
                      <div className="dlp-datagrid__secondary">Lệch phải ghi lý do</div>
                    ) : null}
                  </td>
                  <td className="dlp-num">{item.declaredValue}</td>
                  <td>
                    <Field validationState={error ? "error" : "none"} validationMessage={error}>
                      <Input
                        value={draft.actualValue}
                        disabled={disabled}
                        aria-label={`Thực nhận ${item.name}`}
                        onChange={(_, data) =>
                          onChange(item.key, { ...draft, actualValue: data.value })
                        }
                      />
                    </Field>
                    {item.declaredValue?.trim() && draft.actualValue !== item.declaredValue ? (
                      <Button
                        size="small"
                        appearance="transparent"
                        disabled={disabled}
                        aria-label={`Đánh dấu ${item.name} khớp với giá trị khai báo`}
                        onClick={() => copyDeclaredValue(item.key, item.declaredValue!)}
                      >
                        Chép khai báo
                      </Button>
                    ) : null}
                  </td>
                  <td>
                    <span aria-label={`Kết luận do máy chủ tính cho ${item.name}`}>
                      {item.verdict ? verdictLabels[item.verdict] : "Máy chủ sẽ kết luận"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border-subtle)" }}>
        <MessageBar intent={ok ? "success" : "warning"}>
          <MessageBarBody>
            <MessageBarTitle>
              {ok ? "Đã nhập đủ giá trị thực nhận" : "Còn hạng mục chưa nhập thực nhận"}
            </MessageBarTitle>{" "}
            {ok
              ? "Máy chủ sẽ tính và lưu kết luận khi ghi quyết định tiếp nhận."
              : "Chép giá trị khai báo cho các mục khớp; chỉ cần sửa dòng lệch. Máy chủ tự tính kết luận."}
          </MessageBarBody>
        </MessageBar>
      </div>
    </div>
  );
}
