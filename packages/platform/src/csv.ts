export interface CsvTable {
  headers: string[];
  rows: string[][];
}

export const CSV_MAX_BYTES = 256 * 1024;
export const CSV_MAX_COLUMNS = 50;

/** RFC 4180 comma CSV with quoted commas, escaped quotes and multiline fields. */
export function parseCsv(source: string, maxRows = 100): CsvTable {
  if (new TextEncoder().encode(source).byteLength > CSV_MAX_BYTES) throw new Error("CSV must be 256 KiB or smaller.");
  const text = source.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let value = "";
  let quoted = false;
  let closed = false;

  const field = () => {
    if (value.length > 2000) throw new Error("Each CSV value must be at most 2,000 characters.");
    record.push(value);
    if (record.length > CSV_MAX_COLUMNS) throw new Error("CSV supports at most 50 columns.");
    value = "";
    closed = false;
  };
  const row = () => {
    field();
    records.push(record);
    record = [];
    if (records.length > maxRows + 1) throw new Error(`CSV supports at most ${maxRows} data rows.`);
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        value += char;
      }
    } else if (char === "," || char === "\n" || char === "\r") {
      if (char === ",") field();
      else {
        row();
        if (char === "\r" && text[index + 1] === "\n") index += 1;
      }
    } else if (char === '"' && value === "" && !closed) {
      quoted = true;
    } else if (closed || char === '"') {
      throw new Error('Invalid CSV quoting. Put quotes around the entire field and escape quotes as "".');
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  if (value !== "" || record.length || closed) row();
  const headers = records.shift()?.map((header) => header.trim()) ?? [];
  if (!headers.length || headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error("CSV needs a header row with unique, non-empty column names.");
  }
  if (!records.length) throw new Error("CSV needs at least one data row.");
  if (records.some((entry) => entry.length !== headers.length)) {
    throw new Error("Every CSV row must have the same number of columns as its header.");
  }
  return { headers, rows: records };
}

export function toCsv(headers: string[], rows: Array<Record<string, string>>): string {
  const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return [headers.join(","), ...rows.map((row) => headers.map((header) => cell(row[header] ?? "")).join(","))].join(
    "\n",
  );
}
