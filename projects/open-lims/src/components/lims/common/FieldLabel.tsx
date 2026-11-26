import { Tooltip } from "@fluentui/react-components";
import { Info20Regular } from "@fluentui/react-icons";

interface FieldLabelProps {
  label: string;
  tooltip?: string;
}

/** Keeps optional field guidance beside the label without adding another form row. */
export function FieldLabel({ label, tooltip }: FieldLabelProps) {
  if (!tooltip) return label;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span>{label}</span>
      <Tooltip content={tooltip} relationship="description">
        <span
          tabIndex={0}
          aria-label={`Hướng dẫn cho ${label}`}
          style={{
            display: "inline-flex",
            color: "var(--colorNeutralForeground3)",
            cursor: "help",
          }}
        >
          <Info20Regular aria-hidden="true" style={{ width: 16, height: 16 }} />
        </span>
      </Tooltip>
    </span>
  );
}
