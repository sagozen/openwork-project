import {
  Badge,
  Checkbox,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from "@fluentui/react-components";
import { PII_MASK, recordLabel, type RecordRow } from "@/lib/admin/records-data";
import { EmptyState } from "@/components/lims/common/EmptyState";
import { tagColor } from "@/lib/admin/records-view-data";
import { toneToColor } from "@/lib/admin/tone";
import type { RecordsView } from "@/lib/admin/records-view-state";
import { RecordLink } from "./RecordLink";

export function RecordsTable({ view, canPii }: { view: RecordsView; canPii: boolean }) {
  const cols = view.visibleColumns;
  const rows = view.rows;

  const cell = (r: RecordRow, key: string) => {
    switch (key) {
      case "id":
        return <RecordLink row={r} style={{ color: "var(--foreground-link)", fontWeight: 600 }} />;
      case "tags":
        return r.tags.length === 0 ? (
          <span className="dlp-datagrid__secondary">-</span>
        ) : (
          <span style={{ display: "inline-flex", gap: 4, overflow: "hidden" }}>
            {r.tags.slice(0, 2).map((t) => (
              <Badge
                key={t}
                appearance="tint"
                color={toneToColor(tagColor(t))}
                style={{ cursor: "pointer" }}
                onClick={() => view.toggleTag(t)}
              >
                {t}
              </Badge>
            ))}
            {r.tags.length > 2 ? (
              <Badge appearance="outline" color="informative">
                +{r.tags.length - 2}
              </Badge>
            ) : null}
          </span>
        );
      case "status":
        return (
          <Badge appearance="tint" color={toneToColor(r.statusTone)}>
            {r.status}
          </Badge>
        );
      case "pay":
        return (
          <Badge appearance="tint" color={toneToColor(r.payTone)}>
            {r.pay}
          </Badge>
        );
      case "customer":
        return canPii ? r.customer : <em>{PII_MASK}</em>;
      default:
        return (r as unknown as Record<string, string>)[key] ?? "-";
    }
  };

  return (
    <>
      {/* Bảng - từ tablet trở lên */}
      <div className="dlp-card dlp-nophone" style={{ overflowX: "auto" }}>
        <table
          className={`dlp-datagrid dlp-datagrid--${view.state.density}`}
          style={{ minWidth: 900, tableLayout: "fixed", width: "100%" }}
        >
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <Checkbox
                  checked={rows.length > 0 && view.selected.length === rows.length}
                  onChange={() => view.toggleAllRows()}
                  aria-label="Chọn tất cả"
                />
              </th>
              {cols.map((c) => (
                <th key={c.key} style={{ width: c.w }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.label}
                    </span>
                    {view.state.pinned.includes(c.key) ? (
                      <span style={{ fontSize: 10, color: "var(--foreground-brand)" }}>Ghim</span>
                    ) : null}
                    <div style={{ flex: 1 }} />
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <MenuButton
                          appearance="transparent"
                          size="small"
                          aria-label={`Tuỳ chọn cột ${c.label}`}
                        />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          <MenuItem onClick={() => view.togglePin(c.key)}>
                            {view.state.pinned.includes(c.key) ? "Bỏ ghim cột" : "Ghim cột"}
                          </MenuItem>
                          <MenuItem
                            disabled={c.locked === true}
                            onClick={() => view.toggleColumn(c.key)}
                          >
                            Ẩn cột
                          </MenuItem>
                          <MenuItem onClick={() => view.moveColumn(c.key, -1)}>
                            Chuyển sang trái
                          </MenuItem>
                          <MenuItem onClick={() => view.moveColumn(c.key, 1)}>
                            Chuyển sang phải
                          </MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={view.selected.includes(r.id) ? "dlp-row--selected" : undefined}
              >
                <td>
                  <Checkbox
                    checked={view.selected.includes(r.id)}
                    onChange={() => view.toggleRow(r.id)}
                    aria-label={`Chọn ${recordLabel(r)}`}
                  />
                </td>
                {cols.map((c) => (
                  <td key={c.key} className={c.key === "id" ? "dlp-num" : undefined}>
                    <span
                      style={{
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {cell(r, c.key)}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={cols.length + 1} style={{ padding: 0 }}>
                  <EmptyState
                    title="Không có hồ sơ nào khớp bộ lọc"
                    hint="Thử bỏ bớt nhãn hoặc điều kiện lọc đang áp dụng."
                    actionLabel="Xoá bộ lọc"
                    onAction={view.clearAllFilters}
                  />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <div
          style={{
            display: "flex",
            gap: 12,
            padding: "10px 16px",
            borderTop: "1px solid var(--border-subtle)",
            color: "var(--foreground-secondary)",
            fontSize: "var(--font-size-200)",
          }}
        >
          <span>{rows.length} dòng</span>
          <div style={{ flex: 1 }} />
          {view.selected.length ? <span>Đã chọn {view.selected.length}</span> : null}
        </div>
      </div>

      {/* Thẻ - điện thoại */}
      <div className="dlp-onlyphone" style={{ flexDirection: "column", gap: 10 }}>
        {rows.length === 0 ? (
          <EmptyState
            title="Không có hồ sơ nào khớp bộ lọc"
            actionLabel="Xoá bộ lọc"
            onAction={view.clearAllFilters}
          />
        ) : null}
        {rows.map((r) => (
          <div key={r.id} className="dlp-card" style={{ padding: 14, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <RecordLink
                row={r}
                className="dlp-num"
                style={{ fontWeight: 600, color: "var(--foreground-link)" }}
              />
              <div style={{ flex: 1 }} />
              <Checkbox
                checked={view.selected.includes(r.id)}
                onChange={() => view.toggleRow(r.id)}
                aria-label={`Chọn ${recordLabel(r)}`}
              />
            </div>
            <div title={r.productTooltip}>{r.product}</div>
            <div className="dlp-datagrid__secondary">{canPii ? r.customer : PII_MASK}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Badge appearance="tint" color={toneToColor(r.statusTone)}>
                {r.status}
              </Badge>
              <Badge appearance="tint" color={toneToColor(r.payTone)}>
                {r.pay}
              </Badge>
              {r.tags.map((t) => (
                <Badge key={t} appearance="tint" color={toneToColor(tagColor(t))}>
                  {t}
                </Badge>
              ))}
            </div>
            <div className="dlp-datagrid__secondary">Hạn trả {r.due}</div>
          </div>
        ))}
      </div>
    </>
  );
}
