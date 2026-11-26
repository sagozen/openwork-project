import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Reporter, { attachmentInfo, clean, errorInfo, stepDepth } from './reporter.mjs';

const step = (category, parent, title = 't') => ({ category, parent, title, duration: 12.4 });

test('stepDepth: step() cấp đầu là 0, lệnh ngay trong step() là 1, phần của app bị bỏ', () => {
  const top = step('test.step');
  assert.equal(stepDepth(top), 0);
  assert.equal(stepDepth(step('pw:api', top)), 1);
  assert.equal(stepDepth(step('expect', top)), 1);
  // lệnh lồng sâu hơn, lệnh ngoài step(), attach, fixture và hook của app không phải bước của flow
  assert.equal(stepDepth(step('pw:api', step('pw:api', top))), -1);
  assert.equal(stepDepth(step('pw:api')), -1);
  assert.equal(stepDepth(step('attach', top)), -1);
  const fixture = step('fixture');
  assert.equal(stepDepth(step('pw:api', fixture)), -1);
  assert.equal(stepDepth(step('test.step', fixture)), -1);
  assert.equal(stepDepth(step('pw:api', step('test.step', step('hook')))), -1);
});

test('clean bỏ mã màu và cắt chuỗi dài', () => {
  assert.equal(clean('\u001b[31mError\u001b[39m: x'), 'Error: x');
  assert.equal(clean('a'.repeat(10), 4), 'aaaa…');
  assert.deepEqual(errorInfo({ message: '\u001b[2mexpect\u001b[22m', location: { line: 7 }, snippet: 's' }), {
    message: 'expect',
    line: 7,
    snippet: 's',
  });
  assert.equal(errorInfo(undefined), undefined);
});

test('attachmentInfo giữ đường dẫn, chỉ chép thân của attachment văn bản', () => {
  assert.deepEqual(attachmentInfo({ name: 'failure-url', contentType: 'text/plain', body: Buffer.from('http://a.test/x') }), {
    name: 'failure-url',
    contentType: 'text/plain',
    body: 'http://a.test/x',
  });
  assert.deepEqual(attachmentInfo({ name: 'cqs-after', contentType: 'image/png', path: '/w/a.png', body: Buffer.from([1, 2]) }), {
    name: 'cqs-after',
    contentType: 'image/png',
    path: '/w/a.png',
  });
});

test('reporter ghi NDJSON đúng thứ tự, giới hạn log, đóng file ở end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-reporter-'));
  const out = path.join(dir, 'report.ndjson');
  const r = new Reporter({ output: out });
  assert.equal(r.printsToStdio(), true);
  const t = { id: 't1', title: 'đăng nhập' };
  r.onBegin({}, { allTests: () => [t] });
  const top = step('test.step', undefined, 'mở trang');
  r.onStepEnd(t, {}, step('pw:api', top, 'Navigate'));
  r.onStepEnd(t, {}, step('pw:api', step('fixture'), 'Screenshot'));
  r.onStepEnd(t, {}, top);
  for (let i = 0; i < 80; i++) r.onStdErr(`dòng ${i}\n`);
  r.onTestEnd(t, {
    status: 'failed',
    duration: 1500,
    error: { message: 'Error: expect(locator).toBeVisible() failed', location: { line: 9 } },
    errors: [{ message: 'a' }],
    attachments: [{ name: 'trace', contentType: 'application/zip', path: '/w/trace.zip' }],
  });
  r.onError({ message: 'Error: No tests found' });
  await r.onEnd({ status: 'failed' });
  r.write({ type: 'after' }); // sau end không ghi gì nữa
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const types = lines.map((l) => l.type);
  assert.deepEqual(types.slice(0, 3), ['begin', 'step', 'step']);
  assert.equal(types.filter((x) => x === 'log').length, 50);
  assert.deepEqual(types.slice(-3), ['test', 'error', 'end']);
  assert.deepEqual(lines[1], { type: 'step', test: 't1', depth: 1, title: 'Navigate', category: 'pw:api', durationMs: 12 });
  assert.equal(lines[2].depth, 0);
  const tl = lines.find((l) => l.type === 'test');
  assert.equal(tl.status, 'failed');
  assert.equal(tl.error.line, 9);
  assert.equal(tl.attachments[0].path, '/w/trace.zip');
  fs.rmSync(dir, { recursive: true, force: true });
});
