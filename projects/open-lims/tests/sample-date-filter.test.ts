import { describe, expect, test } from "bun:test";
import { sampleDateRange } from "../src/features/sample/date-filter";

describe("sample date presets", () => {
  test.each([
    ["today", "2026-10-04", "2026-10-04"],
    ["yesterday", "2026-10-03", "2026-10-03"],
    ["3days", "2026-10-02", "2026-10-04"],
    ["7days", "2026-09-28", "2026-10-04"],
  ] as const)("%s uses inclusive Vietnam dates", (preset, from, to) => {
    expect(sampleDateRange(preset, new Date("2026-10-03T17:00:00Z"))).toEqual({ from, to });
  });

  test("Vietnam midnight changes the day independently of the machine timezone", () => {
    expect(sampleDateRange("today", new Date("2026-10-03T16:59:59Z"))).toEqual({
      from: "2026-10-03",
      to: "2026-10-03",
    });
    expect(sampleDateRange("today", new Date("2026-10-03T17:00:00Z"))).toEqual({
      from: "2026-10-04",
      to: "2026-10-04",
    });
  });

  test("yesterday includes leap day at the month boundary", () => {
    expect(sampleDateRange("yesterday", new Date("2024-02-29T17:00:00Z"))).toEqual({
      from: "2024-02-29",
      to: "2024-02-29",
    });
  });

  test("seven days crosses the year boundary without omitting a day", () => {
    expect(sampleDateRange("7days", new Date("2025-12-31T17:00:00Z"))).toEqual({
      from: "2025-12-26",
      to: "2026-01-01",
    });
  });
});
