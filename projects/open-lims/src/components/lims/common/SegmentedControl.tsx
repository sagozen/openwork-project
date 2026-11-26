import type { ReactElement } from "react";
import { Button, Tooltip } from "@fluentui/react-components";

export interface SegmentedItem<T extends string> {
  id: T;
  label: string;
  icon: ReactElement;
}

/* Nhóm nút chuyển bố cục dạng icon, có tooltip và trạng thái chọn. */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: SegmentedItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="dlp-segmented" role="radiogroup" aria-label={label}>
      {items.map((it) => (
        <Tooltip key={it.id} content={it.label} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={it.icon}
            role="radio"
            aria-label={it.label}
            aria-checked={value === it.id}
            data-selected={value === it.id}
            onClick={() => onChange(it.id)}
          />
        </Tooltip>
      ))}
    </div>
  );
}
