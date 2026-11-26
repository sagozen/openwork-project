import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = JSON.parse(readFileSync(join(root, "schemas", "book-profile.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const book = {
  profile: "book-v1",
  trim: "8.5x11",
  paper: "white",
  pageCount: 134,
  typography: { bodyPt: 18, headingPt: 26 },
  sections: [
    { numbering: "arabic", expectedStartPage: 1, blocks: [{ type: "heading", text: "Remember When" }] },
    {
      numbering: "arabic",
      startOnRight: true,
      expectedStartPage: 10,
      blocks: [{ type: "svg", svg: "<svg/>", width: "fill" }],
    },
  ],
};

const cover = {
  profile: "book-cover-v1",
  trim: "8.5x11",
  paper: "white",
  pageCount: 134,
  typography: { bodyPt: 16, headingPt: 48 },
  front: [{ type: "heading", text: "Remember When Word Search" }],
  back: [{ type: "paragraph", text: "Hook line", align: "left" }],
  spine: [{ type: "paragraph", text: "Remember When - AvioBrand Books" }],
};

test("a book envelope validates against the shared schema", () => {
  assert.equal(validate(book), true, JSON.stringify(validate.errors));
  assert.equal(validate(cover), true, JSON.stringify(validate.errors));
});

test("unknown blocks and trims are refused", () => {
  assert.equal(validate({ ...book, trim: "A5" }), false);
  assert.equal(validate({ ...book, sections: [{ blocks: [{ type: "script", text: "x" }] }] }), false);
});
