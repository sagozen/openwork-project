import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { StudentLiveSession } from "../src/model.js";

// Pure classroom helpers of the theme. Like the theme contract tests, these
// skip when the plugin is vendored without the theme alongside it.
const themeSrc = new URL("../../../themes/mytutor/src/", import.meta.url);
const skip =
  !existsSync(themeSrc) && "theme source is not alongside the plugin";
const load = (path: string) => import(new URL(path, themeSrc).href);

const session: StudentLiveSession = {
  id: "a".repeat(32),
  title: "Buổi 1; cài đặt, cấu hình \\ và\nhỏi đáp",
  startsAt: "2030-01-05T12:00:00.000Z",
  durationMinutes: 90,
  joinUrl: "https://zoom.us/j/123456789?pwd=abc,def;ghi",
  passcode: "42,42",
  notes:
    "Mang theo máy tính đã cài ứng dụng. Ghi chú dài để kiểm tra việc gấp dòng theo RFC 5545 khi nội dung vượt quá 75 octet trên một dòng.",
};
const labels = { join: "Vào Zoom", passcode: "Mật mã" };

test(
  ".ics files escape text, fold long lines and use UTC times",
  { skip },
  async () => {
    const { buildIcs, escapeIcsText } = await load("lib/calendar.ts");
    assert.equal(
      escapeIcsText("a\\b;c,d\r\ne\nf\u0007"),
      "a\\\\b\\;c\\,d\\ne\\nf",
    );
    const ics: string = buildIcs(session, {
      host: "studio.example",
      labels,
      now: Date.parse("2029-12-01T00:00:00Z"),
    });
    assert.ok(ics.endsWith("\r\n"));
    assert.ok(!/[^\r]\n/.test(ics), "every line ends with CRLF");
    const physical = ics.split("\r\n").slice(0, -1);
    for (const line of physical)
      assert.ok(new TextEncoder().encode(line).byteLength <= 75, line);
    // Unfold (RFC 5545 section 3.1) before reading properties.
    const lines = ics.replace(/\r\n /g, "").split("\r\n");
    const prop = (name: string) =>
      lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1);
    assert.equal(lines[0], "BEGIN:VCALENDAR");
    assert.equal(prop("VERSION"), "2.0");
    assert.equal(prop("UID"), `${"a".repeat(32)}@studio.example`);
    assert.equal(prop("DTSTAMP"), "20291201T000000Z");
    assert.equal(prop("DTSTART"), "20300105T120000Z");
    assert.equal(prop("DTEND"), "20300105T133000Z");
    assert.equal(
      prop("SUMMARY"),
      "Buổi 1\\; cài đặt\\, cấu hình \\\\ và\\nhỏi đáp",
    );
    assert.equal(
      prop("LOCATION"),
      "https://zoom.us/j/123456789?pwd=abc\\,def\\;ghi",
    );
    const description = prop("DESCRIPTION")!;
    assert.ok(
      description.includes(
        "Vào Zoom: https://zoom.us/j/123456789?pwd=abc\\,def\\;ghi",
      ),
    );
    assert.ok(description.includes("Mật mã: 42\\,42"));
    assert.ok(!description.includes("\n"));
    // A title cannot inject a property or end the event early.
    const injected: string = buildIcs(
      { ...session, title: "x\r\nEND:VEVENT\r\nBEGIN:VEVENT" },
      { host: "studio.example", labels },
    );
    assert.equal(injected.match(/^END:VEVENT$/gm)?.length, 1);
  },
);

test(
  "Join Zoom opens 15 minutes before the start until the end; calendar links use UTC",
  { skip },
  async () => {
    const { sessionPhase, googleCalendarUrl, icsFileName } =
      await load("lib/calendar.ts");
    const start = Date.parse(session.startsAt);
    const minute = 60_000;
    assert.equal(sessionPhase(session, start - 16 * minute), "upcoming");
    assert.equal(sessionPhase(session, start - 15 * minute), "joinable");
    assert.equal(sessionPhase(session, start + 89 * minute), "joinable");
    assert.equal(sessionPhase(session, start + 90 * minute), "ended");
    const url = new URL(googleCalendarUrl(session, labels));
    assert.equal(
      url.origin + url.pathname,
      "https://calendar.google.com/calendar/render",
    );
    assert.equal(url.searchParams.get("action"), "TEMPLATE");
    assert.equal(url.searchParams.get("text"), session.title);
    assert.equal(
      url.searchParams.get("dates"),
      "20300105T120000Z/20300105T133000Z",
    );
    assert.equal(url.searchParams.get("location"), session.joinUrl);
    assert.ok(url.searchParams.get("details")!.includes(session.joinUrl));
    assert.equal(
      icsFileName(session),
      "buoi-1-cai-dat-cau-hinh-va-hoi-dap.ics",
    );
  },
);

