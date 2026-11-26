import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPublicHttpsUrl,
  dohResolver,
  FetchGuardError,
  guardedFetch,
  isBlockedAddress,
} from "../src/lib/artifacts/fetch-guard";

test("addresses in private, loopback, link-local, metadata, multicast and reserved ranges are blocked", () => {
  const blocked = [
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a00:1",
    "::10.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::1",
    "2002:a9fe:a9fe::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "100::1",
    "[::1]",
    "not an address",
    "",
    "fe80::1%eth0",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
  ];
  for (const address of blocked) assert.equal(isBlockedAddress(address), true, address);
});

test("ordinary public addresses are allowed", () => {
  for (const address of [
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.0.1",
    "192.0.1.1",
    "198.17.0.1",
    "198.20.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::",
  ]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("assertPublicHttpsUrl accepts a public https URL and rejects everything a Worker must not fetch", () => {
  assert.equal(assertPublicHttpsUrl("https://example.com/a/b.pdf?x=1").hostname, "example.com");
  assert.equal(assertPublicHttpsUrl("https://example.com:443/x").hostname, "example.com");
  assert.equal(assertPublicHttpsUrl("https://93.184.216.34/x").hostname, "93.184.216.34");
  assert.equal(assertPublicHttpsUrl("https://[2606:4700:4700::1111]/x").hostname, "[2606:4700:4700::1111]");
  for (const bad of [
    "http://example.com/",
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/plain,hi",
    "//example.com/x",
    "example.com/x",
    "",
    "https://user@example.com/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://example.com:80/",
    "https://localhost/",
    "https://LOCALHOST/",
    "https://app.localhost/",
    "https://printer.local/",
    "https://db.internal/",
    "https://nas.lan/",
    "https://intranet/",
    "https://127.0.0.1/",
    "https://127.1/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://0177.0.0.1/",
    "https://169.254.169.254/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[fe80::1]/",
    "https://[fd00::1]/",
    "https://10.0.0.1/",
  ]) {
    assert.throws(() => assertPublicHttpsUrl(bad), FetchGuardError, bad);
  }
});

const publicResolver = async () => ["93.184.216.34"];

test("guardedFetch follows a few redirects, re-checking each one, and returns the unread body", async () => {
  const seen: string[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string> | undefined)?.["accept-encoding"], "identity");
    if (url.endsWith("/a")) return new Response(null, { status: 301, headers: { location: "/b" } });
    if (url.endsWith("/b"))
      return new Response(null, { status: 308, headers: { location: "https://cdn.example.net/c" } });
    return new Response("payload");
  }) as typeof fetch;
  const result = await guardedFetch("https://example.com/a", { fetch: transport, resolve: publicResolver });
  assert.deepEqual(seen, ["https://example.com/a", "https://example.com/b", "https://cdn.example.net/c"]);
  assert.equal(result.url.hostname, "cdn.example.net");
  assert.equal(await result.response.text(), "payload");
});

test("guardedFetch stops after three redirects and on any hop that is not public", async () => {
  let calls = 0;
  const chain = (async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: `https://example.com/${calls}` } });
  }) as typeof fetch;
  await assert.rejects(guardedFetch("https://example.com/0", { fetch: chain, resolve: publicResolver }), /too many/);
  assert.equal(calls, 4, "the first request plus three redirects");

  const toPrivate = (async () =>
    new Response(null, { status: 302, headers: { location: "https://10.0.0.1/" } })) as typeof fetch;
  await assert.rejects(
    guardedFetch("https://example.com/", { fetch: toPrivate, resolve: publicResolver }),
    /private or reserved/,
  );

  const resolveByHost = async (host: string) => (host === "evil.example.com" ? ["192.168.0.9"] : ["93.184.216.34"]);
  const toRebinder = (async () =>
    new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } })) as typeof fetch;
  await assert.rejects(
    guardedFetch("https://example.com/", { fetch: toRebinder, resolve: resolveByHost }),
    /private or reserved/,
  );
});

test("guardedFetch turns a network failure and a stalled response into a guard error", async () => {
  const failing = (async () => {
    throw new TypeError("connect ECONNRESET 10.0.0.1");
  }) as typeof fetch;
  await assert.rejects(guardedFetch("https://example.com/", { fetch: failing, resolve: publicResolver }), (error) => {
    assert.ok(error instanceof FetchGuardError);
    assert.doesNotMatch(error.message, /ECONNRESET|10\.0\.0\.1/);
    return true;
  });
  const stalled = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
  await assert.rejects(
    guardedFetch("https://example.com/", { fetch: stalled, resolve: publicResolver, timeoutMs: 20 }),
    FetchGuardError,
  );
});

test("the DNS-over-HTTPS resolver returns A and AAAA answers and fails closed", async () => {
  const answer = (_type: string, body: unknown, ok = true) =>
    (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://cloudflare-dns.com");
      assert.equal(url.searchParams.get("name"), "example.com");
      return new Response(
        JSON.stringify(
          typeof body === "function" ? (body as (t: string | null) => unknown)(url.searchParams.get("type")) : body,
        ),
        {
          status: ok ? 200 : 502,
        },
      );
    }) as typeof fetch;

  const resolver = dohResolver(
    answer("", (type: string | null) =>
      type === "A"
        ? {
            Status: 0,
            Answer: [
              { type: 5, data: "alias.example.net." },
              { type: 1, data: "93.184.216.34" },
            ],
          }
        : { Status: 0, Answer: [{ type: 28, data: "2606:2800:220:1::1" }] },
    ),
  );
  assert.deepEqual(await resolver("example.com"), ["93.184.216.34", "2606:2800:220:1::1"]);

  await assert.rejects(dohResolver(answer("", { Status: 3 }))("example.com"), /does not resolve/);
  await assert.rejects(dohResolver(answer("", { Status: 0 }))("example.com"), /does not resolve/);
  await assert.rejects(dohResolver(answer("", {}, false))("example.com"), /could not be looked up/);
  const broken = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  await assert.rejects(dohResolver(broken)("example.com"), FetchGuardError);
});
