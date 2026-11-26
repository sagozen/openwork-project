import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, toCsv } from "../src/csv";

test("CSV parser handles quoted commas, escaped quotes and multiline fields", () => {
  const table = parseCsv('name,course,note\n"Nguyễn, Thị","Course ""A""","line 1\nline 2"\n');
  assert.deepEqual(table.headers, ["name", "course", "note"]);
  assert.deepEqual(table.rows[0], ["Nguyễn, Thị", 'Course "A"', "line 1\nline 2"]);
});

test("CSV parser rejects duplicate headers, bad quoting and the row cap", () => {
  assert.throws(() => parseCsv("a,a\n1,2"), /unique/);
  assert.throws(() => parseCsv('a\n"unclosed'), /unclosed/);
  assert.throws(() => parseCsv(`a\n${"1\n".repeat(4)}`, 3), /at most 3/);
});

test("CSV writer escapes and round-trips", () => {
  const csv = toCsv(["name", "note"], [{ name: 'A, "B"', note: "line\n2" }]);
  const table = parseCsv(csv);
  assert.deepEqual(table.rows[0], ['A, "B"', "line\n2"]);
});
