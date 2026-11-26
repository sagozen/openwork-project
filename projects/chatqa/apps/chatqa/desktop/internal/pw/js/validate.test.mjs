import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateSpec } from './validate.mjs';

// typescript lấy từ node_modules gốc của repo (cùng phiên bản ghim trong bộ chạy).
const here = path.dirname(fileURLToPath(import.meta.url));
const ts = createRequire(path.resolve(here, '../../../../../../package.json'))('typescript');

const opts = { envNames: ['USER_EMAIL', 'USER_PASS'], allowedHosts: ['app.example.com', '*.staging.example.com'] };
const HEAD = "import { test, expect, step } from './chatqa';\n";

function run(src, o = opts) {
  return validateSpec(ts, src, o);
}

// wrap đặt các câu lệnh vào một bước của một test.
function wrap(stmts) {
  return `${HEAD}test('t', async ({ page }) => {\n  await step('s', async () => {\n    ${stmts}\n  });\n});\n`;
}

function ok(src, o) {
  const r = run(src, o);
  assert.deepEqual(r.errors, [], `phải hợp lệ:\n${src}\n${JSON.stringify(r.errors)}`);
  return r;
}

function bad(src, re) {
  const r = run(src);
  assert.ok(r.errors.length > 0, `phải bị từ chối:\n${src}`);
  if (re) assert.ok(r.errors.some((e) => re.test(e.message)), `thông báo không khớp ${re}: ${JSON.stringify(r.errors)}`);
  for (const e of r.errors) assert.ok(e.line >= 1 && e.col >= 1, 'lỗi phải có dòng/cột');
  return r;
}

test('spec đầy đủ hợp lệ, trả envUsed và các bước', () => {
  const src = `${HEAD}
test.describe('đăng nhập', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });
  test('đúng mật khẩu', async ({ page }) => {
    await step('Mở trang đăng nhập', async () => {
      await page.goto('/login');
      await expect(page).toHaveURL('https://app.example.com/login');
    });
    await step('Nhập tài khoản', async () => {
      const email = page.getByLabel('Email');
      await email.fill(process.env.USER_EMAIL);
      await page.getByLabel('Mật khẩu').pressSequentially(process.env.USER_PASS);
      await page.keyboard.type(process.env.USER_EMAIL);
      await page.keyboard.press('Enter');
    });
    await step('Thấy bảng điều khiển', async () => {
      const n = await page.getByRole('row').count();
      if (n > 0 && !(await page.getByText(/lỗi/i).isVisible())) {
        await expect(page.getByRole('heading', { name: 'Bảng điều khiển', exact: true })).toBeVisible();
      } else if (n === 0) {
        await expect.soft(page.getByTestId('empty')).not.toBeHidden();
      } else {
        await page.locator('iframe').contentFrame().getByRole('button', { name: 'OK' }).first().click();
      }
      await page.getByRole('combobox').selectOption(['a', 'b']);
      await page.frameLocator('#f').getByText('x').nth(1).click();
      await page.getByRole('listitem').filter({ hasText: 'Sữa' }).last().hover();
      await page.mouse.click(10, 20);
      await page.waitForURL('https://a.staging.example.com/done');
      await expect(page.getByRole('list')).toMatchAriaSnapshot(\`- listitem: a\`);
    });
  });
});
`;
  const r = ok(src);
  assert.deepEqual(r.envUsed, ['USER_EMAIL', 'USER_PASS']);
  assert.deepEqual(r.steps.map((s) => s.title), ['Mở trang đăng nhập', 'Nhập tài khoản', 'Thấy bảng điều khiển']);
});

