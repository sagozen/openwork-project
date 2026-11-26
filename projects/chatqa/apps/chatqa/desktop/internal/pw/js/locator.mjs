// Ngữ pháp locator cho web_click / web_fill...: phân tích chuỗi như
//   getByRole('button', { name: 'Đăng nhập' })
//   locator('iframe').contentFrame().getByRole('button', { name: 'Inner' }).first()
// thành danh sách lời gọi rồi dựng Locator bằng đúng các phương thức đó. Không bao giờ eval: chỉ các phương
// thức và tuỳ chọn trong bảng dưới được chấp nhận, đủ để nhận lại chuỗi do locator.normalize() trả về.

const MAX_SOURCE = 2000;
const MAX_REGEX = 200;

const TEXT_OPTS = { exact: 'boolean' };
const ROLE_OPTS = {
  name: 'text',
  exact: 'boolean',
  checked: 'boolean',
  disabled: 'boolean',
  expanded: 'boolean',
  includeHidden: 'boolean',
  level: 'number',
  pressed: 'boolean',
  selected: 'boolean',
};
const FILTER_OPTS = { hasText: 'text', hasNotText: 'text' };

// Mỗi phương thức: kiểu đối tượng nhận lời gọi (page | locator | frame) -> kiểu trả về, và chữ ký tham số.
const GET_BY = ['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByAltText', 'getByTitle'];
const METHODS = {
  getByRole: { on: ['page', 'locator', 'frame'], ret: 'locator', args: ['string', ROLE_OPTS] },
  getByText: { on: ['page', 'locator', 'frame'], ret: 'locator', args: ['text', TEXT_OPTS] },
  getByLabel: { on: ['page', 'locator', 'frame'], ret: 'locator', args: ['text', TEXT_OPTS] },
  getByPlaceholder: { on: ['page', 'locator', 'frame'], ret: 'locator', args: ['text', TEXT_OPTS] },
  getByAltText: { on: ['page', 'locator', 'frame'], ret: 'locator', args: ['text', TEXT_OPTS] },
  getByTitle: { on: ['page', 'locator', 'frame'], ret: 'locator', args: ['text', TEXT_OPTS] },
  getByTestId: { on: ['page', 'locator', 'frame'], ret: 'locator', args: ['text'] },
  locator: { on: ['page', 'locator', 'frame'], ret: 'locator', args: ['string'], required: 1 },
  frameLocator: { on: ['page', 'locator'], ret: 'frame', args: ['string'], required: 1 },
  contentFrame: { on: ['locator'], ret: 'frame', args: [] },
  first: { on: ['locator', 'frame'], ret: null, args: [] },
  last: { on: ['locator', 'frame'], ret: null, args: [] },
  nth: { on: ['locator', 'frame'], ret: null, args: ['integer'], required: 1 },
  filter: { on: ['locator'], ret: 'locator', args: [FILTER_OPTS], required: 1 },
};
for (const g of GET_BY) METHODS[g].required = 1;

function invalid(message) {
  const e = new Error(message);
  e.code = 'invalid';
  return e;
}

