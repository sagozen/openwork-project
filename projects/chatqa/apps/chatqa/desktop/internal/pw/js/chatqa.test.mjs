// Kiểm tra phần thuần của fixture ./chatqa. Node 23.6+ tự bỏ kiểu TypeScript khi nạp .ts; @playwright/test nạp từ
// node_modules gốc của repo như validate.test.mjs nạp typescript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyVars, parseHosts, reservedName } from './chatqa.ts';

test('copyVars chép CQS_VAR_<TÊN> thành TÊN, bỏ tên sai dạng và tên dành riêng', () => {
  const env = {
    CQS_VAR_PASSWORD: 's3cret',
    CQS_VAR_USER_NAME: 'an',
    CQS_VAR_NODE_OPTIONS: '--require /x.js',
    CQS_VAR_HTTPS_PROXY: 'http://p',
    CQS_VAR_DYLD_INSERT_LIBRARIES: '/x.dylib',
    CQS_VAR_PWDEBUG: '1',
    CQS_VAR_CQS_ALLOWED_HOSTS: '["*"]',
    'CQS_VAR_bad-name': 'x',
    CQS_ALLOWED_HOSTS: '["app.test"]',
    PASSWORD_HINT: 'giữ nguyên',
  };
  assert.deepEqual(copyVars(env), ['PASSWORD', 'USER_NAME']);
  assert.equal(env.PASSWORD, 's3cret');
  assert.equal(env.USER_NAME, 'an');
  for (const k of ['NODE_OPTIONS', 'HTTPS_PROXY', 'DYLD_INSERT_LIBRARIES', 'PWDEBUG', 'bad-name']) assert.equal(env[k], undefined, k);
  assert.equal(env.CQS_ALLOWED_HOSTS, '["app.test"]');
});

test('reservedName cùng luật với app', () => {
  for (const n of ['NODE_OPTIONS', 'PLAYWRIGHT_BROWSERS_PATH', 'PWDEBUG', 'PW_TEST_X', 'CQS_LIVE_DIR', 'DYLD_X', 'LD_PRELOAD', 'NO_PROXY']) {
    assert.equal(reservedName(n), true, n);
  }
  for (const n of ['PASSWORD', 'APP_ID', 'PROXY_HOST', 'PWD_HINT', 'PWX', 'PW']) assert.equal(reservedName(n), false, n);
});

test('parseHosts chỉ nhận mảng chuỗi JSON', () => {
  assert.deepEqual(parseHosts('["a.test", 3, "b.test"]'), ['a.test', 'b.test']);
  assert.deepEqual(parseHosts('{"a":1}'), []);
  assert.deepEqual(parseHosts('hỏng'), []);
  assert.deepEqual(parseHosts(undefined), []);
});