test('khoảng byte của bước tính theo UTF-8, kể cả tên bước có dấu', () => {
  const src = `${HEAD}test('t', async ({ page }) => {\n  await step('Bước một: đăng nhập ✓', async () => {\n    await page.goto('/');\n  });\n  await step('Hai', async () => {\n    await page.reload();\n  });\n});\n`;
  const r = ok(src);
  const buf = Buffer.from(src, 'utf8');
  const first = buf.subarray(r.steps[0].startByte, r.steps[0].endByte).toString('utf8');
  assert.ok(first.startsWith("await step('Bước một: đăng nhập ✓'") && first.endsWith('});'), first);
  const second = buf.subarray(r.steps[1].startByte, r.steps[1].endByte).toString('utf8');
  assert.ok(second.startsWith("await step('Hai'") && second.endsWith('});'), second);
  assert.equal(r.steps[0].line, 3);
  assert.equal(r.steps[1].line, 6);
  // bước hai đứng sau tên bước một có chữ nhiều byte: byte phải lớn hơn chỉ số ký tự
  assert.ok(r.steps[1].startByte > src.indexOf("await step('Hai'"));
});

test('byte khác chỉ số ký tự khi có ký tự nhiều byte phía trước', () => {
  const src = `${HEAD}test('Kiểm thử đơn hàng', async ({ page }) => {\n  await step('Mở', async () => {\n    await page.goto('/');\n  });\n});\n`;
  const r = ok(src);
  const charIdx = src.indexOf("await step('Mở'");
  assert.equal(r.steps[0].startByte, Buffer.byteLength(src.slice(0, charIdx), 'utf8'));
  assert.ok(r.steps[0].startByte > charIdx);
});

test('import: chỉ { test, expect, step } từ ./chatqa', () => {
  ok("import { test, step } from './chatqa';\ntest('t', async ({ page }) => {\n  await step('s', async () => {\n    await page.reload();\n  });\n});\n");
  const body = "\ntest('t', async ({ page }) => {});\n";
  bad("import { test } from '@playwright/test';" + body, /chatqa/);
  bad("import { test as t } from './chatqa';" + body, /đổi tên/);
  bad("import test from './chatqa';" + body);
  bad("import * as x from './chatqa';" + body);
  bad("import type { test } from './chatqa';" + body);
  bad("import { test, fs } from './chatqa';" + body);
  bad(HEAD + "import { test } from './chatqa';" + body, /một câu import/);
  bad("import fs = require('fs');" + body);
  bad("test('t', async ({ page }) => {});", /thiếu import/);
  bad(HEAD + "export const x = 1;", /cấp ngoài/);
  bad(HEAD + 'export default {};', /cấp ngoài/);
});

test('cấp ngoài: chỉ test, test.describe, test.beforeEach', () => {
  bad(HEAD + "test.use({ baseURL: 'http://evil.test' });", /cấp ngoài/);
  bad(HEAD + "test.only('t', async ({ page }) => {});", /cấp ngoài/);
  bad(HEAD + "test.afterEach(async ({ page }) => {});", /cấp ngoài/);
  bad(HEAD + 'const x = 1;', /cấp ngoài/);
  bad(HEAD + "console.log('x');", /cấp ngoài/);
  bad(HEAD + "test('t', async ({ page, request }) => {});", /\{ page \}/);
  bad(HEAD + "test('t', async ({ page: p }) => {});", /\{ page \}/);
  bad(HEAD + "test('t', async ({ context }) => {});", /\{ page \}/);
  bad(HEAD + "test('t', ({ page }) => {});", /async/);
  bad(HEAD + "test('t', async function ({ page }) {});", /mũi tên/);
  bad(HEAD + "test(`t${1}`, async ({ page }) => {});", /chuỗi/);
  bad(HEAD + "test.describe('d', async () => {});", /không được là async/);
});

test('thân test: chỉ các bước await step', () => {
  bad(wrap('').replace("await step('s', async () => {\n    \n  });", 'await page.goto("/");'), /chỉ gồm các bước/);
  bad(`${HEAD}test('t', async ({ page }) => {\n  step('s', async () => {});\n});`, /chỉ gồm các bước/);
  bad(`${HEAD}test('t', async ({ page }) => {\n  await step(name, async () => {});\n});`, /chuỗi/);
  bad(`${HEAD}test('t', async ({ page }) => {\n  await step('s', async (x) => {});\n});`, /không nhận tham số/);
  bad(`${HEAD}test('t', async ({ page }) => {\n  await step('a', async () => {\n    await step('b', async () => {});\n  });\n});`, /đúng chỗ/);
});

