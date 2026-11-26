import { Button, Tooltip, type ButtonProps } from "@fluentui/react-components";

/* Nút tự khoá theo quyền, luôn giải thích lý do khi bị khoá. */
export function PermissionButton({
  allowed,
  deniedReason = "Bạn không có quyền thực hiện thao tác này.",
  tooltip,
  children,
  ...rest
}: ButtonProps & {
  allowed: boolean;
  deniedReason?: string;
  tooltip?: string;
}) {
  const btn = (
    <Button {...rest} disabled={rest.disabled || !allowed}>
      {children}
    </Button>
  );

  const content = !allowed ? deniedReason : tooltip;
  if (!content) return btn;

  return (
    <Tooltip content={content} relationship="label">
      {!allowed ? <span style={{ display: "inline-flex" }}>{btn}</span> : btn}
    </Tooltip>
  );
}
