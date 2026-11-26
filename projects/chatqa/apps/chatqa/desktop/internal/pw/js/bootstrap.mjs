// Cửa vào của mọi tiến trình Node do app mở: node bootstrap.mjs <script> [tham số...]
//
//  1. Chờ dòng "start" trên stdin trước khi nạp script. App gửi dòng này sau khi đã đặt tiến trình vào
//     nhóm (POSIX) hoặc Job Object (Windows), nên không tiến trình con nào kịp sinh ra ngoài nhóm/Job.
//  2. Giữ stdin mở suốt đời tiến trình. App thoát hay sập thì stdin đóng (EOF): gửi SIGTERM cho cả nhóm
//     tiến trình của mình (Playwright đóng trình duyệt khi nhận SIGTERM) rồi thoát. Trên macOS không có
//     Job Object, đây là cách để Node không sống sót sau app.
//  3. Phần stdin sau dòng "start" được chuyển cho script qua globalThis[Symbol.for('chatqa.stdin')]
//     (sidecar đọc lệnh JSON-RPC từ đó); script không cần stdin thì bỏ qua.

import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  process.stderr.write('bootstrap: thiếu script cần chạy\n');
  process.exit(2);
}

const input = new PassThrough();
globalThis[Symbol.for('chatqa.stdin')] = input;

let started = false;
let pending = Buffer.alloc(0);

function stopGroup() {
  input.end();
  if (process.platform !== 'win32') {
    try {
      process.kill(-process.pid, 'SIGTERM'); // cả nhóm, kể cả chính mình
    } catch {
      // không phải trưởng nhóm (chạy tay ngoài app): chỉ thoát chính mình
    }
  }
  setTimeout(() => process.exit(0), 1000);
}

async function start(rest) {
  started = true;
  if (rest.length) input.write(rest);
  const file = path.resolve(target);
  process.argv = [process.argv[0], file, ...process.argv.slice(3)];
  try {
    await import(pathToFileURL(file).href);
  } catch (e) {
    process.stderr.write(`bootstrap: không nạp được ${file}: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}

process.stdin.on('data', (chunk) => {
  if (started) {
    input.write(chunk);
    return;
  }
  pending = Buffer.concat([pending, chunk]);
  const nl = pending.indexOf(0x0a);
  if (nl < 0) {
    if (pending.length > 64) process.exit(2); // không phải lệnh start
    return;
  }
  const line = pending.subarray(0, nl).toString('utf8').replace(/\r$/, '');
  const rest = pending.subarray(nl + 1);
  pending = Buffer.alloc(0);
  if (line !== 'start') {
    process.stderr.write('bootstrap: dòng đầu tiên phải là "start"\n');
    process.exit(2);
  }
  start(rest);
});

function onClosed() {
  if (!started) process.exit(0);
  stopGroup();
}
process.stdin.on('end', onClosed);
process.stdin.on('error', onClosed); // ống bị đóng đột ngột cũng là app đã đi
