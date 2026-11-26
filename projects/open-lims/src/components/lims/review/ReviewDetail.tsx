import {
  Badge,
  Button,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Textarea,
} from "@fluentui/react-components";
import { toneToColor } from "@/lib/admin/tone";
import { hintText } from "@/components/lims/request-styles";
import { FieldLabel } from "@/components/lims/common";
import {
  REVIEW_DONE_NOTE,
  REVIEW_TRACE_HISTORY,
  TRACE_AUDIT_NOTE,
  TRACE_NOTE_ALLOWED,
  TRACE_NOTE_DENIED,
  reviewStateLabel,
  reviewStateTone,
  type ReviewItem,
  type ReviewState,
} from "@/lib/admin/review-data";

/* S-17 · Cột phải: chi tiết chỉ tiêu, lịch sử lưu vết (D23) và quyết định kỹ thuật. */
export function ReviewDetail({
  item,
  state,
  note,
  canWrite,
  canTrace,
  traceOpen,
  onNote,
  onTrace,
  onAccept,
  onReturn,
}: {
  item: ReviewItem;
  state: ReviewState;
  note: string;
  canWrite: boolean;
  canTrace: boolean;
  traceOpen: boolean;
  onNote: (v: string) => void;
  onTrace: (open: boolean) => void;
  onAccept: () => void;
  onReturn: () => void;
}) {
  const done = state !== "wait";
  const cannotReturn = done || !note.trim() || !canWrite;
  const hint = done
    ? "Chỉ tiêu này đã xử lý - chọn chỉ tiêu khác trong hàng chờ."
    : !note.trim()
      ? "Trả lại bắt buộc có nhận xét kỹ thuật."
      : "Trả lại sẽ tạo phiên bản kết quả mới cho nhân viên lab.";

  return (
    <div
      className="dlp-pane"
      style={{ flex: "2 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}
    >
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
          <span style={{ font: "600 16px/22px var(--font-family-base)" }}>{item.title}</span>
          <Badge appearance="tint" size="small" color={toneToColor(reviewStateTone(state))}>
            {reviewStateLabel(state)}
          </Badge>
          <div style={{ flex: 1 }} />
          <span style={hintText}>{item.version}</span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            background: "var(--background-subtle)",
            borderRadius: "var(--radius-control)",
            padding: "10px 12px",
          }}
        >
          <Badge appearance="tint" color="informative" size="small">
            {item.traceLabel}
          </Badge>
          {canTrace ? (
            <Button size="small" onClick={() => onTrace(true)}>
              Xem lịch sử lưu vết
            </Button>
          ) : null}
          <span style={{ ...hintText, flex: 1, minWidth: 220 }}>
            {canTrace ? TRACE_NOTE_ALLOWED : TRACE_NOTE_DENIED}
          </span>
        </div>

        {traceOpen ? (
          <div
            style={{
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-control)",
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ font: "600 14px/20px var(--font-family-base)" }}>
                Lịch sử lưu vết kết quả
              </span>
              <div style={{ flex: 1 }} />
              <Button appearance="subtle" size="small" onClick={() => onTrace(false)}>
                Đóng
              </Button>
            </div>
            {REVIEW_TRACE_HISTORY.map((th) => (
              <div
                key={th.v}
                className="dlp-rowgrid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0,1fr) 150px",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ font: "14px/20px var(--font-family-base)" }}>
                    {th.v} - {th.why}
                  </div>
                  <div className="dlp-datagrid__secondary">{th.who}</div>
                </div>
                <Badge appearance="tint" size="small" color={toneToColor(th.tone)}>
                  {th.state}
                </Badge>
              </div>
            ))}
            <span style={hintText}>{TRACE_AUDIT_NOTE}</span>
          </div>
        ) : null}

        <table className="dlp-datagrid dlp-datagrid--small" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: 110 }}>Kết quả cuối</th>
              <th style={{ width: 130 }}>Mẫu con</th>
              <th style={{ width: 110 }}>Ngày giờ</th>
              <th style={{ width: 130 }}>Kết quả</th>
              <th>Ghi chú</th>
            </tr>
          </thead>
          <tbody>
            {item.rows.map((r, i) => (
              <tr key={`${r.sub}-${i}`}>
                <td>{r.final}</td>
                <td className="dlp-num">{r.sub}</td>
                <td className="dlp-datagrid__secondary dlp-num">{r.at}</td>
                <td className="dlp-num">{r.value}</td>
                <td className="dlp-datagrid__secondary">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div
          className="dlp-labelgrid"
          style={{
            display: "grid",
            gridTemplateColumns: "150px 1fr",
            gap: "8px 16px",
            font: "14px/20px var(--font-family-base)",
          }}
        >
          {item.meta.map((m) => (
            <div key={m.k} style={{ display: "contents" }}>
              <span style={{ color: "var(--foreground-secondary)" }}>{m.k}</span>
              <span>{m.v}</span>
            </div>
          ))}
        </div>

        <Field
          label={<FieldLabel label="Nhận xét kỹ thuật" tooltip="Bắt buộc khi trả lại kết quả" />}
        >
          <Textarea
            rows={3}
            value={note}
            disabled={done || !canWrite}
            placeholder="Ví dụ: nhầm đơn vị mg/kg ↔ µg/kg"
            onChange={(_, d) => onNote(d.value)}
          />
        </Field>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button appearance="primary" disabled={done || !canWrite} onClick={onAccept}>
            Chấp nhận kết quả
          </Button>
          <Button appearance="outline" disabled={cannotReturn} onClick={onReturn}>
            Trả lại phòng lab
          </Button>
          <span style={{ ...hintText, alignSelf: "center" }}>{hint}</span>
        </div>
      </div>

      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Sau khi mọi chỉ tiêu đạt:</MessageBarTitle>
          {REVIEW_DONE_NOTE}
        </MessageBarBody>
      </MessageBar>
    </div>
  );
}
