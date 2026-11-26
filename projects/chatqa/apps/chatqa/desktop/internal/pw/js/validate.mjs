// Kiểm tra an toàn cho flow web .spec.ts bằng cây cú pháp TypeScript (chỉ parse, không type-check).
// Đây là danh sách cho phép: mọi nút không khớp đúng một dạng dưới đây đều bị từ chối kèm dòng/cột.
//
//   import { test, expect, step } from './chatqa'          (tập con bất kỳ, không đổi tên)
//   test('<tên>', async ({ page }) => { await step('<bước>', async () => { ... }); ... })
//   test.describe('<tên>', () => { test(...) | test.beforeEach(...) | test.describe(...) })
//   test.beforeEach(async ({ page }) => { <câu lệnh như thân bước> })
//   thân bước: await <biểu thức>; | const x = <biểu thức>; | if (<biểu thức>) { ... } else { ... }
//   biểu thức: chuỗi gọi bắt đầu từ page, expect hoặc một const đã khai báo, theo bảng thành viên;
//              chuỗi/số/boolean, regex ngắn, object khoá là tên, mảng, !, -, so sánh và && ||
//   URL (goto, waitForURL, toHaveURL): một chuỗi thường, đường dẫn tương đối "/..." hoặc http(s) tới host
//              được phép
//   process.env.NAME: chỉ làm giá trị của fill, pressSequentially, keyboard.type, và NAME phải có trong
//              danh sách biến của lượt chạy
//
// typescript được truyền vào (sidecar nạp từ bộ chạy, test nạp từ repo), nên file này không import gì
// ngoài guard.mjs.

import { hostAllowed } from './guard.mjs';

const MAX_BYTES = 200 * 1024;
const MAX_STEPS = 200;
const MAX_REGEX = 200;
const MAX_ERRORS = 50;

const IMPORT_NAMES = new Set(['test', 'expect', 'step']);
const RESERVED = new Set(['page', 'expect', 'test', 'step', 'process', 'require', 'globalThis', 'eval', 'Function']);

// Tên bị cấm nêu rõ trong thông báo (những tên khác ngoài bảng cũng bị từ chối, chỉ là thông báo chung).
const DENIED = new Set([
  'constructor', '__proto__', 'prototype', '$eval', '$$eval', 'addInitScript', 'exposeFunction', 'exposeBinding',
  'context', 'request', 'pause', 'setInputFiles', 'getByRef', 'waitForTimeout', 'use', 'screenshot', 'saveAs',
  'video', 'tracing', 'on', 'once', 'only',
]);
const deniedName = (n) => DENIED.has(n) || /^evaluate/.test(n) || /^(un)?route/.test(n);

const V = { call: true, ret: 'value' };
const call = (ret) => ({ call: true, ret });
const prop = (ret) => ({ call: false, ret });
const GET_BY = ['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByAltText', 'getByTitle'];
const builders = (ret) => Object.fromEntries(GET_BY.map((g) => [g, call(ret)]));

// Bảng thành viên theo kiểu của đối tượng. value: kết quả cuối (không có thành viên nào).
const MEMBERS = {
  page: {
    goto: V, goBack: V, goForward: V, reload: V, waitForURL: V, waitForLoadState: V, url: V, title: V,
    keyboard: prop('keyboard'), mouse: prop('mouse'),
    ...builders('locator'), locator: call('locator'), frameLocator: call('frame'),
  },
  keyboard: { press: V, type: V },
  mouse: { click: V, wheel: V },
  locator: {
    click: V, dblclick: V, fill: V, press: V, pressSequentially: V, check: V, uncheck: V, selectOption: V,
    hover: V, focus: V, clear: V, isVisible: V, isChecked: V, count: V, waitFor: V,
    first: call('locator'), last: call('locator'), nth: call('locator'), filter: call('locator'),
    ...builders('locator'), locator: call('locator'),
    // locator.normalize() trả locator trong iframe dạng locator('iframe').contentFrame()...
    contentFrame: call('frame'),
  },
  frame: { ...builders('locator'), locator: call('locator'), first: call('frame'), last: call('frame'), nth: call('frame') },
  expectFn: { soft: call('assertion') },
  assertion: {
    not: prop('assertion'),
    toBeVisible: V, toBeHidden: V, toHaveText: V, toContainText: V, toHaveValue: V, toHaveURL: V, toHaveTitle: V,
    toBeChecked: V, toBeEnabled: V, toBeDisabled: V, toHaveCount: V, toMatchAriaSnapshot: V,
  },
};

