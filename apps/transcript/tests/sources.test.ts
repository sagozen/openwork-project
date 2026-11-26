import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "@templatedesign/platform/http";
import { classifyUrl, isPrivateHost, normaliseUrl } from "../src/lib/sources";

test("recognises every MVP source", () => {
  const cases: Array<[string, string]> = [
    ["https://www.youtube.com/watch?v=abc123", "youtube"],
    ["https://youtu.be/abc123", "youtube"],
    ["https://www.youtube.com/shorts/abc123", "youtube"],
    ["https://www.tiktok.com/@user/video/123", "tiktok"],
    ["https://drive.google.com/file/d/FILEID_12345/view", "gdrive"],
    ["https://1drv.ms/u/s!AbCdEf", "onedrive"],
    ["https://contoso.sharepoint.com/sites/a/b.mp4", "onedrive"],
    ["https://www.dropbox.com/s/abc/call.mp3?dl=0", "dropbox"],
    ["https://cdn.example.com/audio.mp3", "direct"],
    ["https://vimeo.com/123456", "vimeo"],
    ["https://www.loom.com/share/abc", "loom"],
    ["https://soundcloud.com/artist/track", "soundcloud"],
    ["https://x.com/user/status/1", "x"],
    ["https://www.facebook.com/watch/?v=1", "facebook"],
    ["https://www.instagram.com/reel/abc/", "instagram"],
  ];
  for (const [url, kind] of cases) {
    assert.equal(classifyUrl(url).kind, kind, url);
  }
});

test("Drive folders and YouTube playlists are marked as multi-item", () => {
  assert.equal(classifyUrl("https://drive.google.com/drive/folders/FOLDERID_123").multi, "folder");
  assert.equal(classifyUrl("https://www.youtube.com/playlist?list=PL123").multi, "playlist");
  assert.equal(classifyUrl("https://www.youtube.com/watch?v=a&list=PL123").multi, "playlist");
  assert.equal(classifyUrl("https://www.youtube.com/watch?v=a").multi, null);
});

test("Dropbox links are rewritten for direct download", () => {
  const source = classifyUrl("https://www.dropbox.com/s/abc/call.mp3?dl=0");
  assert.match(source.ref, /dl=1/);
});

test("SSRF guard blocks loopback, private ranges and metadata addresses", () => {
  for (const host of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.5.5",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.1.1",
    "[::1]",
    "localhost",
    "metadata.google.internal",
    "printer.local",
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  assert.equal(isPrivateHost("cdn.example.com"), false);
  assert.equal(isPrivateHost("8.8.8.8"), false);
});

test("private and insecure URLs are refused before any fetch", () => {
  assert.throws(
    () => normaliseUrl("http://127.0.0.1:8080/a.mp3"),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
  assert.throws(
    () => normaliseUrl("http://example.com/a.mp3"),
    (error: unknown) => error instanceof HttpError && /https/.test(error.message),
  );
  assert.throws(
    () => normaliseUrl("ftp://example.com/a.mp3"),
    (error: unknown) => error instanceof HttpError,
  );
});

test("DRM services are refused with their own reason", () => {
  for (const url of ["https://open.spotify.com/track/1", "https://www.netflix.com/watch/1"]) {
    try {
      classifyUrl(url);
      assert.fail(`${url} should be refused`);
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal((error.details as { reason?: string }).reason, "drm");
    }
  }
});

test("a Google Drive link without an id asks for a better link", () => {
  assert.throws(
    () => classifyUrl("https://drive.google.com/drive/my-drive"),
    (error: unknown) => error instanceof HttpError && (error.details as { reason?: string }).reason === "unsupported",
  );
});
