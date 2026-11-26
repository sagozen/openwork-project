import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocator, buildLocator } from './locator.mjs';

// recorder ghi lại chuỗi lời gọi mà buildLocator thực hiện (Locator thật được kiểm ở test tích hợp).
function recorder(path = []) {
  return new Proxy(
    {},
    {
      get(_, name) {
        if (name === 'path') return path;
        return (...args) => recorder([...path, [name, ...args]]);
      },
    },
  );
}

test('nhận lại đúng chuỗi do locator.normalize() trả về', () => {
  const cases = {
    "getByRole('button', { name: 'Sign in' })": [['getByRole', 'button', { name: 'Sign in' }]],
    "getByRole('link', { name: 'Đăng nhập', exact: true })": [['getByRole', 'link', { name: 'Đăng nhập', exact: true }]],
    "locator('iframe').contentFrame().getByRole('button', { name: 'Inner' })": [
      ['locator', 'iframe'],
      ['contentFrame'],
      ['getByRole', 'button', { name: 'Inner' }],
    ],
    "getByText('Xin chào')": [['getByText', 'Xin chào']],
    "getByLabel('Email').first()": [['getByLabel', 'Email'], ['first']],
    "getByTestId('submit').nth(2)": [['getByTestId', 'submit'], ['nth', 2]],
    "page.getByPlaceholder(\"Tìm kiếm\")": [['getByPlaceholder', 'Tìm kiếm']],
    "frameLocator('#pay').getByText('OK').last()": [['frameLocator', '#pay'], ['getByText', 'OK'], ['last']],
    "locator('div').filter({ hasText: 'Sữa' })": [['locator', 'div'], ['filter', { hasText: 'Sữa' }]],
    "getByRole('heading', { level: 2, name: 'A' })": [['getByRole', 'heading', { level: 2, name: 'A' }]],
    "getByText('it\\'s')": [['getByText', "it's"]],
    'getByText(`tab\\u0041`)': [['getByText', 'tabA']],
    "getByRole('button', { name: 'X', })": [['getByRole', 'button', { name: 'X' }]],
  };
  for (const [src, want] of Object.entries(cases)) {
    const got = buildLocator(recorder(), parseLocator(src)).path;
    assert.deepEqual(got, want, src);
  }
});

test('regex được dựng thành RegExp, không eval', () => {
  const [[, re]] = buildLocator(recorder(), parseLocator('getByText(/^Tổng: \\d+$/i)')).path;
  assert.ok(re instanceof RegExp);
  assert.equal(re.source, '^Tổng: \\d+$');
  assert.equal(re.flags, 'i');
  const [[, , opts]] = buildLocator(recorder(), parseLocator("getByRole('button', { name: /lưu/ })")).path;
  assert.ok(opts.name instanceof RegExp);
});

test('getByTestId dùng thuộc tính test id của hồ sơ', () => {
  const def = buildLocator(recorder(), parseLocator("getByTestId('x')")).path;
  assert.deepEqual(def, [['getByTestId', 'x']]);
  const own = buildLocator(recorder(), parseLocator('getByTestId(\'a"b\')'), { testIdAttribute: 'data-qa' }).path;
  assert.deepEqual(own, [['locator', 'internal:testid=[data-qa="a\\"b"s]']]);
  assert.throws(() => buildLocator(recorder(), parseLocator('getByTestId(/x/)'), { testIdAttribute: 'data-qa' }), { code: 'invalid' });
});

test('từ chối mọi thứ ngoài ngữ pháp', () => {
  const rejected = [
    '',
    'evaluate(() => 1)',
    "getByRole('button').evaluate('1')",
    "locator('a').click()",
    "getByRef('e1')",
    "page.context()",
    "getByText('a').constructor",
    "getByText('a')['first']()",
    "getByText('a').first",
    "getByText(`${x}`)",
    'getByText(x)',
    "getByText('a', { hasText: 'b' })",
    "getByRole('button', { name: 'a', evil: 1 })",
    "getByRole(1)",
    "getByText('a').nth(1.5)",
    "getByText('a').nth('1')",
    "getByText('a') getByText('b')",
    "getByText('a');getByText('b')",
    "frameLocator('#f')",
    "locator('iframe').contentFrame()",
    "getByText('a').contentFrame().first()",
    "contentFrame()",
    "first()",
    "getByText('a', 'b', 'c')",
    "getByText()",
    "getByText('a'",
    "getByText('a)",
    "getByText(/a/g)",
    `getByText(/${'a'.repeat(250)}/)`,
    "getByText(/(/)",
    "getByText('\\x41')",
    "window.getByText('a')",
    "page.page.getByText('a')",
    "getByText('a').filter({ has: getByText('b') })",
    'x'.repeat(2001),
    "getByText('a') + getByText('b')",
    "getByText('a') || 1",
  ];
  for (const src of rejected) {
    assert.throws(() => parseLocator(src), (e) => e.code === 'invalid', `phải từ chối: ${src.slice(0, 80)}`);
  }
});
