// Dựng slide video (1920x1080 PNG mỗi cảnh) và ba file PDF của khoá học từ course.mjs.
// Chạy: node docs/courses/chatqa/tools/build-media.mjs <đường dẫn hs-desk> [slides|pdf|all]
// Cần: build/screens (capture-app-screens.mjs), build/brand, build/fonts. Ra: build/slides/<bài>/<nn>.png, build/*.pdf.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COURSE, MODULES, LESSONS, RESOURCES } from '../course.mjs';

// Dòng +++ bao quanh phần tuỳ chọn (gập trên web); bản in chỉ giữ tiêu đề.
const plainNotes = (notes) => notes.replace(/^\+\+\+[ \t]*(.*)$/gm, '$1');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const [hsDesk, what = 'all'] = process.argv.slice(2);
if (!hsDesk) throw new Error('usage: build-media.mjs <hs-desk> [slides|pdf|all]');
const { chromium } = createRequire(join(resolve(hsDesk), 'apps/chatqa/web/package.json'))('@playwright/test');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fileUrl = (p) => pathToFileURL(join(build, p)).href;

const fonts = ['400', '500', '600', '700']
  .flatMap((w) =>
    ['vietnamese', 'latin-ext', 'latin'].map(
      (sub) =>
        `@font-face{font-family:'BVP';font-weight:${w};src:url(${fileUrl(`fonts/be-vietnam-pro-${sub}-${w}-normal.woff2`)}) format('woff2')}`,
    ),
  )
  .concat(
    ['400', '500', '600'].flatMap((w) =>
      ['vietnamese', 'latin-ext', 'latin'].map(
        (sub) =>
          `@font-face{font-family:'JBM';font-weight:${w};src:url(${fileUrl(`fonts/jetbrains-mono-${sub}-${w}-normal.woff2`)}) format('woff2')}`,
      ),
    ),
  )
  .join('\n');

const RED = '#E4002B';
const NAVY = '#0A1F44';
const base = `${fonts}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'BVP',system-ui,sans-serif;color:${NAVY};-webkit-font-smoothing:antialiased}
code,pre{font-family:'JBM',ui-monospace,monospace}`;

// ---------- Slide video ----------
const slideCss = `${base}
.s{width:1920px;height:1080px;position:relative;overflow:hidden;background:#F6F7F9}
.bar{position:absolute;left:0;right:0;bottom:0;height:64px;display:flex;align-items:center;gap:14px;padding:0 56px;background:#fff;border-top:1px solid #E3E6EB;font-size:22px;color:#5A6577}
.bar img{height:30px}.bar b{color:${NAVY};font-weight:600}.bar .sp{flex:1}
.kick{font-size:28px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:${RED}}
h1{font-size:64px;line-height:1.15;font-weight:700;letter-spacing:-.5px}
.title{background:linear-gradient(135deg,${RED} 0%,#B8001F 60%,${NAVY} 140%);color:#fff;display:flex;flex-direction:column;justify-content:center;padding:0 140px}
.title .kick{color:#FFD5DC}.title h1{font-size:104px;margin:22px 0 26px}.title p{font-size:40px;opacity:.92}
.title .logo{position:absolute;top:80px;left:140px;height:64px}
.steps{padding:96px 140px 0}.steps h1{margin-bottom:48px}
ol{list-style:none;counter-reset:n;display:flex;flex-direction:column;gap:26px}
ol li{counter-increment:n;display:flex;gap:28px;align-items:flex-start;font-size:40px;line-height:1.35;background:#fff;border-radius:18px;padding:24px 32px;box-shadow:0 1px 0 #E3E6EB}
ol li::before{content:counter(n);flex:none;width:58px;height:58px;border-radius:50%;background:${RED};color:#fff;font-weight:700;font-size:30px;display:flex;align-items:center;justify-content:center;margin-top:-2px}
.note{margin-top:36px;font-size:30px;color:#8A1020;background:#FFF0F2;border-left:8px solid ${RED};padding:20px 28px;border-radius:10px}
.screen{background:${NAVY};display:flex;flex-direction:column;align-items:center;padding:48px 0 0}
.screen img.shot{width:1560px;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.screen .cap{margin-top:30px;font-size:36px;font-weight:600;color:#fff;max-width:1600px;text-align:center}
.code{padding:96px 140px 0}.code h1{font-size:56px;margin-bottom:40px}
.code pre{background:#0E1A2E;color:#E6EDF7;font-size:34px;line-height:1.5;padding:40px 48px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.phone{display:flex;gap:90px;align-items:center;padding:0 140px}
.phone .l{flex:1}.phone .l h1{margin-bottom:44px}
.device{flex:none;width:420px;height:840px;border-radius:56px;background:#111;padding:18px;box-shadow:0 30px 80px rgba(10,31,68,.35)}
.device .sc{width:100%;height:100%;border-radius:40px;background:#fff;padding:70px 28px;display:flex;flex-direction:column;gap:18px}
.device .row{font-size:24px;padding:20px;border-radius:14px;background:#F1F3F6;color:#334}
.device .row.on{background:#FFE3E8;color:${RED};font-weight:600;outline:3px solid ${RED}}
.illus{position:absolute;right:140px;bottom:96px;font-size:22px;color:#8A93A3}`;

