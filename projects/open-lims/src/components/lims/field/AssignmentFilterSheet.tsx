import { useEffect, useRef, useState } from "react";
import { Badge, Button, Checkbox } from "@fluentui/react-components";
import { toneToColor } from "@/lib/admin/tone";
import type { SamplingAssignment } from "@/features/sampling";
import { countBy, EMPTY_FILTER, type AssignmentFilter } from "./assignment-filter";

/** Thanh "Nhãn · Bộ lọc" + bottom sheet chọn chỉ tiêu xét nghiệm / trạng thái lượt. */
export function AssignmentFilterSheet({
  items,
  filter,
  onChange,
}: {
  items: SamplingAssignment[];
  filter: AssignmentFilter;
  onChange: (next: AssignmentFilter) => void;
}) {
  const [group, setGroup] = useState<"parameters" | "statuses">();
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const options =
    group === "statuses"
      ? countBy(items, (item) => [
          { key: item.status.code, label: item.status.name, tone: item.status.tone },
        ])
      : countBy(items, (item) =>
          item.testParameters.map((p) => ({ key: p.code, label: p.name || p.code })),
        );
  const picked = group === "statuses" ? filter.statuses : filter.parameters;

  useEffect(() => {
    if (!group) return;
    const dialog = dialogRef.current;
    const focusable = Array.from(
      dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    (focusable[0] ?? dialog)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setGroup(undefined);
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      openerRef.current?.focus();
    };
  }, [group]);

  const toggle = (key: string, on: boolean) => {
    const next = on ? [...picked, key] : picked.filter((value) => value !== key);
    onChange(
      group === "statuses" ? { ...filter, statuses: next } : { ...filter, parameters: next },
    );
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, flex: 1, width: "100%" }}>
        <Button
          size="large"
          style={{ flex: 1 }}
          onClick={(event) => {
            openerRef.current = event.currentTarget;
            setGroup("parameters");
          }}
        >
          {filter.parameters.length ? `Nhãn · ${filter.parameters.length}` : "Nhãn"}
        </Button>
        <Button
          size="large"
          style={{ flex: 1 }}
          onClick={(event) => {
            openerRef.current = event.currentTarget;
            setGroup("statuses");
          }}
        >
          {filter.statuses.length ? `Bộ lọc · ${filter.statuses.length}` : "Bộ lọc"}
        </Button>
      </div>

      {group ? (
        <div
          className="dlp-field__sheet-scrim dlp-field__sheet-scrim--fixed"
          onClick={() => setGroup(undefined)}
        >
          <div
            ref={dialogRef}
            className="dlp-field__sheet"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-label={group === "statuses" ? "Lọc theo trạng thái" : "Lọc theo chỉ tiêu"}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dlp-field__sheet-grip" />
            <div style={{ font: "600 16px/22px var(--font-family-base)" }}>
              {group === "statuses" ? "Lọc theo trạng thái" : "Lọc theo chỉ tiêu xét nghiệm"}
            </div>

            {options.length ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  maxHeight: 220,
                  overflow: "auto",
                }}
              >
                {options.map((option) => (
                  <label
                    key={option.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      minHeight: 44,
                      padding: "0 4px",
                    }}
                  >
                    <Checkbox
                      checked={picked.includes(option.key)}
                      onChange={(_, d) => toggle(option.key, Boolean(d.checked))}
                    />
                    <Badge
                      appearance="tint"
                      size="small"
                      color={option.tone ? toneToColor(option.tone) : "brand"}
                    >
                      {option.label}
                    </Badge>
                    <span style={{ flex: 1 }} />
                    <span
                      style={{
                        color: "var(--foreground-secondary)",
                        fontSize: "var(--font-size-200)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {option.count}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div style={{ color: "var(--foreground-secondary)" }}>
                Danh sách đang tải chưa có dữ liệu để lọc.
              </div>
            )}

            <div style={{ color: "var(--foreground-secondary)", fontSize: "var(--font-size-200)" }}>
              Lọc trong danh sách lượt đang tải.
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <Button size="large" style={{ flex: 1 }} onClick={() => onChange(EMPTY_FILTER)}>
                Bỏ chọn
              </Button>
              <Button
                size="large"
                appearance="primary"
                style={{ flex: 1 }}
                onClick={() => setGroup(undefined)}
              >
                Áp dụng
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
