import { Badge, Button, Checkbox } from "@fluentui/react-components";
import { toneToColor } from "@/lib/admin/tone";
import { hintText } from "@/components/lims/request-styles";
import type { ChangeRequest } from "@/lib/admin/intake-data";

export type CrDecision = "wait" | "ok" | "no";

const DECISION_TEXT: Record<CrDecision, { label: string; tone: string }> = {
  wait: { label: "Chờ duyệt", tone: "warning" },
  ok: { label: "Đã duyệt", tone: "success" },
  no: { label: "Từ chối", tone: "danger" },
};

/* S-06 nhúng trong S-07 · Duyệt đề nghị sửa thông tin hiện trường (D02). */
export function ChangeRequestCard({
  cr,
  picked,
  decision,
  disabled,
  onToggleField,
  onApprove,
  onReject,
  readOnly = false,
}: {
  cr: ChangeRequest;
  picked: string[];
  decision: CrDecision;
  disabled?: boolean;
  onToggleField: (field: string) => void;
  onApprove: () => void;
  onReject: () => void;
  readOnly?: boolean;
}) {
  const done = decision !== "wait";
  const st = DECISION_TEXT[decision];

  return (
    <div
      style={{
        background: "var(--background-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-surface)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="dlp-num" style={{ font: "600 16px/22px var(--font-family-base)" }}>
          {cr.title}
        </span>
        <Badge appearance="tint" size="small" color={toneToColor(st.tone)}>
          {st.label}
        </Badge>
        <div style={{ flex: 1 }} />
        <span style={hintText}>{cr.who}</span>
      </div>

      <table className="dlp-datagrid dlp-datagrid--small" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th style={{ width: 36 }} aria-label="Chọn" />
            <th style={{ width: 150 }}>Trường</th>
            <th style={{ width: 170 }}>Giá trị khai báo</th>
            <th style={{ width: 170 }}>Giá trị đề nghị</th>
            <th>Quyết định</th>
          </tr>
        </thead>
        <tbody>
          {cr.fields.map((f) => {
            const on = picked.includes(f.field);
            const tone = done ? (decision === "ok" && on ? "success" : "danger") : "warning";
            const label = done
              ? decision === "ok" && on
                ? "Đã áp dụng"
                : "Không áp dụng"
              : on
                ? "Sẽ áp dụng"
                : "Bỏ qua";
            return (
              <tr key={f.field}>
                <td>
                  <Checkbox
                    checked={on}
                    disabled={disabled || done || readOnly}
                    aria-label={f.field}
                    onChange={() => onToggleField(f.field)}
                  />
                </td>
                <td>{f.field}</td>
                <td
                  className="dlp-datagrid__secondary dlp-num"
                  style={{ textDecoration: "line-through" }}
                >
                  {f.oldValue}
                </td>
                <td className="dlp-num" style={{ fontWeight: 600 }}>
                  {f.newValue}
                </td>
                <td>
                  <Badge appearance="tint" size="small" color={toneToColor(tone)}>
                    {label}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div
        style={{
          background: "var(--background-subtle)",
          borderRadius: "var(--radius-control)",
          padding: 12,
          font: "14px/20px var(--font-family-base)",
        }}
      >
        <span style={{ color: "var(--foreground-secondary)" }}>Lý do: </span>
        {cr.reason}
      </div>

      {readOnly ? (
        <span style={hintText}>
          Đề nghị được trả inline từ chi tiết tiếp nhận. Việc duyệt thuộc luồng lấy mẫu.
        </span>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button
            appearance="primary"
            disabled={disabled || done || picked.length === 0}
            onClick={onApprove}
          >
            Duyệt {picked.length} thay đổi đã chọn
          </Button>
          <Button appearance="outline" disabled={disabled || done} onClick={onReject}>
            Từ chối đề nghị
          </Button>
          <span style={{ ...hintText, alignSelf: "center" }}>
            Thay đổi được duyệt sẽ ghi đè BM01 và lưu vết người duyệt.
          </span>
        </div>
      )}
    </div>
  );
}