function slideHtml(lesson, scene, idx, total) {
  const v = scene.visual;
  const lessonNo = LESSONS.findIndex((l) => l.id === lesson.id) + 1;
  const bar = `<div class="bar"><img src="${fileUrl('brand/logo-mark.svg')}"><b>ChatQASoftware</b> · Bài ${lessonNo}: ${esc(lesson.title)}<span class="sp"></span>${idx + 1}/${total}</div>`;
  let body;
  if (v.type === 'title')
    body = `<div class="s title"><img class="logo" src="${fileUrl('brand/logo-lockup-dark.svg')}"><div class="kick">${esc(v.kicker)}</div><h1>${esc(v.heading)}</h1><p>${esc(v.sub)}</p></div>`;
  else if (v.type === 'screen')
    body = `<div class="s screen"><img class="shot" src="${fileUrl(v.image)}"><div class="cap">${esc(v.caption)}</div>${bar}</div>`;
  else if (v.type === 'steps')
    body = `<div class="s steps"><h1>${esc(v.title)}</h1><ol>${v.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ol>${v.note ? `<div class="note">${esc(v.note)}</div>` : ''}${bar}</div>`;
  else if (v.type === 'code')
    body = `<div class="s code"><h1>${esc(v.title)}</h1><pre>${esc(v.body)}</pre>${v.note ? `<div class="note">${esc(v.note)}</div>` : ''}${bar}</div>`;
  else if (v.type === 'phone')
    body = `<div class="s phone"><div class="l"><h1>${esc(v.title)}</h1><ol>${v.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ol></div><div class="device"><div class="sc">${v.items
      .map((i, n) => `<div class="row${n === v.highlight ? ' on' : ''}">${esc(i)}</div>`)
      .join('')}</div></div><div class="illus">Hình minh hoạ, tên mục có thể khác theo hãng</div>${bar}</div>`;
  else throw new Error(`visual lạ: ${v.type}`);
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${slideCss}</style></head><body>${body}</body></html>`;
}

async function buildSlides(browser) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const lesson of LESSONS) {
    const dir = join(build, 'slides', lesson.id);
    mkdirSync(dir, { recursive: true });
    for (const [i, scene] of lesson.scenes.entries()) {
      if (scene.visual.type === 'screen' && !existsSync(join(build, scene.visual.image)))
        throw new Error(`thiếu ảnh ${scene.visual.image} (chạy capture-app-screens.mjs)`);
      const html = join(dir, `${String(i).padStart(2, '0')}.html`);
      writeFileSync(html, slideHtml(lesson, scene, i, lesson.scenes.length));
      await page.goto(pathToFileURL(html).href);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: html.replace(/\.html$/, '.png') });
    }
    // Ảnh bìa (poster) của video = cảnh đầu.
    console.log('slides', lesson.id, lesson.scenes.length);
  }
  await page.close();
}

// ---------- PDF ----------
const pdfCss = `${base}
@page{size:A4;margin:18mm 16mm 18mm 16mm}
body{font-size:10.5pt;line-height:1.55}
h1{font-size:22pt;line-height:1.2;margin:0 0 6mm}
h2{font-size:15pt;color:${RED};margin:9mm 0 3mm;page-break-after:avoid}
h3{font-size:12pt;margin:6mm 0 2mm;page-break-after:avoid}
.notes{white-space:pre-line}
.meta{color:#5A6577;font-size:9.5pt;margin-bottom:2mm}
.chapter{page-break-before:always}
.lesson{page-break-inside:auto;margin-bottom:6mm}
figure{margin:3mm 0 4mm;page-break-inside:avoid}
figure img{width:100%;border:1px solid #DDE1E7;border-radius:6px}
figcaption{font-size:9pt;color:#5A6577;margin-top:1.5mm}
pre{background:#F2F4F7;border:1px solid #E1E5EA;border-radius:6px;padding:3mm 4mm;font-size:8.6pt;white-space:pre-wrap;word-break:break-all;page-break-inside:avoid}
.cover{height:255mm;display:flex;flex-direction:column;justify-content:center;background:linear-gradient(135deg,${RED},#B8001F 60%,${NAVY} 140%);color:#fff;margin:-18mm -16mm;padding:0 22mm}
.cover img{height:16mm;align-self:flex-start;margin-bottom:24mm}
.cover h1{font-size:34pt;margin-bottom:6mm}.cover p{font-size:13pt;opacity:.92;max-width:150mm}
.cover .small{margin-top:30mm;font-size:10pt;opacity:.85}
.toc ol{margin-left:6mm}.toc li{margin:1mm 0}
.box{border:1px solid #F3B7C1;background:#FFF5F7;border-radius:6px;padding:3mm 4mm;margin:3mm 0}
table{border-collapse:collapse;width:100%;font-size:9.5pt}td,th{border:1px solid #DDE1E7;padding:2mm 2.5mm;text-align:left;vertical-align:top}
.check li{list-style:none;margin:1.6mm 0}.check li::before{content:'☐  ';font-size:12pt}`;

function codeOf(lesson) {
  return lesson.scenes.filter((s) => s.visual.type === 'code').map((s) => s.visual);
}
function shotsOf(lesson) {
  return lesson.scenes.filter((s) => s.visual.type === 'screen').map((s) => s.visual);
}

function handbookHtml() {
  let n = 0;
  const chapters = MODULES.map((m) => {
    const lessons = m.lessons
      .map((l) => {
        n += 1;
        const seen = new Set();
        const figs = shotsOf(l)
          .filter((s) => !seen.has(s.image) && seen.add(s.image))
          .map((s) => `<figure><img src="${fileUrl(s.image)}"><figcaption>${esc(s.caption)}</figcaption></figure>`)
          .join('');
        const res = l.resources.map((k) => RESOURCES[k].label).join(' · ');
        return `<section class="lesson"><h2>Bài ${n}. ${esc(l.title)}</h2><div class="meta">Khoảng ${l.minutes} phút${res ? ` · Tài nguyên: ${esc(res)}` : ''}</div><div class="notes">${esc(plainNotes(l.notes))}</div>${figs}</section>`;
      })
      .join('');
    return `<div class="chapter"><h1>${esc(m.title)}</h1>${lessons}</div>`;
  }).join('');
  let k = 0;
  const toc = MODULES.map(
    (m) => `<li><b>${esc(m.title)}</b><ol>${m.lessons.map((l) => `<li>Bài ${++k}. ${esc(l.title)}</li>`).join('')}</ol></li>`,
  ).join('');
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(COURSE.title)}</title><style>${pdfCss}</style></head><body>
<div class="cover"><img src="${fileUrl('brand/logo-lockup-dark.svg')}"><h1>${esc(COURSE.title)}</h1><p>Cẩm nang làm theo từng bước: Windows, Android, MCP với Claude và Codex.</p><div class="small">Bản ngày 26/11/2026 · Học online: mytutorlms.zhst.app · Hỗ trợ: support@zhst.app</div></div>
<div class="chapter toc"><h1>Mục lục</h1><ol>${toc}</ol>
<div class="box">Cách dùng cẩm nang: mỗi bài có ghi chú làm theo và ảnh màn hình. Video và tài nguyên tải về nằm trong lớp học online. Ảnh trong cẩm nang chụp từ giao diện app với dữ liệu mẫu; tên máy, tên người dùng của bạn sẽ khác.</div></div>
${chapters}
</body></html>`;
}

function checklistHtml() {
  const items = [
    'Máy tính Windows 10 hoặc 11, bản 64-bit, có mạng',
    'Tài khoản Windows của bạn (không cần quyền quản trị)',
    'Điện thoại Android đã sạc, nên là máy test riêng',
    'Cáp USB truyền dữ liệu, cắm thẳng vào máy tính (không qua hub)',
    'Email mở được ngay để nhận License Key',
    'Đã gửi form "Nhận license 1 năm miễn phí" tại chatqasoft.zhst.app',
    'Đã nhận thư có License Key, tên đăng nhập, mật khẩu tạm (dùng trong 72 giờ)',
    'Đã tải ChatQASoftware cho Windows và script cai-dat-chatqa.ps1',
    'App nằm ở %LOCALAPPDATA%\\Programs\\ChatQASoftware, có lối tắt ngoài Desktop',
    'Đã kích hoạt máy và đổi mật khẩu ở lần đăng nhập đầu',
    'Lệnh "adb version" chạy được trong Terminal mới',
    'Điện thoại đã bật Tùy chọn nhà phát triển, Gỡ lỗi USB, Không khoá màn hình khi sạc',
    'Đã bấm "Cho phép" gỡ lỗi USB, điện thoại hiện "Sẵn sàng" trong app',
    'Đã bật MCP và lưu token ở nơi an toàn',
    'Tài khoản Claude (Claude Desktop, Claude Code) và/hoặc ChatGPT (Codex)',
    'Đã cài Zoom hoặc biết vào Zoom bằng trình duyệt cho buổi học trực tiếp',
  ];
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${pdfCss}</style></head><body>
<h1>Danh sách kiểm tra · ${esc(COURSE.title)}</h1><div class="meta">Đánh dấu từng mục trước và trong khi học. Không ghi License Key, mật khẩu hay token lên giấy này nếu in ra.</div>
<ul class="check">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
<div class="box">Kẹt ở mục nào: xem bài tương ứng trong lớp học, bảng xử lý sự cố, hoặc mang câu hỏi tới buổi đào tạo trực tiếp qua Zoom.</div></body></html>`;
}

function troubleshootingHtml() {
  const lesson = LESSONS.find((l) => l.id === 'chatqa-18-xu-ly-su-co');
  const groups = plainNotes(lesson.notes).split(/\n\n+/).map((block) => {
    const [head, ...rows] = block.split('\n');
    if (!rows.length) return `<div class="box">${esc(head)}</div>`;
    return `<h3>${esc(head)}</h3><table><tr><th style="width:45%">Hiện tượng</th><th>Cách xử lý</th></tr>${rows
      .map((r) => {
        const t = r.replace(/^- /, '');
        const at = t.indexOf(': ');
        return at > 0
          ? `<tr><td>${esc(t.slice(0, at))}</td><td>${esc(t.slice(at + 2))}</td></tr>`
          : `<tr><td colspan="2">${esc(t)}</td></tr>`;
      })
      .join('')}</table>`;
  });
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${pdfCss}</style></head><body>
<h1>Bảng xử lý sự cố ChatQASoftware</h1><div class="meta">Đọc đúng thông báo app hiện, tra dòng tương ứng. Bản ngày 26/11/2026.</div>${groups.join('')}</body></html>`;
}

async function pdf(browser, html, out) {
  const file = join(build, out.replace(/\.pdf$/, '.html'));
  writeFileSync(file, html);
  const page = await browser.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.pdf({
    path: join(build, out),
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate:
      '<div style="font-size:8px;width:100%;text-align:center;color:#8A93A3">ChatQASoftware · mytutorlms.zhst.app · <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
    margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
  });
  await page.close();
  console.log('pdf', out);
}

const browser = await chromium.launch();
try {
  if (what === 'all' || what === 'slides') await buildSlides(browser);
  if (what === 'all' || what === 'pdf') {
    await pdf(browser, handbookHtml(), RESOURCES.handbook.file);
    await pdf(browser, checklistHtml(), RESOURCES.checklist.file);
    await pdf(browser, troubleshootingHtml(), RESOURCES.troubleshooting.file);
  }
  // Danh sách cảnh cho bộ dựng video (Python đọc file này, không đọc .mjs).
  writeFileSync(
    join(build, 'scenes.json'),
    JSON.stringify(
      LESSONS.map((l) => ({ id: l.id, title: l.title, scenes: l.scenes.map((s) => ({ say: s.say, caption: s.caption ?? s.say })) })),
      null,
      1,
    ),
  );
} finally {
  await browser.close();
}
