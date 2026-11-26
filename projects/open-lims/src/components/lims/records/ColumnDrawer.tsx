import {
  Button,
  Checkbox,
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  SearchBox,
  Tag,
} from "@fluentui/react-components";
import {
  ArrowDown20Regular,
  ArrowUp20Regular,
  Dismiss20Regular,
  Pin20Filled,
  Pin20Regular,
} from "@fluentui/react-icons";
import { useState } from "react";
import type { RecordsView } from "@/lib/admin/records-view-state";

export function ColumnDrawer({
  view,
  open,
  onOpenChange,
}: {
  view: RecordsView;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const match = (label: string) => !q.trim() || label.toLowerCase().includes(q.toLowerCase());
  const shown = view.columns.filter((c) => !view.state.hidden.includes(c.key) && match(c.label));
  const hidden = view.hiddenColumns.filter((c) => match(c.label));

  return (
    <Drawer
      type="overlay"
      position="end"
      separator
      open={open}
      onOpenChange={(_, d) => onOpenChange(d.open)}
      style={{ width: 380 }}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Đóng"
              onClick={() => onOpenChange(false)}
            />
          }
        >
          Quản lý cột
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 16 }}>
          <SearchBox
            value={q}
            onChange={(_, d) => setQ(d.value)}
            placeholder="Tìm tên cột…"
            aria-label="Tìm tên cột"
          />

          <div>
            <div className="dlp-label" style={{ marginBottom: 8 }}>
              Mật độ bảng
            </div>
            <div className="dlp-chiprow">
              {(["comfortable", "compact"] as const).map((d) => (
                <Tag
                  key={d}
                  role="button"
                  tabIndex={0}
                  dismissible={false}
                  appearance="outline"
                  className={view.state.density === d ? "dlp-chip--picked" : "dlp-chip--unpicked"}
                  aria-pressed={view.state.density === d}
                  onClick={() => view.patch({ density: d })}
                >
                  {d === "comfortable" ? "Comfortable" : "Compact"}
                </Tag>
              ))}
            </div>
          </div>

          <div>
            <div className="dlp-label" style={{ marginBottom: 8 }}>
              Cột đang hiển thị
            </div>
            {shown.map((c) => (
              <div
                key={c.key}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}
              >
                <Checkbox
                  checked
                  disabled={c.locked}
                  onChange={() => view.toggleColumn(c.key)}
                  label={c.label}
                />
                <div style={{ flex: 1 }} />
                {c.locked ? <span className="dlp-datagrid__secondary">Khoá</span> : null}
                <Button
                  appearance="subtle"
                  size="small"
                  aria-label="Ghim cột"
                  icon={view.state.pinned.includes(c.key) ? <Pin20Filled /> : <Pin20Regular />}
                  onClick={() => view.togglePin(c.key)}
                />
                <Button
                  appearance="subtle"
                  size="small"
                  aria-label="Lên trên"
                  icon={<ArrowUp20Regular />}
                  onClick={() => view.moveColumn(c.key, -1)}
                />
                <Button
                  appearance="subtle"
                  size="small"
                  aria-label="Xuống dưới"
                  icon={<ArrowDown20Regular />}
                  onClick={() => view.moveColumn(c.key, 1)}
                />
              </div>
            ))}
          </div>

          <div>
            <div className="dlp-label" style={{ marginBottom: 8 }}>
              Cột đang ẩn
            </div>
            {hidden.length === 0 ? (
              <span className="dlp-datagrid__secondary">Tất cả cột đang hiển thị.</span>
            ) : (
              hidden.map((c) => (
                <Checkbox
                  key={c.key}
                  checked={false}
                  onChange={() => view.toggleColumn(c.key)}
                  label={c.label}
                />
              ))
            )}
          </div>

          <span className="dlp-datagrid__secondary">
            Cột nằm ngoài phạm vi phân quyền không xuất hiện trong danh sách này. Thiết lập cột đi
            kèm chế độ xem khi bạn lưu lại; thay đổi chưa lưu chỉ nằm trên trình duyệt này.
          </span>
        </div>
      </DrawerBody>
    </Drawer>
  );
}
