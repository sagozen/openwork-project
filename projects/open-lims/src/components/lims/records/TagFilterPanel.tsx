import { Badge, Button, Checkbox, Radio, SearchBox, Tooltip } from "@fluentui/react-components";
import { useMemo, useState } from "react";
import { TAG_GROUP_ORDER, type TagDef } from "@/lib/admin/records-view-data";
import { EmptyState } from "@/components/lims/common/EmptyState";
import { toneToColor } from "@/lib/admin/tone";
import type { RecordsView } from "@/lib/admin/records-view-state";

export function TagFilterPanel({
  view,
  tags,
  onClose,
}: {
  view: RecordsView;
  /** Danh mục nhãn để chọn: dữ liệu mẫu hoặc nhãn dựng từ hồ sơ máy chủ trả về. */
  tags: TagDef[];
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const nq = q.trim().toLowerCase();
    const matched = tags.filter((t: TagDef) => !nq || t.name.toLowerCase().includes(nq));
    const names = [...new Set(matched.map((t) => t.group))].sort((a, b) => {
      const ia = TAG_GROUP_ORDER.indexOf(a);
      const ib = TAG_GROUP_ORDER.indexOf(b);
      return (ia < 0 ? TAG_GROUP_ORDER.length : ia) - (ib < 0 ? TAG_GROUP_ORDER.length : ib);
    });
    return names.map((group) => ({ group, items: matched.filter((t) => t.group === group) }));
  }, [q, tags]);

  const modes: { id: "any" | "all" | "none"; label: string }[] = [
    { id: "any", label: "có ít nhất một nhãn đã chọn" },
    { id: "all", label: "có đủ tất cả nhãn đã chọn" },
    { id: "none", label: "không có nhãn nào đã chọn" },
  ];

  return (
    <>
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <SearchBox
          value={q}
          onChange={(_, d) => setQ(d.value)}
          placeholder="Tìm nhãn…"
          aria-label="Tìm nhãn"
        />
        <span className="dlp-label">Hiển thị phiếu…</span>
        {modes.map((m) => (
          <label
            key={m.id}
            style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          >
            <Radio
              checked={view.state.tagMode === m.id}
              onChange={() => view.patch({ tagMode: m.id })}
              label={m.label}
            />
          </label>
        ))}
      </div>

      <div style={{ maxHeight: 320, overflow: "auto", padding: "6px 0" }}>
        {groups.length === 0 ? (
          <EmptyState
            title="Chưa có nhãn nào"
            hint="Chưa có nhãn nào khớp từ khoá tìm, hoặc đơn vị chưa khai nhãn nào."
          />
        ) : null}
        {groups.map((g) => (
          <div key={g.group}>
            <div className="dlp-label" style={{ padding: "8px 14px 4px" }}>
              {g.group}
            </div>
            {g.items.map((t) => (
              <div
                key={t.code ?? t.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "5px 14px",
                }}
              >
                <Checkbox
                  checked={view.state.tags.includes(t.code ?? t.name)}
                  onChange={() => view.toggleTag(t.code ?? t.name)}
                  label={
                    <Badge appearance="tint" color={toneToColor(t.color)}>
                      {t.name}
                    </Badge>
                  }
                />
                <div style={{ flex: 1 }} />
                <Tooltip content={`Phạm vi ${t.scope}`} relationship="label">
                  <span className="dlp-datagrid__secondary">{t.count}</span>
                </Tooltip>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          padding: "10px 14px",
          display: "flex",
          gap: 8,
        }}
      >
        <Button size="small" onClick={() => view.patch({ tags: [] })}>
          Bỏ chọn
        </Button>
        <div style={{ flex: 1 }} />
        <Button size="small" appearance="primary" onClick={onClose}>
          Áp dụng
        </Button>
      </div>
    </>
  );
}
