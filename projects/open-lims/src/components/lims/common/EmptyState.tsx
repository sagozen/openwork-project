import type { ReactNode } from "react";
import { Button } from "@fluentui/react-components";

/* Trạng thái rỗng dùng chung cho bảng, bảng trạng thái và worklist. */
export function EmptyState({
  title,
  hint,
  actionLabel,
  onAction,
  icon,
}: {
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: ReactNode;
}) {
  return (
    <div className="dlp-empty">
      {icon ? <div className="dlp-empty__icon">{icon}</div> : null}
      <div className="dlp-empty__title">{title}</div>
      {hint ? <div className="dlp-datagrid__secondary">{hint}</div> : null}
      {actionLabel && onAction ? (
        <Button size="small" appearance="secondary" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