// ---- tách token ----

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  // regex chỉ hợp lệ ở đầu một tham số hoặc giá trị tuỳ chọn
  const regexAllowed = () => {
    const prev = toks[toks.length - 1];
    return prev && (prev.t === '(' || prev.t === ',' || prev.t === ':');
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      const m = /^-?\d+(?:\.\d+)?/.exec(src.slice(i));
      if (!m) throw invalid(`ký tự lạ ở vị trí ${i + 1}`);
      toks.push({ t: 'num', v: Number(m[0]), int: !m[0].includes('.') });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= n) throw invalid('chuỗi chưa đóng');
        const d = src[j];
        if (d === c) break;
        if (c === '`' && d === '$' && src[j + 1] === '{') throw invalid('không dùng ${...} trong locator');
        if (d === '\\') {
          const e = src[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`' };
          if (e in map) {
            out += map[e];
            j += 2;
            continue;
          }
          if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          throw invalid(`escape \\${e ?? ''} không hỗ trợ`);
        }
        out += d;
        j++;
      }
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      for (;;) {
        if (j >= n) throw invalid('regex chưa đóng');
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      const body = src.slice(i + 1, j);
      let k = j + 1;
      while (k < n && /[a-z]/.test(src[k])) k++;
      const flags = src.slice(j + 1, k);
      if (k - i > MAX_REGEX) throw invalid(`regex dài quá ${MAX_REGEX} ký tự`);
      if (!/^[imsu]*$/.test(flags)) throw invalid(`cờ regex "${flags}" không hỗ trợ`);
      let re;
      try {
        re = new RegExp(body, flags);
      } catch (e) {
        throw invalid(`regex sai: ${e.message}`);
      }
      toks.push({ t: 're', v: re });
      i = k;
      continue;
    }
    if ('.(),{}:'.includes(c)) {
      toks.push({ t: c });
      i++;
      continue;
    }
    throw invalid(`ký tự "${c}" không hợp lệ ở vị trí ${i + 1}`);
  }
  return toks;
}

// ---- phân tích ----

function parser(toks) {
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t) => {
    const tok = next();
    if (!tok || tok.t !== t) throw invalid(`thiếu "${t}"`);
    return tok;
  };
  function value() {
    const tok = next();
    if (!tok) throw invalid('thiếu giá trị');
    switch (tok.t) {
      case 'str':
        return { kind: 'string', v: tok.v };
      case 're':
        return { kind: 'regex', v: tok.v };
      case 'num':
        return { kind: tok.int ? 'integer' : 'number', v: tok.v };
      case 'id':
        if (tok.v === 'true' || tok.v === 'false') return { kind: 'boolean', v: tok.v === 'true' };
        throw invalid(`giá trị "${tok.v}" không hợp lệ`);
      case '{': {
        const obj = {};
        if (peek()?.t !== '}') {
          for (;;) {
            const key = next();
            if (!key || (key.t !== 'id' && key.t !== 'str')) throw invalid('khoá tuỳ chọn phải là tên');
            expect(':');
            if (Object.hasOwn(obj, key.v)) throw invalid(`tuỳ chọn "${key.v}" lặp lại`);
            obj[key.v] = value();
            if (peek()?.t === ',') {
              next();
              if (peek()?.t === '}') break;
              continue;
            }
            break;
          }
        }
        expect('}');
        return { kind: 'object', v: obj };
      }
    }
    throw invalid('giá trị không hợp lệ');
  }
  function call() {
    const name = next();
    if (!name || name.t !== 'id') throw invalid('thiếu tên phương thức');
    expect('(');
    const args = [];
    if (peek()?.t !== ')') {
      for (;;) {
        args.push(value());
        if (peek()?.t === ',') {
          next();
          if (peek()?.t === ')') break;
          continue;
        }
        break;
      }
    }
    expect(')');
    return { name: name.v, args };
  }
  return { peek, next, call };
}

function checkArg(method, i, spec, arg) {
  const where = `${method}: tham số ${i + 1}`;
  if (typeof spec === 'object') {
    if (arg.kind !== 'object') throw invalid(`${where} phải là { ... }`);
    const out = {};
    for (const [k, v] of Object.entries(arg.v)) {
      const want = spec[k];
      if (!want) throw invalid(`${method}: tuỳ chọn "${k}" không hỗ trợ`);
      out[k] = checkScalar(`${method}: ${k}`, want, v);
    }
    return out;
  }
  return checkScalar(where, spec, arg);
}

function checkScalar(where, want, arg) {
  switch (want) {
    case 'string':
      if (arg.kind === 'string') return arg.v;
      break;
    case 'text':
      if (arg.kind === 'string' || arg.kind === 'regex') return arg.v;
      break;
    case 'boolean':
      if (arg.kind === 'boolean') return arg.v;
      break;
    case 'number':
      if (arg.kind === 'number' || arg.kind === 'integer') return arg.v;
      break;
    case 'integer':
      if (arg.kind === 'integer') return arg.v;
      break;
  }
  throw invalid(`${where} phải là ${want}`);
}

// parseLocator trả [{name, args}] đã kiểm tra chữ ký; lỗi mang code 'invalid'.
export function parseLocator(source) {
  const src = String(source ?? '').trim();
  if (!src) throw invalid('locator trống');
  if (src.length > MAX_SOURCE) throw invalid(`locator dài quá ${MAX_SOURCE} ký tự`);
  const toks = tokenize(src);
  const ps = parser(toks);
  if (ps.peek()?.t === 'id' && ps.peek().v === 'page' && toks[1]?.t === '.') {
    ps.next();
    ps.next();
  }
  const chain = [];
  let type = 'page';
  for (;;) {
    const c = ps.call();
    const m = Object.hasOwn(METHODS, c.name) ? METHODS[c.name] : null;
    if (!m) throw invalid(`phương thức "${c.name}" không được phép trong locator`);
    if (!m.on.includes(type)) throw invalid(`không gọi được ${c.name}() trên ${type}`);
    if (c.args.length < (m.required ?? 0) || c.args.length > m.args.length) {
      throw invalid(`${c.name}: số tham số không đúng`);
    }
    const args = c.args.map((a, i) => checkArg(c.name, i, m.args[i], a));
    chain.push({ name: c.name, args });
    type = m.ret ?? type;
    const tok = ps.next();
    if (!tok) break;
    if (tok.t !== '.') throw invalid('sau ")" chỉ được là "." hoặc hết');
  }
  if (type !== 'locator') throw invalid('locator phải trỏ tới một phần tử (không dừng ở khung iframe)');
  return chain;
}

function escapeAttr(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"s`;
}

// buildLocator dựng Locator từ chuỗi đã phân tích. getByTestId dùng thuộc tính test id của hồ sơ (thuộc
// tính toàn cục của Playwright luôn là data-testid, vì một sidecar phục vụ nhiều hồ sơ).
export function buildLocator(page, chain, { testIdAttribute = 'data-testid' } = {}) {
  let cur = page;
  for (const { name, args } of chain) {
    if (name === 'getByTestId' && testIdAttribute !== 'data-testid') {
      if (typeof args[0] !== 'string') throw invalid('getByTestId với thuộc tính test id riêng chỉ nhận chuỗi');
      cur = cur.locator(`internal:testid=[${testIdAttribute}=${escapeAttr(args[0])}]`);
      continue;
    }
    cur = cur[name](...args);
  }
  return cur;
}

export function locatorFrom(page, source, opts) {
  return buildLocator(page, parseLocator(source), opts);
}
