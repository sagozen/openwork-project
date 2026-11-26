// Fixture của ChatQA cho flow web .spec.ts. Flow chỉ được import { test, expect, step } from './chatqa' và chỉ chạy
// dưới ChatQA (cấu hình, reporter và biến môi trường do app dựng cho từng lượt).
//
//   - fixture worker: chép CQS_VAR_<TÊN> thành process.env.TÊN trước khi thân test chạy. App không bao giờ đặt biến
//     của người dùng dưới tên thật trong môi trường tiến trình, và tên dành riêng (NODE_*, CQS_*, *_PROXY...) bị bỏ.
//   - fixture test tự động: chặn mạng ngoài host được phép (route, WebSocket, popup, điều hướng; giống sidecar),
//     ảnh live xoay vòng live-0..2.jpg vào CQS_LIVE_DIR (lỗi ghi bị bỏ qua), ảnh đầu, và khi test lỗi thì ảnh lỗi,
//     aria snapshot và URL của trang.
//   - step(tên, fn): bọc test.step; điều hướng/popup/WebSocket bị chặn trong bước làm bước lỗi web_host_blocked;
//     CQS_STEP_SHOTS=always thì chụp ảnh sau mỗi bước đạt.

import { test as base, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { installGuard } from './guard.mjs';

export { expect };

const VAR_PREFIX = 'CQS_VAR_';
const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HARD = new Set(['navigation', 'popup', 'websocket']);
const LIVE_EVERY_MS = 500;
const LIVE_FRAMES = 3;
const SHOT_TIMEOUT = 5000;

type Block = { kind: string; url: string };

// reservedName: cùng luật với app (pw.ReservedVar): biến điều khiển Node, Playwright, app, trình nạp thư viện, proxy.
export function reservedName(name: string): boolean {
  return name === 'PWDEBUG' || /^(NODE_|PLAYWRIGHT_|PW_|CQS_|DYLD_|LD_)/.test(name) || name.endsWith('_PROXY');
}

// copyVars chép CQS_VAR_<TÊN> sang TÊN (tên hợp lệ, không dành riêng) và trả các tên đã chép.
export function copyVars(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(VAR_PREFIX) || value === undefined) continue;
    const name = key.slice(VAR_PREFIX.length);
    if (!NAME_RE.test(name) || reservedName(name)) continue;
    env[name] = value;
    out.push(name);
  }
  return out.sort();
}

export function parseHosts(raw: string | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((h) => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

// Trạng thái của test đang chạy (một worker chạy một test một lúc).
const state: { page: Page | null; blocks: Block[]; reported: number; shot: number } = {
  page: null,
  blocks: [],
  reported: 0,
  shot: 0,
};

function hardSince(from: number): Block[] {
  return state.blocks.slice(from).filter((b) => HARD.has(b.kind));
}

function blockedError(blocks: Block[]): Error {
  const what = blocks.map((b) => `${b.kind} ${b.url}`).join('; ').slice(0, 1000);
  return new Error(`web_host_blocked: ${what}`);
}

async function attachShot(page: Page, info: TestInfo, name: string): Promise<void> {
  try {
    const file = info.outputPath(`${name}-${++state.shot}.png`);
    await page.screenshot({ path: file, timeout: SHOT_TIMEOUT, caret: 'initial' });
    await info.attach(name, { path: file, contentType: 'image/png' });
  } catch {
    // trang đã đóng hay đang chuyển: thiếu một ảnh không làm lỗi flow
  }
}

// startLive chụp JPEG khoảng 2 hình/giây vào live-0..2.jpg của dir, ghi đè xoay vòng. App đọc file mới nhất giải được;
// lỗi ghi (file đang bị đọc, Windows EPERM) chỉ làm mất một hình.
function startLive(page: Page, dir: string | undefined): () => void {
  if (!dir) return () => {};
  let n = 0;
  let busy = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 2000, caret: 'initial' });
      if (!stopped) await fs.promises.writeFile(path.join(dir, `live-${n++ % LIVE_FRAMES}.jpg`), buf);
    } catch {
      // bỏ qua hình này
    }
    busy = false;
  }, LIVE_EVERY_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)))]).finally(() =>
    clearTimeout(t),
  );
}

type WorkerFixtures = { cqsVars: void };
type TestFixtures = { cqsGuard: void };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  cqsVars: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      copyVars(process.env);
      await use();
    },
    { scope: 'worker', auto: true },
  ],
  cqsGuard: [
    async ({ context, page }, use, info) => {
      state.page = page;
      state.blocks = [];
      state.reported = 0;
      await installGuard(context, parseHosts(process.env.CQS_ALLOWED_HOSTS), {
        mainPage: () => page,
        onBlock: (b: Block) => state.blocks.push(b),
      });
      const mode = process.env.CQS_STEP_SHOTS ?? 'on-failure';
      const stopLive = startLive(page, process.env.CQS_LIVE_DIR);
      if (mode === 'always') await attachShot(page, info, 'cqs-initial');
      try {
        await use();
      } finally {
        stopLive();
      }
      if (info.status !== info.expectedStatus) {
        if (mode !== 'never') await attachShot(page, info, 'cqs-failure');
        try {
          const aria = await withTimeout(page.ariaSnapshot({ mode: 'ai' }), SHOT_TIMEOUT);
          await info.attach('failure-aria', { body: aria, contentType: 'text/plain' });
        } catch {
          // trang đã đóng
        }
        await info.attach('failure-url', { body: page.url(), contentType: 'text/plain' }).catch(() => {});
      }
      state.page = null;
      const left = hardSince(state.reported);
      if (left.length) throw blockedError(left); // chặn ngoài mọi step() (beforeEach, sau bước cuối)
    },
    { auto: true },
  ],
});

// step chạy một bước có tên của flow. Mọi thao tác của flow nằm trong step().
export async function step(title: string, fn: () => Promise<void>): Promise<void> {
  await test.step(title, async () => {
    const mark = state.blocks.length;
    let failure: unknown = null;
    try {
      await fn();
    } catch (e) {
      failure = e;
    }
    const hard = hardSince(mark);
    state.reported = state.blocks.length;
    if (hard.length) throw blockedError(hard);
    if (failure) throw failure;
  });
  if (process.env.CQS_STEP_SHOTS === 'always' && state.page) await attachShot(state.page, test.info(), 'cqs-after');
}
