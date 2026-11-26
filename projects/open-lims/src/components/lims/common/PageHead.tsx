import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";

export interface Crumb {
  label: string;
  to?: LinkProps["to"];
}

/* Đầu trang dùng chung: breadcrumb 12/16 · tiêu đề 28/36 · mô tả 14/20 · vùng nút bên phải. */
export function PageHead({
  crumbs,
  title,
  description,
  actions,
}: {
  crumbs?: Crumb[];
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="dlp-pagehead">
      <div style={{ minWidth: 0 }}>
        {crumbs && crumbs.length > 0 ? (
          <div className="dlp-pagehead__crumbs">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="dlp-pagehead__crumb">
                {i > 0 ? <span aria-hidden="true">/</span> : null}
                {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
              </span>
            ))}
          </div>
        ) : null}
        <h1 className="dlp-pagehead__title">{title}</h1>
        {description ? <p className="dlp-pagehead__desc">{description}</p> : null}
      </div>
      <div style={{ flex: 1 }} />
      {actions}
    </div>
  );
}
