import { describe, expect, test } from "bun:test";
import { formatAmount, formatVndInput, parseVndInput } from "../src/lib/format/currency";

describe("VND amount entry", () => {
  test.each([
    ["1500000", "1,500,000", 1500000],
    ["1,500,000.50", "1,500,000.50", 1500000.5],
    ["0001234.05", "1,234.05", 1234.05],
    [".50", "0.50", 0.5],
  ])("preserves the value of %s", (input, formatted, amount) => {
    expect(formatVndInput(input)).toBe(formatted);
    expect(parseVndInput(formatVndInput(input))).toBe(amount);
  });

  test("keeps decimal input editable without moving fractional digits into the integer", () => {
    let value = "";
    for (const character of "1234.50") value = formatVndInput(value + character);
    expect(value).toBe("1,234.50");
    expect(formatVndInput("1,234.")).toBe("1,234.");
    expect(formatVndInput("1,234.0")).toBe("1,234.0");
    expect(parseVndInput(value)).toBe(1234.5);
  });

  test("empty and malformed amounts cannot become valid payments", () => {
    expect(formatVndInput("")).toBe("");
    expect(parseVndInput("")).toBeNaN();
    expect(parseVndInput(formatVndInput("1.2.3"))).toBeNaN();
  });

  test("parses a pasted currency display without losing fractional digits", () => {
    expect(parseVndInput(" 1,500,000.50 ₫ ")).toBe(1500000.5);
  });

  test.each(["-1500", "+1500", "1e3", "0x10", "1.2.3", "abc", "   "])(
    "rejects %s rather than converting it into a different payable amount",
    (input) => {
      expect(parseVndInput(input)).toBeNaN();
    },
  );
});

describe("VND amount display", () => {
  test("uses the same separators on payment readback without rounding away decimals", () => {
    expect(formatAmount(parseVndInput("1,500,000.05"))).toBe("1,500,000.05 ₫");
    expect(formatAmount(1500000)).toBe("1,500,000 ₫");
  });

  test("distinguishes a missing amount from zero", () => {
    expect(formatAmount()).toBe("");
    expect(formatAmount(null)).toBe("");
    expect(formatAmount(0)).toBe("0 ₫");
  });
});
