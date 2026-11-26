// Sidecar điều khiển trình duyệt: JSON-RPC qua stdio, mỗi dòng một JSON (NDJSON).
//   vào:  {"id":7,"method":"click","params":{...}}
//   ra:   {"id":7,"result":{...}} | {"id":7,"error":{"code":"web_stale_ref","message":"..."}}
//         {"event":"closed","session":"web-a"}   (trình duyệt/trang của phiên đã đóng)
// Mỗi phiên (một hồ sơ trình duyệt) giữ một trình duyệt + context + trang ấm. stdout chỉ dành cho NDJSON;
// mọi log đi stderr. Không có evaluate hay chạy JS tuỳ ý: chỉ các phương thức trong bảng handlers.
// Chạy qua bootstrap.mjs (cổng "start", tự thoát khi stdin đóng).

import { createRequire } from 'node:module';
import readline from 'node:readline';
import { allowedHosts, hostAllowed, installGuard, isChromiumFamily, resolverRules } from './guard.mjs';
import { compactSnapshot, filterSnapshot, normalizeBoxes } from './boxes.mjs';
import { locatorFrom } from './locator.mjs';
import { validateSpec } from './validate.mjs';

const require = createRequire(import.meta.url);
const playwright = require('playwright-core');

// stdout chỉ cho NDJSON: thư viện nào lỡ console.log cũng sang stderr
console.log = console.info = console.debug = (...a) => console.error(...a);

const GEN = /^\d+$/.test(process.env.CQS_SIDECAR_GEN ?? '') ? process.env.CQS_SIDECAR_GEN : '0';
const ACTION_TIMEOUT = 10_000;
const NAV_TIMEOUT = 25_000;
const MAX_SNAPSHOT = 20_000; // ký tự snapshot rút gọn trả kèm mỗi thao tác
const MAX_SOFT_BLOCKS = 10;
// Lớp chặn DNS (--host-resolver-rules) cho họ Chromium. Bật theo kết quả thử nghiệm chặn mạng.
const DNS_GUARD = true;

const sessions = new Map(); // id -> session
const opening = new Map(); // id -> Promise (gộp các lệnh open đồng thời)
let counter = 0;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const nextSnapshotId = () => `${GEN}-${++counter}`;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function firstLines(msg, n = 6) {
  return String(msg ?? '')
    .split('\n')
    .slice(0, n)
    .join('\n')
    .slice(0, 1000);
}

function toRpcError(e) {
  if (e instanceof RpcError) return { code: e.code, message: e.message };
  if (e?.code === 'invalid') return { code: 'invalid', message: e.message };
  const msg = firstLines(e?.message);
  if (e?.name === 'TimeoutError') return { code: 'invalid', message: 'quá thời gian chờ: ' + msg };
  if (/strict mode violation/i.test(msg)) return { code: 'invalid', message: msg };
  if (/Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i.test(msg)) {
    return { code: 'unknown_session', message: msg };
  }
  return { code: 'web_sidecar_failed', message: msg || String(e) };
}

function str(v, what, max = 2000) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new RpcError('invalid', `${what} không hợp lệ`);
  return v;
}

function unit(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new RpcError('invalid', `${what} phải là số trong 0..1`);
  }
  return v;
}

function need(params) {
  const id = str(params.session, 'session', 100);
  const s = sessions.get(id);
  if (!s) throw new RpcError('unknown_session', `phiên ${id} không tồn tại`);
  return s;
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)))]).finally(() =>
    clearTimeout(t),
  );
}

// ---- phiên ----

function sessionClosed(s) {
  if (sessions.get(s.id) !== s) return;
  sessions.delete(s.id);
  send({ event: 'closed', session: s.id });
  s.browser.close().catch(() => {});
}