test('thân bước: cấm vòng lặp, let/var, gán, try, throw, return, delete, phẩy, this, spread, new, with, nhãn', () => {
  const cases = [
    ['for (;;) {}', /vòng lặp/],
    ['while (true) {}', /vòng lặp/],
    ['do {} while (false);', /vòng lặp/],
    ['for (const x of [1]) {}', /vòng lặp/],
    ['let x = 1;', /const/],
    ['var x = 1;', /const/],
    ['const x = 1; x = 2;', /await/],
    ['await (x = 1);', /toán tử/],
    ['try { await page.reload(); } catch {}', /try/],
    ["throw new Error('x');", /throw/],
    ['return 1;', /return/],
    ['await delete page.x;', /delete/],
    ['await (page.reload(), page.reload());', /toán tử/],
    ['await this.x;', /this/],
    ['await page.goto(...a);', /spread|URL/],
    ["await page.getByText(...['a']);", /spread/],
    ['await new Promise(() => {});', /new/],
    ['l: await page.reload();', /nhãn/],
    ['const { a } = page;', /destructuring/],
    ['const x: number = 1;', /kiểu/],
    ['const page2 = 1, y = 2;', /một tên/],
    ['const page = 1;', /bị cấm/],
    ['if (true) await page.reload();', /\{ \}/],
    ['await page.reload()', null], // thiếu ; vẫn là câu await hợp lệ
  ];
  for (const [s, re] of cases) {
    if (re === null) ok(wrap(s));
    else bad(wrap(s), re);
  }
  bad(`${HEAD}test('t', async ({ page }) => {\n  await step('s', async () => {\n    with (page) {}\n  });\n});`);
});

test('URL: chuỗi thường, tương đối hoặc http(s) tới host được phép', () => {
  ok(wrap("await page.goto('/a?b=1#c');"));
  ok(wrap("await page.goto('https://app.example.com/x');"));
  ok(wrap("await page.goto('http://app.example.com:8080/x');"));
  ok(wrap("await page.goto('https://deep.a.staging.example.com/');"));
  ok(wrap("await page.waitForURL('/done');"));
  ok(wrap("await expect(page).toHaveURL('/done');"));
  const rejected = [
    ["await page.goto('https://evil.test/');", /host "evil.test"/],
    ["await page.goto('https://staging.example.com/');", /host/], // *.domain không gồm chính domain
    ["await page.goto('https://app.example.com.evil.test/');", /host/],
    ["await page.goto('//evil.test/x');", /host khác/],
    ["await page.goto('/\\\\evil.test/x');", /host khác/],
    ["await page.goto('data:text/html,<script>fetch(1)</script>');", /scheme/],
    ["await page.goto('file:///etc/passwd');", /scheme/],
    ["await page.goto('javascript:alert(1)');", /scheme/],
    ["await page.goto('blob:https://app.example.com/1');", /scheme/],
    ["await page.goto('about:blank');", /scheme/],
    ["await page.goto('https://u:p@app.example.com/');", /tài khoản/],
    ["await page.goto('login');", /tương đối/],
    ['await page.goto(`/x`);', /chuỗi viết thẳng/],
    ["await page.goto('/a' + 'b');", /chuỗi viết thẳng/],
    ['const u = "/x"; await page.goto(u);', /chuỗi viết thẳng/],
    ['await page.goto(`/x?e=${process.env.USER_EMAIL}`);', /chuỗi viết thẳng/],
    ['await page.goto(process.env.USER_EMAIL);', /chuỗi viết thẳng/],
    ["await page.waitForURL('https://evil.test/');", /host/],
    ['await expect(page).toHaveURL(/evil/);', /chuỗi viết thẳng/],
    ["await expect(page).not.toHaveURL('https://evil.test/');", /host/],
  ];
  for (const [s, re] of rejected) bad(wrap(s), re);
});

