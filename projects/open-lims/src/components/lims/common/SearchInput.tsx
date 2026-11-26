import { Button, Input, Tooltip } from "@fluentui/react-components";
import { Dismiss16Regular, Search20Regular } from "@fluentui/react-icons";

/* Ô tìm kiếm chuẩn: icon kính lúp + nút xoá nhanh. */
export function SearchInput({
  value,
  onChange,
  placeholder = "Tìm kiếm",
  label,
  width = 280,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  width?: number | string;
}) {
  return (
    <Input
      value={value}
      onChange={(_, d) => onChange(d.value)}
      contentBefore={<Search20Regular />}
      contentAfter={
        !value ? null : (
          <Tooltip content="Xoá từ khoá" relationship="label">
            <Button
              appearance="transparent"
              size="small"
              icon={<Dismiss16Regular />}
              aria-label="Xoá từ khoá"
              onClick={() => onChange("")}
            />
          </Tooltip>
        )
      }
      placeholder={placeholder}
      aria-label={label}
      style={{ width, maxWidth: "100%" }}
    />
  );
}