async function launch(id, profile) {
  const browserName = profile?.browser;
  if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new RpcError('invalid', `trình duyệt "${browserName}"`);
  const width = profile.width;
  const height = profile.height;
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new RpcError('invalid', 'viewport không hợp lệ');
  const hosts = allowedHosts(profile.allowedHosts, profile.baseURL);
  const opts = { headless: profile.headless !== false };
  if (browserName === 'chromium') {
    // Chromium tải về phải mở bằng channel 'chromium' (bản đầy đủ chạy headless); msedge/chrome là kênh có sẵn.
    opts.channel = profile.channel || 'chromium';
    if (DNS_GUARD && isChromiumFamily(browserName)) opts.args = [`--host-resolver-rules=${resolverRules(hosts)}`];
  }
  const browser = await playwright[browserName].launch(opts);
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      baseURL: profile.baseURL || undefined,
      acceptDownloads: false,
      serviceWorkers: 'block', // service worker đi vòng qua route
    });
    context.setDefaultTimeout(ACTION_TIMEOUT);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT);
    const s = {
      id,
      key: JSON.stringify(profile),
      browser,
      context,
      page: null,
      hosts,
      baseURL: profile.baseURL || '',
      testIdAttribute: profile.testIdAttribute || 'data-testid',
      snapId: null,
      blocks: [],
    };
    await installGuard(context, hosts, { mainPage: () => s.page, onBlock: (b) => s.blocks.push(b) });
    const page = await context.newPage();
    s.page = page;
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) s.snapId = nextSnapshotId(); // ref của snapshot cũ hết hiệu lực
    });
    page.on('close', () => sessionClosed(s));
    browser.on('disconnected', () => sessionClosed(s));
    return s;
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

async function open(params) {
  const id = str(params.session, 'session', 100);
  if (opening.has(id)) await opening.get(id).catch(() => {});
  const key = JSON.stringify(params.profile ?? null);
  const cur = sessions.get(id);
  if (cur && cur.key === key) return {};
  if (cur) {
    sessions.delete(id);
    await cur.browser.close().catch(() => {});
  }
  const p = launch(id, params.profile);
  opening.set(id, p);
  try {
    sessions.set(id, await p);
  } finally {
    opening.delete(id);
  }
  return {};
}

async function close(params) {
  const id = str(params.session, 'session', 100);
  const s = sessions.get(id);
  if (!s) return {};
  sessions.delete(id);
  await s.browser.close().catch(() => {});
  return {};
}

// ---- đọc màn hình ----

async function takeSnapshot(s, { depth, query } = {}) {
  const opts = { mode: 'ai', boxes: true };
  if (depth !== undefined) {
    if (!Number.isInteger(depth) || depth < 1 || depth > 100) throw new RpcError('invalid', 'depth không hợp lệ');
    opts.depth = depth;
  }
  const vp = s.page.viewportSize() ?? { width: 0, height: 0 };
  let text = normalizeBoxes(await s.page.ariaSnapshot(opts), vp.width, vp.height);
  if (query !== undefined && query !== '') text = filterSnapshot(text, str(query, 'query', 200));
  s.snapId = nextSnapshotId();
  return { url: s.page.url(), title: await s.page.title(), viewport: vp, text, snapshotId: s.snapId };
}

async function snapshot(params) {
  return takeSnapshot(need(params), { depth: params.depth, query: params.query });
}

async function screenshot(params) {
  const s = need(params);
  const type = params.format === 'jpeg' ? 'jpeg' : 'png';
  const buf = await s.page.screenshot({ type, quality: type === 'jpeg' ? 70 : undefined, scale: 'css' });
  const vp = s.page.viewportSize() ?? { width: 0, height: 0 };
  return { data: buf.toString('base64'), width: vp.width, height: vp.height };
}

// ---- thao tác theo toạ độ (cùng nghĩa toạ độ chuẩn hoá với điện thoại) ----

async function tap(params) {
  const s = need(params);
  const vp = s.page.viewportSize();
  await s.page.mouse.click(unit(params.x, 'x') * vp.width, unit(params.y, 'y') * vp.height);
  return {};
}

// swipe như ngón tay trên điện thoại: vuốt lên là cuộn nội dung xuống (bánh xe chuột tại điểm bắt đầu).
async function swipe(params) {
  const s = need(params);
  const vp = s.page.viewportSize();
  const x1 = unit(params.x1, 'x1') * vp.width;
  const y1 = unit(params.y1, 'y1') * vp.height;
  const x2 = unit(params.x2, 'x2') * vp.width;
  const y2 = unit(params.y2, 'y2') * vp.height;
  await s.page.mouse.move(x1, y1);
  await s.page.mouse.wheel(x1 - x2, y1 - y2);
  return {};
}

