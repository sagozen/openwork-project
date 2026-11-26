import { useEffect, useRef, type ReactNode } from "react";

/* Popover chuẩn: neo theo nút, tự đóng khi bấm ra ngoài hoặc nhấn Esc. */
export function PopoverMenu({
  open,
  onClose,
  align = "left",
  width,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  align?: "left" | "right";
  width?: number;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !el.parentElement?.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`dlp-popover${align === "right" ? " dlp-popover--right" : ""}`}
      style={width ? { width } : undefined}
    >
      {children}
    </div>
  );
}
