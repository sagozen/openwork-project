import { Badge, Tag } from "@fluentui/react-components";
import { useNavigate } from "@tanstack/react-router";
import { recordLabel } from "@/lib/admin/records-data";
import { BOARD_COLUMNS } from "@/lib/admin/records-view-data";
import { toneToColor } from "@/lib/admin/tone";
import type { RecordsView } from "@/lib/admin/records-view-state";
import { recordNavigateTo } from "./record-route";

export function RecordsBoard({
  view,
  baseColumns = BOARD_COLUMNS,
}: {
  view: RecordsView;
  /** Cột luôn hiển thị dù rỗng. Trạng thái khác có trong dữ liệu được thêm vào cuối. */
  baseColumns?: string[];
}) {
  const navigate = useNavigate();
  const extra = [...new Set(view.rows.map((r) => r.status))].filter(
    (s) => !baseColumns.includes(s),
  );
  const columns = [...baseColumns, ...extra];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: 12,
        alignItems: "start",
      }}
    >
      {columns.map((name) => {
        const cards = view.rows.filter((r) => r.status === name);
        return (
          <div key={name} className="dlp-card" style={{ overflow: "hidden" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 12px",
                borderBottom: "1px solid var(--border-subtle)",
                background: "var(--background-subtle)",
                fontSize: "var(--font-size-200)",
                fontWeight: 600,
              }}
            >
              <span>{name}</span>
              <div style={{ flex: 1 }} />
              <span className="dlp-num" style={{ color: "var(--foreground-secondary)" }}>
                {cards.length}
              </span>
            </div>
            <div style={{ display: "grid", gap: 8, padding: 10 }}>
              {cards.map((c) => (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  className="dlp-boardcard"
                  onClick={() => void navigate(recordNavigateTo(c))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void navigate(recordNavigateTo(c));
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span className="dlp-num" style={{ fontWeight: 600 }}>
                      {recordLabel(c)}
                    </span>
                    <div style={{ flex: 1 }} />
                    <span className="dlp-datagrid__secondary">{c.due}</span>
                  </div>
                  <div
                    className="dlp-datagrid__secondary"
                    style={{ margin: "2px 0 8px" }}
                    title={c.productTooltip}
                  >
                    {c.product} · {c.handler}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Tag size="small" dismissible={false}>
                      {c.criteria}
                    </Tag>
                    <Badge appearance="tint" color={toneToColor(c.payTone)}>
                      {c.pay}
                    </Badge>
                  </div>
                </div>
              ))}
              {cards.length === 0 ? (
                <span className="dlp-datagrid__secondary" style={{ padding: "8px 2px" }}>
                  Không có phiếu.
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
