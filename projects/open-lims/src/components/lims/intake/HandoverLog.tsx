import { Badge, Spinner } from "@fluentui/react-components";
import { hintText, sectionTitle } from "@/components/lims/request-styles";
import type { HandoverLogEntry } from "@/features/request/types";
import { formatDateTime } from "@/lib/format";

function personLabel(person?: { id: string; fullName?: string }) {
  if (!person) return "—";
  return person.fullName ?? `Mã ${person.id}`;
}

const formatMoment = formatDateTime;

/**
 * Chuỗi giao-nhận của một hồ sơ, đọc từ `GET /test-requests/{code}/handovers`.
 *
 * Đây là nửa còn thiếu của lời hứa in trên màn Bàn giao - «hệ thống ghi người giao, người nhận,
 * thời điểm, không cho sửa thủ công». Hệ thống ghi thật, nhưng trước đây không ai đọc lại được,
 * nên vế «không cho sửa» không kiểm chứng được và một cú bấm lặp không để lại dấu vết nào nhìn
 * thấy. Bảng này làm nhật ký hiện ra ở đúng chỗ người ta sắp ghi thêm vào nó.
 */
export function HandoverLog({
  entries,
  pending,
  emptyHint = "Chưa có lượt giao-nhận nào được ghi cho hồ sơ này.",
}: {
  entries: HandoverLogEntry[] | undefined;
  pending?: boolean;
  emptyHint?: string;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={sectionTitle}>Nhật ký giao - nhận</div>
      {pending ? <Spinner size="tiny" label="Đang tải nhật ký…" /> : null}
      {!pending && (entries?.length ?? 0) === 0 ? <div style={hintText}>{emptyHint}</div> : null}
      {(entries ?? []).map((entry) => (
        <div
          key={entry.handoverId}
          style={{
            display: "grid",
            gap: 4,
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: 8,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Badge appearance="tint">{entry.step.name}</Badge>
            <span className="dlp-num">{formatMoment(entry.performedAt)}</span>
            <span style={hintText}>{entry.scanMethod.name}</span>
          </div>
          {/* Mũi tên đọc là «người giao → người nhận». Dòng nhật ký chỉ ghi «người thao tác» và
              «đối ứng», mà ai giao ai nhận thì tuỳ bước: DELIVER là người thao tác giao đi,
              RECEIVE là người thao tác nhận về. In nguyên thứ tự thao tác-đối ứng cho cả hai
              bước làm chặng nhận đọc thành «lab giao cho một cửa» - ngược hẳn việc vừa xảy ra. */}
          <div>
            {!entry.counterpart
              ? `${entry.step.code === "RECEIVE" ? "Người nhận" : "Người giao"}: ${personLabel(entry.performedBy)}`
              : entry.step.code === "RECEIVE"
                ? `${personLabel(entry.counterpart)} → ${personLabel(entry.performedBy)}`
                : `${personLabel(entry.performedBy)} → ${personLabel(entry.counterpart)}`}
          </div>
          <div style={hintText}>
            Mã đã quét: <span className="dlp-num">{entry.scannedCodes.join(", ") || "—"}</span>
            {entry.note ? ` · ${entry.note}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