async function keys(params) {
  const s = need(params);
  if (params.text !== undefined) await s.page.keyboard.type(str(params.text, 'text', 5000));
  else await s.page.keyboard.press(str(params.key, 'key', 50));
  return {};
}

// ---- thao tác theo phần tử: trả locator chuẩn hoá + snapshot sau thao tác ----

async function target(s, params) {
  const hasRef = params.ref !== undefined && params.ref !== '';
  const hasLoc = params.locator !== undefined && params.locator !== '';
  if (hasRef === hasLoc) throw new RpcError('invalid', 'cần đúng một trong ref hoặc locator');
  let loc;
  let fallback;
  if (hasRef) {
    const ref = str(params.ref, 'ref', 20);
    if (!/^[a-z0-9]+$/i.test(ref)) throw new RpcError('invalid', 'ref không hợp lệ');
    if (params.snapshotId !== s.snapId) {
      throw new RpcError('web_stale_ref', `snapshotId ${params.snapshotId ?? '(trống)'} đã cũ, hiện tại là ${s.snapId ?? '(chưa đọc)'}`);
    }
    loc = s.page.getByRef(ref);
    if ((await loc.count()) === 0) throw new RpcError('web_stale_ref', `ref ${ref} không còn trên trang`);
  } else {
    fallback = str(params.locator, 'locator', 2000);
    loc = locatorFrom(s.page, fallback, { testIdAttribute: s.testIdAttribute });
  }
  let text = fallback ?? '';
  if ((await loc.count()) > 0) {
    try {
      text = (await withTimeout(loc.normalize(), 3000)).toString();
    } catch {
      // không chuẩn hoá được (nhiều phần tử khớp...): giữ chuỗi gốc
    }
  }
  return { loc, text };
}

const HARD_BLOCKS = new Set(['navigation', 'popup', 'websocket']);
const BLOCK_LABEL = { navigation: 'điều hướng', popup: 'cửa sổ bật lên (đã đóng)', websocket: 'WebSocket' };

// act chạy một thao tác rồi đọc lại trang. Điều hướng, popup hay WebSocket tới host lạ trong lúc thao tác
// làm thao tác trả web_host_blocked; request phụ (ảnh, fetch...) bị chặn chỉ được liệt kê trong blocked.
async function act(s, fn) {
  s.blocks = [];
  let locator = '';
  let failure = null;
  try {
    locator = (await fn()) ?? '';
  } catch (e) {
    failure = e;
  }
  const hard = s.blocks.filter((b) => HARD_BLOCKS.has(b.kind));
  if (hard.length) {
    const what = hard.map((b) => `${BLOCK_LABEL[b.kind]} ${b.url}`).join('; ');
    throw new RpcError('web_host_blocked', what.slice(0, 1000));
  }
  if (failure) throw failure;
  const snap = await takeSnapshot(s);
  const hard2 = s.blocks.filter((b) => HARD_BLOCKS.has(b.kind)); // chặn xảy ra ngay sau thao tác
  if (hard2.length) {
    throw new RpcError('web_host_blocked', hard2.map((b) => `${BLOCK_LABEL[b.kind]} ${b.url}`).join('; ').slice(0, 1000));
  }
  const out = { locator, url: snap.url, snapshot: compactSnapshot(snap.text, MAX_SNAPSHOT), snapshotId: snap.snapshotId };
  const soft = s.blocks.filter((b) => !HARD_BLOCKS.has(b.kind)).map((b) => b.url);
  if (soft.length) out.blocked = [...new Set(soft)].slice(0, MAX_SOFT_BLOCKS);
  return out;
}