test(
  "lesson notes link only safe https:// addresses and keep everything else as text",
  { skip },
  async () => {
    const { linkify, paragraphs } = await load("lib/linkify.ts");
    const notes =
      'Tải tại https://cdn.example/app.dmg. Xem (https://docs.example/a_(b)) và <script>alert(1)</script> "https://evil.example/x"><img src=x onerror=alert(1)> javascript:alert(1) http://plain.example https://user:pw@evil.example/ https://';
    const segments: Array<{ kind: string; text: string; href?: string }> =
      linkify(notes);
    assert.deepEqual(
      segments.filter((segment) => segment.kind === "link").map((s) => s.href),
      [
        "https://cdn.example/app.dmg",
        "https://docs.example/a_(b)",
        "https://evil.example/x",
      ],
    );
    // Nothing is lost or reordered: the segments spell the original notes.
    assert.equal(segments.map((segment) => segment.text).join(""), notes);
    for (const segment of segments)
      if (segment.kind === "link") {
        assert.equal(segment.text, segment.href);
        assert.ok(!/[<>"\s]/.test(segment.href!));
      }
    assert.ok(
      segments.some(
        (segment) =>
          segment.kind === "text" &&
          segment.text.includes("<script>alert(1)</script>"),
      ),
    );
    assert.deepEqual(paragraphs("Một\nhai\n\n\n  \nBa\r\n\r\nBốn\n"), [
      "Một\nhai",
      "Ba",
      "Bốn",
    ]);
    // Notes are rendered by React as text, never as HTML.
    for (const file of [
      "components/learn/LessonNotes.tsx",
      "components/learn/LessonView.tsx",
    ]) {
      const source = readFileSync(new URL(file, themeSrc), "utf8");
      assert.ok(!source.includes("dangerouslySetInnerHTML"), file);
    }
    const notesSource = readFileSync(
      new URL("components/learn/LessonNotes.tsx", themeSrc),
      "utf8",
    );
    assert.ok(notesSource.includes('rel="noopener noreferrer"'));
    assert.ok(notesSource.includes('target="_blank"'));
  },
);

test(
  "resources list the legacy link first and label file links as downloads",
  { skip },
  async () => {
    const { isDownloadUrl, lessonResources } = await load("lib/resources.ts");
    assert.equal(isDownloadUrl("https://cdn.example/guide.PDF"), true);
    assert.equal(isDownloadUrl("https://cdn.example/app.dmg?sig=1"), true);
    assert.equal(isDownloadUrl("https://cdn.example/setup.zip"), true);
    assert.equal(isDownloadUrl("https://docs.example/guide"), false);
    assert.equal(isDownloadUrl("https://docs.example/view?file=a.pdf"), false);
    assert.deepEqual(
      lessonResources({
        resourceUrl: "https://a.example",
        resourceLabel: "First",
        resources: [{ label: "Second", url: "https://b.example" }],
      }),
      [
        { url: "https://a.example", label: "First" },
        { label: "Second", url: "https://b.example" },
      ],
    );
    assert.deepEqual(
      lessonResources({ resourceUrl: "", resourceLabel: "" }),
      [],
    );
  },
);

test(
  "sign-in returns only to same-origin learning and course pages",
  { skip },
  async () => {
    const { safeNext } = await load("lib/safe-next.ts");
    for (const allowed of [
      "/learn",
      "/learn/free-course",
      "/learn/free-course?lesson=intro",
      "/courses/free-course",
    ])
      assert.equal(safeNext(allowed), allowed);
    for (const refused of [
      null,
      "",
      "//evil.example",
      "https://evil.example/learn",
      "/courses/../admin",
      "/courses/free/extra",
      "/learn\\evil",
      "/learnevil",
      "/courses/free?x=https://evil.example",
    ])
      assert.equal(safeNext(refused), "/learn");
  },
);

test(
  "the return path survives the emailed link opening in a new tab for 30 minutes, once",
  { skip },
  async () => {
    const { rememberNext, takeNext, NEXT_STORAGE_KEY } = await load(
      "lib/safe-next.ts",
    );
    const rows = new Map<string, string>();
    const storage = {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => void rows.set(key, value),
      removeItem: (key: string) => void rows.delete(key),
    };
    const now = Date.parse("2030-01-01T00:00:00Z");
    rememberNext("/courses/free", storage, now);
    assert.equal(takeNext(storage, now + 29 * 60_000), "/courses/free");
    assert.equal(takeNext(storage, now + 29 * 60_000), "/learn", "used once");
    rememberNext("/courses/free", storage, now);
    assert.equal(takeNext(storage, now + 31 * 60_000), "/learn", "expired");
    rememberNext("https://evil.example", storage, now);
    assert.equal(takeNext(storage, now), "/learn");
    rows.set(
      NEXT_STORAGE_KEY,
      JSON.stringify({ next: "//evil.example", expiresAt: now + 1 }),
    );
    assert.equal(takeNext(storage, now), "/learn", "validated again on read");
    rows.set(NEXT_STORAGE_KEY, "not json");
    assert.equal(takeNext(storage, now), "/learn");
    assert.equal(takeNext(null, now), "/learn");
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    rememberNext("/courses/free", blocked, now);
    assert.equal(takeNext(blocked, now), "/learn");
  },
);
