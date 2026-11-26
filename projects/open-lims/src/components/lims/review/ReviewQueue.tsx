import { Badge, Button } from "@fluentui/react-components";
import { toneToColor } from "@/lib/admin/tone";
import {
  reviewStateLabel,
  reviewStateTone,
  type ReviewItem,
  type ReviewState,
} from "@/lib/admin/review-data";

/* S-17 · Cột trái: hàng chờ kiểm tra kỹ thuật, có xác nhận nhanh (D24). */
export function ReviewQueue({
  items,
  states,
  picked,
  canWrite,
  onPick,
  onQuick,
}: {
  items: ReviewItem[];
  states: Record<string, ReviewState>;
  picked: string;
  canWrite: boolean;
  onPick: (id: string) => void;
  onQuick: (id: string) => void;
}) {
  return (
    <div
      className="dlp-pane"
      style={{
        flex: "1 1 420px",
        minWidth: 0,
        background: "var(--background-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-surface)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          font: "600 16px/22px var(--font-family-base)",
        }}
      >
        Hàng chờ kiểm tra
      </div>

      {items.map((k) => {
        const st = states[k.id] ?? "wait";
        return (
          <div
            key={k.id}
            role="button"
            tabIndex={0}
            className="dlp-labelrow dlp-rowgrid"
            onClick={() => onPick(k.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onPick(k.id);
            }}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,1fr) 140px 150px",
              gap: 12,
              alignItems: "center",
              padding: "14px 16px",
              borderBottom: "1px solid var(--border-subtle)",
              cursor: "pointer",
              background: picked === k.id ? "var(--background-selected)" : "transparent",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ font: "600 14px/20px var(--font-family-base)" }}>{k.task}</div>
              <div className="dlp-datagrid__secondary dlp-truncate">{k.sub}</div>
            </div>
            <Badge appearance="tint" size="small" color={toneToColor(reviewStateTone(st))}>
              {reviewStateLabel(st)}
            </Badge>
            <Button
              size="small"
              disabled={st !== "wait" || !canWrite}
              onClick={(e) => {
                e.stopPropagation();
                onQuick(k.id);
              }}
            >
              {st === "wait" ? "Duyệt kỹ thuật" : "Đã duyệt"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
