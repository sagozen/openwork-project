/* Xuất CSV danh sách hồ sơ kiểm nghiệm theo đúng cột đang hiển thị. */

import { PII_MASK, type RecordRow } from "./records-data";
import type { RecordColumn } from "./records-view-data";

function cellText(row: RecordRow, column: RecordColumn, canPii: boolean): string {
  if (column.pii && !canPii) return PII_MASK;
  const value = (row as unknown as Record<string, unknown>)[column.key];
  return Array.isArray(value) ? value.join(" | ") : String(value ?? "");
}

/** Tải xuống các dòng đang lọc dưới dạng CSV (BOM UTF-8 để Excel đọc đúng tiếng Việt). */
export function exportRecordsCsv(
  columns: RecordColumn[],
  rows: RecordRow[],
  canPii: boolean,
): void {
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const head = columns.map((c) => quote(c.label)).join(",");
  const body = rows
    .map((row) => columns.map((c) => quote(cellText(row, c, canPii))).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${head}\n${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ho-so-kiem-nghiem-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
