import type { ReactNode } from "react";

export interface Column<Row> {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Right-aligned, tabular numbers. */
  numeric?: boolean;
}

/** A captioned table that scrolls sideways on narrow screens. */
export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
}: {
  caption: string;
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  empty: ReactNode;
}) {
  if (!rows.length) return <div className="mt-empty">{empty}</div>;
  return (
    <div
      className="mt-table-wrap"
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table>
        <caption className="mt-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.numeric ? "mt-numeric" : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={column.numeric ? "mt-numeric" : undefined}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