async function navigate(params) {
  const s = need(params);
  const raw = str(params.url, 'url', 4000);
  let u;
  try {
    u = s.baseURL ? new URL(raw, s.baseURL) : new URL(raw);
  } catch {
    throw new RpcError('invalid', `URL "${raw}" không hợp lệ`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RpcError('web_host_blocked', `${u.protocol} (chỉ http/https)`);
  if (!hostAllowed(u.hostname, s.hosts)) throw new RpcError('web_host_blocked', u.href);
  return act(s, async () => {
    await s.page.goto(u.href);
    return '';
  });
}

async function back(params) {
  const s = need(params);
  return act(s, async () => {
    await s.page.goBack();
    return '';
  });
}

async function click(params) {
  const s = need(params);
  return act(s, async () => {
    const t = await target(s, params);
    if (params.double) await t.loc.dblclick();
    else await t.loc.click();
    return t.text;
  });
}

// fill.text có thể chứa ${NAME}; Go gửi kèm vars chỉ gồm các tên được nhắc tới. Giá trị không bao giờ
// xuất hiện trong kết quả hay thông báo lỗi.
async function fill(params) {
  const s = need(params);
  const template = typeof params.text === 'string' ? params.text : str(params.text, 'text');
  const vars = params.vars && typeof params.vars === 'object' ? params.vars : {};
  const used = [];
  const value = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (typeof vars[name] !== 'string') throw new RpcError('invalid', `thiếu giá trị cho \${${name}}`);
    used.push(vars[name]);
    return vars[name];
  });
  try {
    return await act(s, async () => {
      const t = await target(s, params);
      await t.loc.fill(value);
      if (params.submit) await t.loc.press('Enter');
      return t.text;
    });
  } catch (e) {
    const err = toRpcError(e);
    for (const v of used) if (v) err.message = err.message.split(v).join('***');
    throw new RpcError(err.code, err.message);
  }
}

async function select(params) {
  const s = need(params);
  const values = params.values;
  if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== 'string')) {
    throw new RpcError('invalid', 'values phải là danh sách chuỗi');
  }
  return act(s, async () => {
    const t = await target(s, params);
    await t.loc.selectOption(values);
    return t.text;
  });
}

async function press(params) {
  const s = need(params);
  const key = str(params.key, 'key', 50);
  return act(s, async () => {
    if ((params.ref ?? '') === '' && (params.locator ?? '') === '') {
      await s.page.keyboard.press(key);
      return '';
    }
    const t = await target(s, params);
    await t.loc.press(key);
    return t.text;
  });
}

async function wait(params) {
  const s = need(params);
  const sec = params.sec === undefined ? 0 : Number(params.sec);
  if (!Number.isFinite(sec) || sec < 0 || sec > 10) throw new RpcError('invalid', 'sec phải trong 0..10');
  return act(s, async () => {
    const timeout = sec > 0 ? sec * 1000 : ACTION_TIMEOUT;
    if (params.text) await s.page.getByText(str(params.text, 'text', 500)).first().waitFor({ state: 'visible', timeout });
    else if (params.textGone) await s.page.getByText(str(params.textGone, 'textGone', 500)).first().waitFor({ state: 'hidden', timeout });
    else await new Promise((r) => setTimeout(r, sec * 1000));
    return '';
  });
}

let ts = null;
async function validate(params) {
  ts ??= require('typescript');
  const source = typeof params.source === 'string' ? params.source : '';
  const envNames = Array.isArray(params.envNames) ? params.envNames.filter((n) => typeof n === 'string') : [];
  const hosts = Array.isArray(params.allowedHosts) ? params.allowedHosts.filter((n) => typeof n === 'string') : [];
  return validateSpec(ts, source, { envNames, allowedHosts: hosts });
}

async function hello() {
  return { playwright: require('playwright-core/package.json').version, node: process.version };
}

const handlers = {
  hello,
  open,
  close,
  screenshot,
  snapshot,
  tap,
  swipe,
  keys,
  navigate,
  back,
  click,
  fill,
  select,
  press,
  wait,
  validateSpec: validate,
};

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error('sidecar: dòng không phải JSON');
    return;
  }
  const { id, method } = msg ?? {};
  if (!Number.isSafeInteger(id)) return;
  const h = typeof method === 'string' && Object.hasOwn(handlers, method) ? handlers[method] : null;
  if (!h) {
    send({ id, error: { code: 'invalid', message: `không có phương thức "${method}"` } });
    return;
  }
  try {
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    send({ id, result: (await h(params)) ?? {} });
  } catch (e) {
    send({ id, error: toRpcError(e) });
  }
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const all = [...sessions.values()];
  sessions.clear();
  await withTimeout(Promise.allSettled(all.map((s) => s.browser.close())), 2000).catch(() => {});
  process.exit(0);
}

const input = globalThis[Symbol.for('chatqa.stdin')] ?? process.stdin;
const rl = readline.createInterface({ input, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (line.trim()) handle(line);
});
rl.on('close', shutdown);