const URL_ARG = { page: new Set(['goto', 'waitForURL']), assertion: new Set(['toHaveURL']) };
const SINK_ARG = { locator: new Set(['fill', 'pressSequentially']), keyboard: new Set(['type']) };

// validateSpec(ts, source, {envNames, allowedHosts}) trả
//   {errors: [{line, col, message}], envUsed: [NAME...], steps: [{title, startByte, endByte, line}]}
// line/col tính từ 1; byte tính theo UTF-8 (Go cắt chuỗi theo byte).
export function validateSpec(ts, source, { envNames = [], allowedHosts = [] } = {}) {
  const src = String(source ?? '');
  const errors = [];
  const envUsed = new Set();
  const steps = [];
  const envSet = new Set(envNames);

  if (Buffer.byteLength(src, 'utf8') > MAX_BYTES) {
    return { errors: [{ line: 1, col: 1, message: `file lớn quá ${MAX_BYTES / 1024} KB` }], envUsed: [], steps: [] };
  }
  const sf = ts.createSourceFile('flow.spec.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const pos = (p) => {
    const lc = sf.getLineAndCharacterOfPosition(p);
    return { line: lc.line + 1, col: lc.character + 1 };
  };
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length) {
    return {
      errors: diags.slice(0, MAX_ERRORS).map((d) => ({
        ...pos(d.start ?? 0),
        message: 'lỗi cú pháp: ' + ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      })),
      envUsed: [],
      steps: [],
    };
  }

  const K = ts.SyntaxKind;
  const fail = (node, message) => {
    if (errors.length < MAX_ERRORS) errors.push({ ...pos(node.getStart(sf)), message });
    return 'bad';
  };
  const kindName = (node) => K[node.kind];
  const name = (id) => ts.idText(id); // tên đã giải escape (constructor -> constructor)
  const byteAt = (p) => Buffer.byteLength(src.slice(0, p), 'utf8');

  const isString = (n) => n && (n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral);
  const isIdent = (n, v) => n && n.kind === K.Identifier && name(n) === v;
  const isMember = (n, obj, prop) =>
    n && n.kind === K.PropertyAccessExpression && !n.questionDotToken && isIdent(n.expression, obj) && name(n.name) === prop;
  const isProcessEnv = (n) =>
    n &&
    n.kind === K.PropertyAccessExpression &&
    !n.questionDotToken &&
    n.name.kind === K.Identifier &&
    isMember(n.expression, 'process', 'env');
  const hasModifier = (n, kind) => (ts.getModifiers?.(n) ?? n.modifiers ?? []).some((m) => m.kind === kind);

  // ---- URL và biến môi trường ----

  function checkURL(node) {
    if (node.kind !== K.StringLiteral) {
      return fail(node, 'URL phải là một chuỗi viết thẳng (không template, không ghép, không biến)');
    }
    const text = node.text;
    if (/[\s\u0000-\u001f\u007f]/.test(text)) return fail(node, 'URL không được chứa khoảng trắng hay ký tự điều khiển');
    if (text.startsWith('/')) {
      let u;
      try {
        u = new URL(text, 'http://cqs-base.invalid');
      } catch {
        return fail(node, `URL "${text}" không hợp lệ`);
      }
      if (u.host !== 'cqs-base.invalid') return fail(node, `đường dẫn "${text}" trỏ ra host khác`);
      return 'value';
    }
    let u;
    try {
      u = new URL(text);
    } catch {
      return fail(node, `URL "${text}" phải là đường dẫn tương đối "/..." hoặc http(s)://`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return fail(node, `scheme "${u.protocol}" không được phép, chỉ http(s)`);
    }
    if (u.username || u.password) return fail(node, 'URL không được chứa tài khoản/mật khẩu');
    if (!hostAllowed(u.hostname, allowedHosts)) {
      return fail(node, `host "${u.hostname}" không nằm trong danh sách host được phép của hồ sơ`);
    }
    return 'value';
  }

  function checkEnv(node) {
    const n = name(node.name);
    if (!envSet.has(n)) return fail(node, `biến ${n} chưa khai báo trong biến môi trường/bí mật của lượt chạy`);
    envUsed.add(n);
    return 'value';
  }

  // ---- biểu thức: trả kiểu (page, locator, frame, keyboard, mouse, expectFn, assertion, value) ----

  function expr(node, scope) {
    switch (node.kind) {
      case K.ParenthesizedExpression:
        return expr(node.expression, scope);
      case K.AwaitExpression:
        expr(node.expression, scope);
        return 'value';
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
      case K.NumericLiteral:
      case K.TrueKeyword:
      case K.FalseKeyword:
        return 'value';
      case K.RegularExpressionLiteral:
        if (node.text.length > MAX_REGEX) return fail(node, `regex dài quá ${MAX_REGEX} ký tự`);
        return 'value';
      case K.TemplateExpression:
        return fail(node, 'template có ${...} không được phép');
      case K.TaggedTemplateExpression:
        return fail(node, 'tagged template không được phép');
      case K.PrefixUnaryExpression:
        if (node.operator !== K.ExclamationToken && node.operator !== K.MinusToken) {
          return fail(node, 'toán tử một ngôi không được phép');
        }
        expr(node.operand, scope);
        return 'value';
      case K.BinaryExpression: {
        const ok = [
          K.AmpersandAmpersandToken, K.BarBarToken, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken,
          K.LessThanToken, K.GreaterThanToken, K.LessThanEqualsToken, K.GreaterThanEqualsToken,
        ];
        if (!ok.includes(node.operatorToken.kind)) {
          return fail(node.operatorToken, `toán tử "${node.operatorToken.getText(sf)}" không được phép`);
        }
        expr(node.left, scope);
        expr(node.right, scope);
        return 'value';
      }
      case K.ObjectLiteralExpression:
        for (const p of node.properties) {
          if (p.kind !== K.PropertyAssignment || p.name.kind !== K.Identifier) {
            fail(p, 'object chỉ được có dạng { tên: giá_trị }');
            continue;
          }
          if (deniedName(name(p.name))) fail(p.name, `khoá "${name(p.name)}" không được phép`);
          value(p.initializer, scope);
        }
        return 'value';
      case K.ArrayLiteralExpression:
        for (const e of node.elements) value(e, scope);
        return 'value';
      case K.Identifier: {
        const n = name(node);
        if (n === 'page') return 'page';
        if (n === 'expect') return 'expectFn';
        if (scope.has(n)) return scope.get(n);
        if (n === 'process') return fail(node, 'process.env chỉ dùng làm giá trị của fill, pressSequentially, keyboard.type');
        return fail(node, `định danh "${n}" không được phép`);
      }
      case K.PropertyAccessExpression: {
        if (isProcessEnv(node) || isMember(node, 'process', 'env')) {
          return fail(node, 'process.env chỉ dùng làm giá trị của fill, pressSequentially, keyboard.type');
        }
        const m = member(node, scope);
        if (m === 'bad') return 'bad';
        if (m.call) return fail(node.name, `${name(node.name)} phải được gọi ngay`);
        return m.ret;
      }
      case K.CallExpression:
        return callExpr(node, scope);
      case K.ElementAccessExpression:
        return fail(node, 'truy cập bằng [] không được phép');
      case K.ArrowFunction:
      case K.FunctionExpression:
        return fail(node, 'hàm chỉ được dùng làm callback của test/step');
      case K.NewExpression:
        return fail(node, 'new không được phép');
      case K.ThisKeyword:
        return fail(node, 'this không được phép');
      case K.SpreadElement:
        return fail(node, 'spread (...) không được phép');
      case K.DeleteExpression:
        return fail(node, 'delete không được phép');
      case K.MetaProperty:
        return fail(node, 'import.meta không được phép');
      case K.ConditionalExpression:
        return fail(node, 'biểu thức ? : không được phép');
    }
    return fail(node, `cú pháp ${kindName(node)} không được phép`);
  }

  // value: biểu thức làm tham số/giá trị; process.env ở đây vẫn bị từ chối (chỉ nơi nhận bí mật mới được).
  function value(node, scope) {
    return expr(node, scope);
  }

  // member: kiểm tra a.b, trả mô tả thành viên trong bảng.
  function member(node, scope) {
    if (node.questionDotToken) return fail(node, '?. không được phép');
    if (node.name.kind !== K.Identifier) return fail(node.name, 'tên thành viên không hợp lệ');
    const n = name(node.name);
    const t = expr(node.expression, scope);
    if (t === 'bad') return 'bad';
    if (deniedName(n)) return fail(node.name, `"${n}" không được phép`);
    const table = MEMBERS[t];
    const m = table && Object.hasOwn(table, n) ? table[n] : null;
    if (!m) return fail(node.name, `"${n}" không có trong danh sách cho phép (trên ${t})`);
    return { ...m, on: t, name: n };
  }

  function callExpr(node, scope) {
    if (node.questionDotToken) return fail(node, '?.() không được phép');
    if (node.typeArguments?.length) return fail(node, 'tham số kiểu không được phép');
    const callee = node.expression;
    if (callee.kind === K.ImportKeyword) return fail(node, 'import() không được phép');
    if (isIdent(callee, 'expect')) {
      if (node.arguments.length < 1 || node.arguments.length > 2) return fail(node, 'expect nhận 1 hoặc 2 tham số');
      for (const a of node.arguments) value(a, scope);
      return 'assertion';
    }
    if (callee.kind === K.Identifier) {
      const n = name(callee);
      if (n === 'require') return fail(node, 'require không được phép');
      if (n === 'step' || n === 'test') return fail(node, `${n}(...) chỉ đứng ở đúng chỗ của nó trong cấu trúc test`);
      return fail(callee, `không được gọi "${n}"`);
    }
    if (callee.kind === K.ElementAccessExpression) return fail(callee, 'truy cập bằng [] không được phép');
    if (callee.kind !== K.PropertyAccessExpression) {
      // gọi kết quả của một biểu thức khác (f()(), (a, b)()...): báo lỗi cụ thể của biểu thức nếu có
      if (expr(callee, scope) !== 'bad') fail(callee, 'chỉ được gọi phương thức trong danh sách cho phép');
      return 'bad';
    }
    const m = member(callee, scope);
    if (m === 'bad') return 'bad';
    if (!m.call) return fail(callee.name, `${m.name} không phải phương thức`);
    node.arguments.forEach((a, i) => {
      if (i === 0 && URL_ARG[m.on]?.has(m.name)) {
        checkURL(a);
      } else if (i === 0 && SINK_ARG[m.on]?.has(m.name) && isProcessEnv(a)) {
        checkEnv(a);
      } else {
        value(a, scope);
      }
    });
    return m.ret;
  }

  // ---- câu lệnh ----

  function body(block, parentScope) {
    const scope = new Map(parentScope);
    for (const st of block.statements) statement(st, scope);
  }

  function statement(st, scope) {
    switch (st.kind) {
      case K.ExpressionStatement:
        if (st.expression.kind !== K.AwaitExpression) return fail(st, 'câu lệnh phải có dạng await <biểu thức>;');
        expr(st.expression, scope);
        return;
      case K.VariableStatement: {
        const list = st.declarationList;
        if (!(list.flags & ts.NodeFlags.Const)) return fail(st, 'chỉ được khai báo bằng const (không let/var)');
        if (list.declarations.length !== 1) return fail(st, 'mỗi câu const khai báo đúng một tên');
        const d = list.declarations[0];
        if (d.name.kind !== K.Identifier) return fail(d.name, 'const phải đặt một tên (không destructuring)');
        if (d.type || d.exclamationToken) return fail(d, 'không khai báo kiểu cho const');
        if (!d.initializer) return fail(d, 'const thiếu giá trị');
        const n = name(d.name);
        if (RESERVED.has(n) || scope.has(n)) return fail(d.name, `tên "${n}" đã dùng hoặc bị cấm`);
        if (isProcessEnv(d.initializer)) {
          fail(d.initializer, 'process.env chỉ dùng làm giá trị của fill, pressSequentially, keyboard.type');
          scope.set(n, 'value');
          return;
        }
        const t = expr(d.initializer, scope);
        scope.set(n, t === 'bad' ? 'value' : t);
        return;
      }
      case K.IfStatement:
        expr(st.expression, scope);
        if (st.thenStatement.kind !== K.Block) fail(st.thenStatement, 'nhánh if phải nằm trong { }');
        else body(st.thenStatement, scope);
        if (st.elseStatement) {
          if (st.elseStatement.kind === K.IfStatement) statement(st.elseStatement, scope);
          else if (st.elseStatement.kind === K.Block) body(st.elseStatement, scope);
          else fail(st.elseStatement, 'nhánh else phải nằm trong { }');
        }
        return;
      case K.ForStatement:
      case K.ForInStatement:
      case K.ForOfStatement:
      case K.WhileStatement:
      case K.DoStatement:
        return fail(st, 'vòng lặp không được phép');
      case K.TryStatement:
        return fail(st, 'try không được phép');
      case K.ThrowStatement:
        return fail(st, 'throw không được phép');
      case K.ReturnStatement:
        return fail(st, 'return không được phép');
      case K.LabeledStatement:
        return fail(st, 'nhãn không được phép');
      case K.WithStatement:
        return fail(st, 'with không được phép');
    }
    return fail(st, `câu lệnh ${kindName(st)} không được phép`);
  }

  // callback: async? ({ page }) => { ... } hoặc () => { ... }
  function callback(node, { async, page }) {
    if (!node || node.kind !== K.ArrowFunction) return fail(node ?? sf, 'callback phải là hàm mũi tên');
    if (hasModifier(node, K.AsyncKeyword) !== async) {
      return fail(node, async ? 'callback phải là async' : 'callback không được là async');
    }
    if (node.typeParameters?.length || node.type) return fail(node, 'callback không khai báo kiểu');
    if (node.body.kind !== K.Block) return fail(node.body, 'thân callback phải nằm trong { }');
    if (page) {
      const p = node.parameters;
      const ok =
        p.length === 1 &&
        !p[0].type &&
        !p[0].initializer &&
        !p[0].dotDotDotToken &&
        p[0].name.kind === K.ObjectBindingPattern &&
        p[0].name.elements.length === 1 &&
        !p[0].name.elements[0].propertyName &&
        !p[0].name.elements[0].initializer &&
        !p[0].name.elements[0].dotDotDotToken &&
        isIdent(p[0].name.elements[0].name, 'page');
      if (!ok) return fail(node, 'callback chỉ nhận ({ page })');
    } else if (node.parameters.length) {
      return fail(node, 'callback không nhận tham số');
    }
    return node.body;
  }

  function title(node, what) {
    if (!isString(node)) return fail(node ?? sf, `tên ${what} phải là chuỗi viết thẳng`);
    return node.text;
  }

  function testBody(block) {
    for (const st of block.statements) {
      const e = st.kind === K.ExpressionStatement && st.expression.kind === K.AwaitExpression ? st.expression.expression : null;
      if (!e || e.kind !== K.CallExpression || !isIdent(e.expression, 'step')) {
        fail(st, "thân test chỉ gồm các bước await step('...', async () => { ... });");
        continue;
      }
      if (e.arguments.length !== 2) {
        fail(e, 'step nhận đúng 2 tham số');
        continue;
      }
      const t = title(e.arguments[0], 'bước');
      const b = callback(e.arguments[1], { async: true, page: false });
      if (t === 'bad' || b === 'bad') continue;
      const start = st.getStart(sf);
      if (steps.length === MAX_STEPS) fail(st, `quá ${MAX_STEPS} bước`);
      steps.push({ title: t, startByte: byteAt(start), endByte: byteAt(st.end), line: pos(start).line });
      body(b, new Map());
    }
  }

  function topLevel(statements, nested) {
    for (const st of statements) {
      if (st.kind === K.ImportDeclaration) {
        if (nested) fail(st, 'import chỉ ở đầu file');
        continue; // đã kiểm tra ở checkImports
      }
      const e = st.kind === K.ExpressionStatement ? st.expression : null;
      if (!e || e.kind !== K.CallExpression) {
        fail(st, 'chỉ được test(...), test.describe(...), test.beforeEach(...) ở cấp ngoài');
        continue;
      }
      const c = e.expression;
      if (isIdent(c, 'test')) {
        if (e.arguments.length !== 2) {
          fail(e, 'test nhận đúng 2 tham số: tên và callback');
          continue;
        }
        title(e.arguments[0], 'test');
        const b = callback(e.arguments[1], { async: true, page: true });
        if (b !== 'bad') testBody(b);
      } else if (isMember(c, 'test', 'describe')) {
        if (e.arguments.length !== 2) {
          fail(e, 'test.describe nhận đúng 2 tham số');
          continue;
        }
        title(e.arguments[0], 'nhóm');
        const b = callback(e.arguments[1], { async: false, page: false });
        if (b !== 'bad') topLevel(b.statements, true);
      } else if (isMember(c, 'test', 'beforeEach')) {
        if (e.arguments.length !== 1) {
          fail(e, 'test.beforeEach nhận đúng 1 callback');
          continue;
        }
        const b = callback(e.arguments[0], { async: true, page: true });
        if (b !== 'bad') body(b, new Map());
      } else {
        fail(st, 'chỉ được test(...), test.describe(...), test.beforeEach(...) ở cấp ngoài');
      }
    }
  }

  function checkImports() {
    const imports = sf.statements.filter((s) => s.kind === K.ImportDeclaration || s.kind === K.ImportEqualsDeclaration);
    if (imports.length === 0) {
      fail(sf.statements[0] ?? sf, "thiếu import { test, expect, step } from './chatqa'");
      return;
    }
    imports.slice(1).forEach((s) => fail(s, 'chỉ được một câu import'));
    const imp = imports[0];
    if (imp.kind !== K.ImportDeclaration) return fail(imp, "chỉ được import { ... } from './chatqa'");
    if (!isString(imp.moduleSpecifier) || imp.moduleSpecifier.text !== './chatqa') {
      return fail(imp.moduleSpecifier, "chỉ được import từ './chatqa'");
    }
    if (imp.attributes || imp.assertClause) return fail(imp, 'import không được có thuộc tính');
    const cl = imp.importClause;
    if (!cl || cl.isTypeOnly || cl.name || !cl.namedBindings || cl.namedBindings.kind !== K.NamedImports) {
      return fail(imp, "chỉ được import { test, expect, step } from './chatqa'");
    }
    const seen = new Set();
    for (const el of cl.namedBindings.elements) {
      const n = name(el.name);
      if (el.propertyName || el.isTypeOnly || !IMPORT_NAMES.has(n) || seen.has(n)) {
        fail(el, `chỉ được import test, expect, step (không đổi tên, không lặp): "${el.getText(sf)}"`);
      }
      seen.add(n);
    }
  }

  checkImports();
  topLevel(sf.statements, false);
  return { errors, envUsed: [...envUsed].sort(), steps };
}
