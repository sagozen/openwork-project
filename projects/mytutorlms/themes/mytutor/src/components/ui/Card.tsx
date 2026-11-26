import type { HTMLAttributes } from "react";

/** A bordered surface. Cards have no shadow; elevation is for overlays only. */
export default function Card({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={className ? `card ${className}` : "card"} />;
}