test('process.env: chỉ làm giá trị của fill, pressSequentially, keyboard.type và phải được khai báo', () => {
  ok(wrap("await page.getByLabel('E').fill(process.env.USER_EMAIL);"));
  const rejected = [
    ["await page.getByLabel('E').fill(process.env.UNKNOWN);", /chưa khai báo/],
    ['const v = process.env.USER_EMAIL;', /process.env/],
    ['await page.getByLabel(process.env.USER_EMAIL).click();', /process.env/],
    ["await step2(process.env.USER_EMAIL);", /không được gọi/],
    ["await page.getByLabel('E').fill(`${process.env.USER_EMAIL}`);", /template/],
    ["await page.getByLabel('E').fill(process.env.USER_EMAIL + 'x');", /toán tử/],
    ["await page.getByLabel('E').fill('a', process.env.USER_EMAIL);", /process.env/],
    ['await expect(page.getByText(process.env.USER_PASS)).toBeVisible();', /process.env/],
    ["await page.keyboard.press(process.env.USER_PASS);", /process.env/],
    ["await page.getByLabel('E').fill(process.env['USER_EMAIL']);", /process.env|\[\]/],
    ["await page.getByLabel('E').fill(process['env'].USER_EMAIL);", /\[\]/],
    ['await page.getByLabel(process.env).fill(1);', /process.env/],
    ["await page.getByLabel('E').fill(process.argv);", /process/],
    ["if (process.env.USER_EMAIL) { await page.reload(); }", /process.env/],
  ];
  for (const [s, re] of rejected) bad(wrap(s), re);
  bad(`${HEAD}test(process.env.USER_EMAIL, async ({ page }) => {});`, /chuỗi/);
});

test('tên thành viên: danh sách cho phép theo kiểu, cấm rõ các tên nguy hiểm', () => {
  const denied = [
    'await page.evaluate(() => 1);',
    "await page.evaluateHandle('1');",
    "await page.$eval('a', 1);",
    "await page.$$eval('a', 1);",
    "await page.route('**', 1);",
    "await page.unroute('**');",
    "await page.routeWebSocket('**', 1);",
    "await page.addInitScript('1');",
    "await page.exposeFunction('f', 1);",
    "await page.exposeBinding('f', 1);",
    'await page.context().newPage();',
    "await page.request.get('/');",
    'await page.pause();',
    "await page.getByLabel('f').setInputFiles('/etc/passwd');",
    "await page.getByRef('e1').click();",
    'await page.waitForTimeout(1000);',
    "await page.screenshot({ path: '/tmp/x.png' });",
    'await page.video().saveAs(1);',
    "await page.on('dialog', 1);",
    "await page.once('dialog', 1);",
    'await page.constructor;',
    'await page.__proto__;',
    "await page.getByText('x').evaluate(1);",
    "await page.getByText('x').evaluateAll(1);",
    "await page.getByText('x').textContent();",
    "await page.getByText('x').innerHTML();",
    "await page.getByText('x').dispatchEvent('click');",
    "await page.keyboard.down('A');",
    'await page.mouse.move(1, 2);',
    "await expect(page).toBe('x');",
    "await expect(page).resolves.toBe('x');",
    'await expect.poll(1);',
    "await page.content();",
    "await page.setContent('<p>');",
    "await page.goto('/').then(1);",
    "await page.url().constructor.constructor('return process')();",
  ];
  for (const s of denied) bad(wrap(s));
  bad(wrap('await page.keyboard.press;'), /phải được gọi/);
  bad(wrap('await page.keyboard();'), /không phải phương thức/);
  bad(wrap("await page.goto;"), /phải được gọi/);
  bad(wrap("const t = await page.title(); await t.constructor;"), /constructor/);
});

