import { Badge, Button, Tag } from "@fluentui/react-components";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toWorklistItems, WORKLIST_FILTERS } from "@/lib/admin/records-view-data";
import type { Tone } from "@/lib/admin/records-data";
import { toneToColor } from "@/lib/admin/tone";
import { EmptyState } from "@/components/lims/common/EmptyState";
import type { RecordsView } from "@/lib/admin/records-view-state";
import { recordNavigateTo } from "./record-route";

export interface WorklistPanels {
  notifs: { text: string; time: string }[];
  queue: { name: string; state: string; tone: Tone; hint: string }[];
  /** Hiện khi màn đang chạy dữ liệu thật mà backend chưa có nguồn cho hai khối bên phải. */
  unavailableNote?: string;
}

export function RecordsWorklist({
  view,
  canPii,
  panels,
}: {
  view: RecordsView;
  canPii: boolean;
  panels: WorklistPanels;
}) {
  const [filter, setFilter] = useState("Tất cả");
  const navigate = useNavigate();
  const items = toWorklistItems(view.rows, canPii).filter(
    (w) => filter === "Tất cả" || w.bucket === filter,
  );
  const note = panels.unavailableNote;

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div className="dlp-card dlp-pane" style={{ flex: "2 1 560px", overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 16px",
            borderBottom: "1px solid var(--border-subtle)",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: "var(--font-size-400)" }}>
            Việc cần làm hôm nay
          </span>
          <Badge appearance="tint" color="brand">
            {items.length}
          </Badge>
          <div style={{ flex: 1 }} />
          <div className="dlp-chiprow">
            {WORKLIST_FILTERS.map((f) => (
              <Tag
                key={f}
                role="button"
                tabIndex={0}
                dismissible={false}
                appearance="outline"
                className={`dlp-clickable ${filter === f ? "dlp-chip--picked" : "dlp-chip--unpicked"}`}
                aria-pressed={filter === f}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setFilter(f);
                }}
                onClick={() => setFilter(f)}
              >
                {f}
              </Tag>
            ))}
          </div>
        </div>
        {items.map((w) => (
          <div
            key={w.row.id}
            className="dlp-rowgrid"
            style={{
              display: "grid",
              gridTemplateColumns: "44px minmax(0,1fr) auto auto auto",
              alignItems: "center",
              gap: 16,
              padding: 16,
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "var(--radius-xlarge)",
                background: "var(--background-subtle)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 600,
                fontSize: "var(--font-size-200)",
                color: "var(--foreground-secondary)",
              }}
            >
              {w.icon}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{w.title}</div>
              <div className="dlp-datagrid__secondary">{w.sub}</div>
            </div>
            <Badge appearance="tint" color={toneToColor(w.tone)}>
              {w.state}
            </Badge>
            <span className="dlp-datagrid__secondary">{w.due}</span>
            <Button size="small" onClick={() => void navigate(recordNavigateTo(w.row))}>
              {w.cta}
            </Button>
          </div>
        ))}
        {items.length === 0 ? (
          <EmptyState
            title="Không có việc nào khớp bộ lọc"
            hint="Đổi bộ lọc phía trên hoặc chọn nhóm việc khác."
            actionLabel="Xem tất cả"
            onAction={() => setFilter("Tất cả")}
          />
        ) : null}
      </div>

      <div className="dlp-pane" style={{ flex: "1 1 280px", display: "grid", gap: 12 }}>
        <div className="dlp-card" style={{ padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Thông báo</div>
          {note && panels.notifs.length === 0 ? (
            <span className="dlp-datagrid__secondary">{note}</span>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {panels.notifs.map((n) => (
                <div key={n.text} style={{ display: "flex", gap: 10 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: "var(--action-primary)",
                      marginTop: 7,
                      flexShrink: 0,
                    }}
                  />
                  <div>
                    <div>{n.text}</div>
                    <div className="dlp-datagrid__secondary">{n.time}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dlp-card" style={{ padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Hàng chờ tác vụ</div>
          {note && panels.queue.length === 0 ? (
            <span className="dlp-datagrid__secondary">{note}</span>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {panels.queue.map((j) => (
                <div key={j.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{j.name}</div>
                    <div className="dlp-datagrid__secondary">{j.hint}</div>
                  </div>
                  <Badge appearance="tint" color={toneToColor(j.tone)}>
                    {j.state}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
