import { Badge, Button } from "@fluentui/react-components";
import { ChevronDown20Regular, ChevronUp20Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { toneToColor } from "@/lib/admin/tone";
import type { Tone } from "@/lib/admin/records-data";

export interface StatItem {
  label: string;
  value: number | string;
  hint?: string;
  tone: Tone;
  /** Có hành động thì thẻ thành nút lọc. Thẻ đếm một nhóm hồ sơ mà không mở được nhóm đó ra là
   *  một con số hứa suông; màn nào biết cách lọc theo nhóm của mình thì truyền vào đây. */
  onSelect?: () => void;
  /** Bộ lọc hiện tại đang đúng bằng nhóm của thẻ này. */
  selected?: boolean;
}

function valueColor(tone: Tone) {
  if (tone === "danger") return "var(--status-danger-foreground)";
  if (tone === "warning") return "var(--status-warning-foreground)";
  return "var(--foreground-primary)";
}

/* Dải KPI thu gọn/mở dùng chung cho các màn danh sách. */
export function StatStrip({
  items,
  title = "Tổng quan",
  defaultCollapsed = false,
}: {
  items: StatItem[];
  title?: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <section className="dlp-statstrip" aria-label={title}>
      <div className="dlp-statstrip__head">
        <Button
          appearance="subtle"
          size="small"
          icon={collapsed ? <ChevronDown20Regular /> : <ChevronUp20Regular />}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {title}
        </Button>
        {collapsed ? (
          <div className="dlp-chiprow">
            {items.map((s) => (
              <Badge
                key={s.label}
                size="small"
                appearance={s.tone === "warning" || s.tone === "danger" ? "tint" : "outline"}
                color={
                  s.tone === "warning" || s.tone === "danger" ? toneToColor(s.tone) : "informative"
                }
              >
                {s.label} {s.value}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      {collapsed ? null : (
        <div className="dlp-statgrid">
          {items.map((s) => {
            const body = (
              <>
                <div className="dlp-statcard__row">
                  <span
                    className="dlp-num dlp-statcard__value"
                    style={{ color: valueColor(s.tone) }}
                  >
                    {s.value}
                  </span>
                  <span className="dlp-datagrid__secondary dlp-truncate">{s.label}</span>
                </div>
                {s.hint ? (
                  <div className="dlp-datagrid__secondary dlp-truncate">{s.hint}</div>
                ) : null}
              </>
            );
            return s.onSelect ? (
              <button
                key={s.label}
                type="button"
                className="dlp-card dlp-statcard"
                aria-pressed={s.selected ?? false}
                onClick={s.onSelect}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  font: "inherit",
                  color: "inherit",
                  outline: s.selected ? "2px solid var(--colorBrandStroke1)" : undefined,
                }}
              >
                {body}
              </button>
            ) : (
              <div key={s.label} className="dlp-card dlp-statcard">
                {body}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
