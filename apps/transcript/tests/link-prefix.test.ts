import assert from "node:assert/strict";
import { test } from "node:test";
import { linkFromPath } from "../src/lib/link-prefix";

test("URL-looking paths become a prefilled link, keeping the query", () => {
  assert.equal(linkFromPath("/https://www.youtube.com/watch", "?v=abc"), "https://www.youtube.com/watch?v=abc");
  assert.equal(linkFromPath("/https:/youtu.be/abc"), "https://youtu.be/abc");
  assert.equal(linkFromPath("/http://example.com/a.mp3"), "https://example.com/a.mp3");
  assert.equal(linkFromPath("/www.example.com/a.mp3"), "https://www.example.com/a.mp3");
  assert.equal(linkFromPath("/youtu.be/abc"), "https://youtu.be/abc");
  assert.equal(linkFromPath("/drive.google.com/file/d/xyz/view"), "https://drive.google.com/file/d/xyz/view");
  assert.equal(linkFromPath("/https%3A%2F%2Fyoutu.be%2Fabc"), "https://youtu.be/abc");
});

test("everything else is a 404", () => {
  for (const path of ["/", "/pricing-old", "/about", "/foo/bar", "/https://", "/example.com/page", "/%E0%A4%A"]) {
    assert.equal(linkFromPath(path), null, path);
  }
});
