import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBoxes, filterSnapshot, compactSnapshot } from './boxes.mjs';
import { hostAllowed, requestAllowed, navigationAllowed, resolverRules, allowedHosts } from './guard.mjs';

// Mẫu thật từ Playwright 1.64 (ariaSnapshot mode ai, boxes), viewport 1000x500.
const SNAP = `- generic [active] [ref=e1] [box=8,8,984,484]:
  - heading "Hi" [level=1] [ref=e2] [box=8,8,984,37]
  - generic [ref=e3] [box=8,206,195,18]:
    - text: Email
    - textbox "Email" [ref=e4] [box=50,205,153,21]
  - button "Sign in" [ref=e5] [box=203,205,57,21]
  - iframe [ref=e7] [box=286,66,304,154]:
    - button "Inner" [ref=f1e2] [box=8,8,46,21]
  - button "After" [ref=e8] [box=600,400,100,50]`;

test('hộp chuẩn hoá theo viewport, phần tử trong iframe cộng gốc iframe', () => {
  const out = normalizeBoxes(SNAP, 1000, 500).split('\n');
  assert.match(out[0], /\[box=0\.008,0\.016,0\.984,0\.968\]/);
  assert.match(out[4], /textbox "Email" \[ref=e4\] \[box=0\.05,0\.41,0\.153,0\.042\]/);
  assert.match(out[6], /iframe \[ref=e7\] \[box=0\.286,0\.132,0\.304,0\.308\]/);
  assert.match(out[7], /button "Inner" \[ref=f1e2\] \[box=0\.294,0\.148,0\.046,0\.042\]/);
  // ra khỏi iframe thì không cộng gốc nữa
  assert.match(out[8], /button "After" \[ref=e8\] \[box=0\.6,0\.8,0\.1,0\.1\]/);
  for (const l of out) {
    const m = /\[box=([^\]]+)\]/.exec(l);
    if (m) for (const v of m[1].split(',').map(Number)) assert.ok(v >= 0 && v <= 1, l);
  }
  assert.equal(normalizeBoxes(SNAP, 0, 0), SNAP, 'viewport không rõ thì giữ nguyên');
});

test('iframe lồng nhau cộng dồn gốc', () => {
  const s = `- iframe [ref=e1] [box=100,100,500,300]:
  - iframe [ref=f1e1] [box=10,20,200,100]:
    - button "Deep" [ref=f2e1] [box=1,2,3,4]`;
  const out = normalizeBoxes(s, 1000, 1000).split('\n');
  assert.match(out[2], /\[box=0\.111,0\.122,0\.003,0\.004\]/);
});

test('lọc theo truy vấn giữ dòng tổ tiên', () => {
  const out = filterSnapshot(SNAP, 'email');
  assert.deepEqual(out.split('\n'), [
    '- generic [active] [ref=e1] [box=8,8,984,484]:',
    '  - generic [ref=e3] [box=8,206,195,18]:',
    '    - text: Email',
    '    - textbox "Email" [ref=e4] [box=50,205,153,21]',
  ]);
  assert.equal(filterSnapshot(SNAP, ''), SNAP);
});

test('rút gọn chỉ khi quá dài: giữ dòng có ref và tên', () => {
  assert.equal(compactSnapshot(SNAP, 10_000), SNAP);
  const out = compactSnapshot(SNAP, 300);
  assert.ok(!out.includes('text: Email') && !out.includes('generic [ref=e3]'));
  assert.ok(out.includes('button "Sign in"'));
  assert.ok(compactSnapshot(SNAP, 20).length <= 22);
});

test('so khớp host: đúng tên, *.domain chỉ gồm tên miền con', () => {
  const hosts = ['app.example.com', '*.staging.example.com', 'localhost'];
  assert.ok(hostAllowed('app.example.com', hosts));
  assert.ok(hostAllowed('APP.example.com.', hosts));
  assert.ok(hostAllowed('a.b.staging.example.com', hosts));
  assert.ok(hostAllowed('localhost', hosts));
  assert.ok(!hostAllowed('staging.example.com', hosts));
  assert.ok(!hostAllowed('xstaging.example.com', hosts));
  assert.ok(!hostAllowed('app.example.com.evil.test', hosts));
  assert.ok(!hostAllowed('evil.test', hosts));
  assert.ok(!hostAllowed('', hosts));
  assert.ok(!hostAllowed('127.0.0.1', hosts));
});

test('request và điều hướng theo scheme', () => {
  const hosts = ['app.example.com'];
  assert.ok(requestAllowed('https://app.example.com/a', hosts));
  assert.ok(requestAllowed('wss://app.example.com/ws', hosts));
  assert.ok(requestAllowed('data:image/png;base64,AA', hosts));
  assert.ok(!requestAllowed('http://evil.test/', hosts));
  assert.ok(!requestAllowed('ws://127.0.0.1:9/', hosts));
  assert.ok(!requestAllowed('file:///etc/passwd', hosts));
  assert.ok(!requestAllowed('not a url', hosts));
  assert.ok(navigationAllowed('about:blank', hosts));
  assert.ok(navigationAllowed('chrome-error://chromewebdata/', hosts));
  assert.ok(navigationAllowed('https://app.example.com/', hosts));
  assert.ok(!navigationAllowed('https://evil.test/', hosts));
  assert.ok(!navigationAllowed('data:text/html,x', hosts));
  assert.ok(!navigationAllowed('file:///tmp/x.html', hosts));
  assert.ok(!navigationAllowed('javascript:alert(1)', hosts));
});

test('host của baseURL luôn được phép; luật phân giải của Chromium', () => {
  assert.deepEqual(allowedHosts(['A.example.com', ''], 'http://localhost:3000/app').sort(), ['a.example.com', 'localhost']);
  assert.equal(resolverRules(['app.example.com', '*.staging.example.com']), 'MAP * ~NOTFOUND, EXCLUDE app.example.com, EXCLUDE *.staging.example.com');
  assert.equal(resolverRules(['bad host,MAP * 1.2.3.4']), 'MAP * ~NOTFOUND', 'mục lạ không được chèn luật');
});
