// Kiểm tra fixture của gói xuất chạy độc lập: cùng tên export với fixture trong app và không đụng tới gì của app.
// Node 23.6+ tự bỏ kiểu TypeScript khi nạp .ts; @playwright/test nạp từ node_modules gốc của repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as standalone from './chatqa_standalone.ts';
import * as inApp from './chatqa.ts';

test('xuất đúng test, expect, step như fixture trong app', () => {
  for (const name of ['test', 'expect', 'step']) {
    assert.equal(typeof standalone[name], 'function', name);
    assert.equal(typeof inApp[name], 'function', name);
  }
  assert.deepEqual(Object.keys(standalone).sort(), ['expect', 'step', 'test']);
});

test('không có biến, ảnh live hay chặn host của app', () => {
  const src = fs.readFileSync(new URL('./chatqa_standalone.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  for (const s of ['CQS_', 'guard', 'process.env', 'screenshot', 'route']) assert.equal(code.includes(s), false, s);
});
