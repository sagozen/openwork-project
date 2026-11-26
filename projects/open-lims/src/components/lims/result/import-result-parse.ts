import type { SampleRawInput, ValueType } from "@/features/sample/sample-api";

export type ParsedRawInput = Omit<SampleRawInput, "testPart" | "unit">;
export interface ImportConfiguration {
  valueType: ValueType;
  allowedValueTypes?: ValueType[];
  catalogChoices: string[];
}
export interface ParsedRawRow {
  line: number;
  cells: string[];
  input?: ParsedRawInput;
  error?: string;
}

export const IMPORT_COLUMNS = ["Trị số đo", "Ghi chú"];
export const IMPORT_TEMPLATE = "0.012\tChạy lần 1\nKPH\tChạy lần 2";

/** Excel/Sheets dán ra tab; file CSV do Excel bản Việt xuất ra thường dùng dấu chấm phẩy vì dấu
 *  phẩy đang là dấu thập phân. Chốt một dấu phân cách cho cả khối để dòng thiếu ô không bị đoán
 *  sang kiểu khác rồi lệch cột. */
function detectDelimiter(text: string): string {
  if (text.includes("\t")) return "\t";
  const semicolons = (text.match(/;/g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  if (semicolons) return ";";
  if (text.split(/\r?\n/).every((line) => !line.trim() || /^(?:\d+,\d+|[^,]*)$/.test(line.trim())))
    return "\t";
  return commas ? "," : "\t";
}

/** Tách ô theo dấu phân cách, tôn trọng ô bọc nháy kép (`""` là một nháy trong ô) để ghi chú có
 *  chứa dấu phẩy không bị cắt làm đôi. */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char !== '"') current += char;
      else if (line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

function classifyValue(
  raw: string,
  configuration: ImportConfiguration,
): ParsedRawInput | undefined {
  const types = configuration.allowedValueTypes ?? [configuration.valueType];
  const word = raw.toUpperCase().replace(/\s+/g, " ");
  const normalized = raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw;
  if (
    types.includes("NUMERIC") &&
    /^\d+(\.\d+)?$/.test(normalized) &&
    Number.isFinite(Number(normalized))
  ) {
    return { valueType: "NUMERIC", value: String(Number(normalized)) };
  }
  if (["KPH", "ND", "KHÔNG PHÁT HIỆN", "KHONG PHAT HIEN"].includes(word)) {
    const type = types.includes("BELOW_LOD")
      ? "BELOW_LOD"
      : types.includes("NOT_DETECTED")
        ? "NOT_DETECTED"
        : undefined;
    if (type) return { valueType: type, value: "KPH" };
  }
  if (types.includes("BELOW_LOQ") && ["<LOQ", "< LOQ", "DƯỚI LOQ", "DUOI LOQ"].includes(word)) {
    return { valueType: "BELOW_LOQ", value: "<LOQ" };
  }
  if (types.includes("CATALOG_CHOICE") && configuration.catalogChoices.includes(raw)) {
    return { valueType: "CATALOG_CHOICE", value: raw };
  }
  if (types.includes("TEXT_KPH") && raw) return { valueType: "TEXT_KPH", value: raw };
  return undefined;
}

/** Validate against this parameter's pinned types. The server timestamps each saved row. */
export function parseRawResultRows(
  text: string,
  configuration: ImportConfiguration,
): ParsedRawRow[] {
  const delimiter = detectDelimiter(text);
  const rows: ParsedRawRow[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const cells = splitLine(line, delimiter);
    if (!rows.length && ["trị số đo", "trị số", "value"].includes(cells[0]?.toLowerCase() ?? ""))
      return;
    const input = classifyValue(cells[0] ?? "", configuration);
    const comment = cells[1]?.trim();
    rows.push({
      line: index + 1,
      cells,
      ...(cells.length > 2
        ? { error: "Chỉ cần hai cột: Trị số đo, Ghi chú" }
        : input
          ? { input: { ...input, ...(comment ? { comment } : {}) } }
          : { error: "Trị số không hợp lệ với loại trị số/danh mục của chỉ tiêu" }),
    });
  });
  return rows;
}