test('biểu thức: cấm computed, tagged template, định danh lạ, hàm ngoài callback', () => {
  const cases = [
    ["await page['goto']('/');", /\[\]/],
    ["await page[`go` + 'to']('/');", /\[\]/],
    ["await page.getByText(String.raw`x`).click();", /tagged/],
    ['await page.getByText(`a${1}`).click();', /template/],
    ['await globalThis.process.exit();', /globalThis/],
    ["await require('fs');", /require/],
    ["await import('fs');", /import\(\)/],
    ['await Function("return 1")();', /Function/],
    ["await eval('1');", /eval/],
    ['await window.alert(1);', /window/],
    ['await import.meta.url;', /import.meta/],
    ["await page.getByText('x').click({ trial: () => 1 });", /callback/],
    ["await page.getByText('x').filter({ ['has']: 1 });", /tên: giá_trị/],
    ["await page.getByText('x').click({ ...{} });", /tên: giá_trị/],
    ["await page.getByText('x').click({ constructor: 1 });", /constructor/],
    ['await page?.reload();', /\?\./],
    ['await page.reload?.();', /\?\./],
    ["await page.getByText('x' as any).click();", /AsExpression/],
    ['await page!.reload();', /NonNull/],
    ["await page.getByText(true ? 'a' : 'b').click();", /\? :/],
    ["await page.getByText(null).click();", /NullKeyword/],
    ["await page.getByText(undefined).click();", /undefined/],
    ['await page.getByText(typeof page).click();', /TypeOf/],
    ['await page.getByText(void 0).click();', /Void/],
    ["await page.getByText(~1).click();", /một ngôi/],
    ["await page.getByText(1 + 1).click();", /toán tử/],
    ["await page.getByText('a' ?? 'b').click();", /toán tử/],
    ["await page.getByText('a' in page).click();", /toán tử/],
    [`await page.getByText(/${'a'.repeat(201)}/).click();`, /regex/],
    ['await page.getByText(class {}).click();', /ClassExpression/],
    ['await page.getByText(function () {}).click();', /callback/],
    ['await page.getByText<string>("x").click();', /kiểu/],
  ];
  for (const [s, re] of cases) bad(wrap(s), re);
});

test('bộ đối kháng: chuỗi constructor, escape unicode trong định danh, mẹo template', () => {
  const corpus = [
    "await page.getByText('x').constructor.constructor('return process')();",
    "await page.getByText('x').con\\u0073tructor;",
    "await page.\\u0065valuate(() => 1);",
    "await page.\\u{65}valuate(() => 1);",
    "await pa\\u0067e.evaluate(() => 1);",
    "await page.getByText('x')['constructor']['constructor']('return 1')();",
    "await page.getByText`x`.click();",
    "await page.getByText(`${''.constructor}`).click();",
    "await (0, page.evaluate)(() => 1);",
    "await page.getByText('x').__proto__.constructor;",
    "await page.getByText('x').prototype;",
    "const e = expect; await e.constructor;",
    "const p = page; await p.evaluate(() => 1);",
    "const f = page.getByText('x'); await f.evaluate(() => 1);",
    "const g = page.evaluate; await g();",
    "await expect(page).not.not.constructor;",
    "await page.goto('\\u006a\\u0061vascript:alert(1)');",
    "await page.goto('DATA:text/html,x');",
    "await page.goto(' https://app.example.com/');",
    "await page.goto('https://app.example.com@evil.test/');",
    "await page.goto('https://evil.test#app.example.com');",
    "await page.goto('https://evil.test/?app.example.com');",
    "await page.goto('https://app.example.com.evil.test/');",
    "await page.goto('https://app%2eexample%2ecom.evil.test/');",
    "await page.getByText(/(a+)+$/.constructor('x')).click();",
  ];
  for (const s of corpus) bad(wrap(s));
  // escape unicode của tên được phép vẫn là tên được phép (TS giải escape trước khi so)
  ok(wrap("await page.\\u0072eload();"));
});

test('giới hạn kích thước, số bước và lỗi cú pháp', () => {
  const big = HEAD + '// ' + 'x'.repeat(200 * 1024) + '\n';
  bad(big, /KB/);
  const steps = Array.from({ length: 201 }, (_, i) => `  await step('b${i}', async () => {\n    await page.reload();\n  });`).join('\n');
  bad(`${HEAD}test('t', async ({ page }) => {\n${steps}\n});\n`, /200 bước/);
  const r = bad(`${HEAD}test('t', async ({ page }) => {\n  await step('s', async () => {\n    await page.goto('/'\n  });\n});\n`, /cú pháp/);
  assert.equal(r.errors[0].line, 5);
});

test('lỗi mang đúng dòng và cột', () => {
  const r = bad(wrap("await page.evaluate(() => 1);"));
  assert.equal(r.errors[0].line, 4);
  assert.equal(r.errors[0].col, 16);
});
