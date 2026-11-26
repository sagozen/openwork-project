// Reporter của ChatQA cho lượt chạy flow web: mỗi sự kiện một dòng JSON (NDJSON) ghi đồng bộ vào file
// options.output, app đọc file này trong lúc chạy. Ghi file thay vì stdout để Playwright in gì ra stdout
// cũng không lẫn vào, và dòng cuối không bị mất khi tiến trình thoát.
//
//   {"type":"begin","total":N}
//   {"type":"step","test":id,"depth":0|1,"title":..,"category":..,"durationMs":..,"error":{message,line,snippet}?}
//   {"type":"test","test":id,"title":..,"status":..,"durationMs":..,"error":?,"errors":[..],"attachments":[..]}
//   {"type":"log","stream":"stdout|stderr","text":..}   (có giới hạn)
//   {"type":"error","error":{..}}                       (lỗi ngoài test: cấu hình, biên dịch spec)
//   {"type":"end","status":"passed|failed|timedout|interrupted"}
//
// Bước: depth 0 là khối step() của flow, depth 1 là lệnh Playwright/expect nằm trực tiếp trong khối đó.
// Lệnh bên trong fixture hay hook của app (chặn mạng, ảnh live, ảnh bước) không phải bước của flow.

import fs from 'node:fs';

const MAX_TEXT = 2000;
const MAX_BODY = 256 * 1024;
const MAX_LOG_LINES = 50;
const MAX_LOG_LINE = 500;
const MAX_ERRORS = 5;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function clean(s, max = MAX_TEXT) {
  const t = String(s ?? '').replace(ANSI, '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// stepDepth: 0 cho step() cấp đầu, 1 cho lệnh API/expect nằm ngay trong một step(), -1 cho mọi thứ khác.
export function stepDepth(step) {
  for (let p = step.parent; p; p = p.parent) {
    if (p.category === 'fixture' || p.category === 'hook') return -1;
  }
  if (step.category === 'test.step') return step.parent ? -1 : 0;
  if (step.category === 'pw:api' || step.category === 'expect') {
    return step.parent?.category === 'test.step' && !step.parent.parent ? 1 : -1;
  }
  return -1;
}

export function errorInfo(e) {
  if (!e) return undefined;
  const out = { message: clean(e.message ?? e.value ?? 'lỗi không rõ') };
  if (e.location?.line) out.line = e.location.line;
  if (e.snippet) out.snippet = clean(e.snippet);
  return out;
}

const TEXT_TYPES = /^(text\/|application\/json)/;

export function attachmentInfo(a) {
  const out = { name: clean(a.name, 200), contentType: a.contentType ?? '' };
  if (a.path) out.path = a.path;
  if (a.body && TEXT_TYPES.test(out.contentType)) out.body = Buffer.from(a.body).toString('utf8').slice(0, MAX_BODY);
  return out;
}

export default class ChatQAReporter {
  constructor(options = {}) {
    this.fd = options.output ? fs.openSync(options.output, 'a', 0o600) : null;
    this.logLines = 0;
  }

  printsToStdio() {
    return true;
  }

  write(obj) {
    if (this.fd === null) return;
    try {
      fs.writeSync(this.fd, JSON.stringify(obj) + '\n');
    } catch {
      // không ghi được báo cáo thì app thấy lượt thiếu sự kiện end và báo lỗi môi trường
    }
  }

  onBegin(_config, suite) {
    this.write({ type: 'begin', total: suite.allTests().length });
  }

  onStepEnd(test, _result, step) {
    const depth = stepDepth(step);
    if (depth < 0) return;
    this.write({
      type: 'step',
      test: test.id,
      depth,
      title: clean(step.title),
      category: step.category,
      durationMs: Math.max(0, Math.round(step.duration ?? 0)),
      error: errorInfo(step.error),
    });
  }

  onTestEnd(test, result) {
    this.write({
      type: 'test',
      test: test.id,
      title: clean(test.title),
      status: result.status,
      durationMs: Math.max(0, Math.round(result.duration ?? 0)),
      error: errorInfo(result.error),
      errors: (result.errors ?? []).slice(0, MAX_ERRORS).map(errorInfo),
      attachments: (result.attachments ?? []).map(attachmentInfo),
    });
  }

  log(stream, chunk) {
    for (const line of String(chunk ?? '').split('\n')) {
      if (!line.trim()) continue;
      if (this.logLines++ >= MAX_LOG_LINES) return;
      this.write({ type: 'log', stream, text: clean(line, MAX_LOG_LINE) });
    }
  }

  onStdOut(chunk) {
    this.log('stdout', chunk);
  }

  onStdErr(chunk) {
    this.log('stderr', chunk);
  }

  onError(error) {
    this.write({ type: 'error', error: errorInfo(error) });
  }

  async onEnd(result) {
    this.write({ type: 'end', status: result.status });
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // đã đóng
      }
      this.fd = null;
    }
  }
}
