import { Button, Tag } from "@fluentui/react-components";

export interface FilterChip {
  label: string;
  remove: () => void;
}

/* Dải chip điều kiện đang lọc + nút xoá tất cả. */
export function FilterChips({
  chips,
  onClearAll,
  prefix = "Đang lọc:",
}: {
  chips: FilterChip[];
  onClearAll: () => void;
  prefix?: string;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="dlp-chiprow dlp-filterchips">
      <span className="dlp-datagrid__secondary">{prefix}</span>
      {chips.map((c) => (
        <Tag
          key={c.label}
          dismissible
          dismissIcon={{ onClick: c.remove, "aria-label": `Bỏ ${c.label}` }}
        >
          {c.label}
        </Tag>
      ))}
      <Button appearance="transparent" size="small" onClick={onClearAll}>
        Xoá tất cả
      </Button>
    </div>
  );
}
