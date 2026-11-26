import { describe, expect, test } from "bun:test";
import { parseRawResultRows } from "../src/components/lims/result/import-result-parse";
import type { ImportConfiguration } from "../src/components/lims/result/import-result-parse";

const numeric: ImportConfiguration = {
  valueType: "NUMERIC",
  allowedValueTypes: ["NUMERIC", "BELOW_LOD", "BELOW_LOQ"],
  catalogChoices: [],
};

describe("parameter result import", () => {
  test("reads value/comment columns and restores numeric, KPH and LOQ types", () => {
    const rows = parseRawResultRows(
      "Trị số đo\tGhi chú\n0,012\tLần 1\nKPH\tLần 2\n< LOQ\tLần 3",
      numeric,
    );
    expect(rows.map((row) => row.input)).toEqual([
      { valueType: "NUMERIC", value: "0.012", comment: "Lần 1" },
      { valueType: "BELOW_LOD", value: "KPH", comment: "Lần 2" },
      { valueType: "BELOW_LOQ", value: "<LOQ", comment: "Lần 3" },
    ]);
    expect(rows[0]?.line).toBe(2);
    expect(rows[0]?.input).not.toHaveProperty("measuredAt");
    expect(rows[0]?.input).not.toHaveProperty("sampleMass");
  });
  test("enforces each parameter's own types, including old singleton configurations", () => {
    const rows = parseRawResultRows("KPH\n<LOQ\n1.2", { valueType: "NUMERIC", catalogChoices: [] });
    expect(rows[0]?.error).toBeDefined();
    expect(rows[1]?.error).toBeDefined();
    expect(rows[2]?.input?.valueType).toBe("NUMERIC");
  });
  test("KPH prefers BELOW_LOD regardless of configuration order", () => {
    for (const allowedValueTypes of [
      ["NOT_DETECTED", "BELOW_LOD"],
      ["BELOW_LOD", "NOT_DETECTED"],
    ] as const) {
      expect(
        parseRawResultRows("KPH", {
          valueType: "BELOW_LOD",
          allowedValueTypes: [...allowedValueTypes],
          catalogChoices: [],
        })[0]?.input?.valueType,
      ).toBe("BELOW_LOD");
    }
    expect(
      parseRawResultRows("KPH", { valueType: "NOT_DETECTED", catalogChoices: [] })[0]?.input
        ?.valueType,
    ).toBe("NOT_DETECTED");
  });
  test("accepts single-column Vietnamese decimals", () => {
    expect(parseRawResultRows("0,012\n1,5\nKPH", numeric).map((r) => r.input?.value)).toEqual([
      "0.012",
      "1.5",
      "KPH",
    ]);
  });
  test("rejects negative/non-numeric values and the obsolete date/mass layout", () => {
    for (const text of ["-5", "NaN", "Infinity", "03/08/2026 09:12\t2\tg\t0.012"]) {
      expect(parseRawResultRows(text, numeric)[0]?.error).toBeDefined();
    }
  });
  test("preserves configured text and validates catalog choices", () => {
    const choices: ImportConfiguration = {
      valueType: "CATALOG_CHOICE",
      catalogChoices: ["Đạt", "Không đạt"],
    };
    const rows = parseRawResultRows("Đạt\nKhác", choices);
    expect(rows[0]?.input).toEqual({ valueType: "CATALOG_CHOICE", value: "Đạt" });
    expect(rows[1]?.error).toBeDefined();
    expect(
      parseRawResultRows("KPH", { valueType: "TEXT_KPH", catalogChoices: [] })[0]?.input,
    ).toEqual({ valueType: "TEXT_KPH", value: "KPH" });
  });
  test("supports quoted comments, semicolons and blank lines", () => {
    expect(parseRawResultRows('0.012,"Ghi chú, có dấu phẩy"\n\n', numeric)[0]?.input?.comment).toBe(
      "Ghi chú, có dấu phẩy",
    );
    expect(parseRawResultRows("0,012;Lần 1", numeric)[0]?.input?.value).toBe("0.012");
    expect(parseRawResultRows("\n\n", numeric)).toEqual([]);
  });
});
