import type { ReactNode } from "react";

/* Thanh công cụ chuẩn: nhóm trái - khoảng đệm - nhóm phải. */
export function Toolbar({
  left,
  right,
  className,
}: {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`dlp-toolbar${className ? ` ${className}` : ""}`}>
      <div className="dlp-toolbar__group">{left}</div>
      <div className="dlp-toolbar__spacer" />
      <div className="dlp-toolbar__group">{right}</div>
    </div>
  );
}
