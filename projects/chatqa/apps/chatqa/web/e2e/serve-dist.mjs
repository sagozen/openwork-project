// Phục vụ bản RELEASE của app desktop (desktop/frontend/dist, đã rối hoá) như Wails: tệp tĩnh + rơi về index.html cho đường dẫn SPA.
// Dùng cho e2e/release-lazy.spec.mjs. Thư mục khác: E2E_DIST. Cổng: E2E_PORT (mặc định 5195).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.env.E2E_DIST ?? new URL('../../desktop/frontend/dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const port = Number(process.env.E2E_PORT ?? 5195);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = join(root, path);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    // Có đuôi tệp (vd /assets/x.js) mà không có thật: 404 thật, để test thấy lỗi tải chunk. Đường dẫn trang: về index.html.
    if (extname(path)) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': TYPES['.html'] }).end(await readFile(join(root, 'index.html')));
  }
}).listen(port, '127.0.0.1', () => console.log(`release dist ${root} -> http://127.0.0.1:${port}`));
