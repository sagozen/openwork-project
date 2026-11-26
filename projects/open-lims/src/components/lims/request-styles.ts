import type { CSSProperties } from "react";

export const card: CSSProperties = {
  background: "var(--background-card)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-surface)",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

export const sectionTitle: CSSProperties = {
  font: "600 16px/22px var(--font-family-base)",
};

export const subLabel: CSSProperties = {
  font: "600 12px/16px var(--font-family-base)",
  color: "var(--foreground-secondary)",
  marginBottom: 8,
};

export const hintText: CSSProperties = {
  font: "12px/16px var(--font-family-base)",
  color: "var(--foreground-secondary)",
};
