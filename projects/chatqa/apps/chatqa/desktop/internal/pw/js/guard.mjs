// Chặn mạng ra ngoài danh sách host được phép của hồ sơ trình duyệt. Hàm thuần (so khớp host, URL) dùng
// chung cho sidecar và bộ kiểm tra spec; installGuard gắn các lớp chặn vào một BrowserContext.
//
// Các lớp, từ trong ra ngoài:
//   - context.route: huỷ mọi request (kể cả từng bước redirect, iframe, popup) tới host lạ;
//   - context.routeWebSocket: đóng WebSocket tới host lạ trước khi nó chạm máy chủ;
//   - popup tới host lạ bị đóng; trang chính điều hướng ra host lạ bị đưa về about:blank;
//   - riêng họ Chromium: --host-resolver-rules làm mọi tên miền ngoài danh sách không phân giải được
//     (chặn cả DNS prefetch / preconnect, thứ không đi qua route).
// Firefox và WebKit không có lớp DNS: với chúng đây là biện pháp vệ sinh, không phải ranh giới bảo mật.

// normalizeHost: chữ thường, bỏ dấu chấm cuối và ngoặc vuông IPv6.
export function normalizeHost(host) {
  let h = String(host ?? '').trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

// allowedHosts: danh sách host của hồ sơ cộng host của baseURL (luôn được phép).
export function allowedHosts(hosts, baseURL) {
  const out = new Set();
  for (const h of hosts ?? []) {
    const n = normalizeHost(h);
    if (n) out.add(n);
  }
  if (baseURL) {
    try {
      const u = new URL(baseURL);
      if (u.hostname) out.add(normalizeHost(u.hostname));
    } catch {
      // baseURL đã được Go kiểm tra; hỏng thì không thêm gì
    }
  }
  return [...out];
}

// hostAllowed: host khớp đúng một mục, hoặc là tên miền con của mục "*.domain" (không gồm chính domain).
export function hostAllowed(host, hosts) {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const entry of hosts ?? []) {
    const e = normalizeHost(entry);
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // ".domain"
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    } else if (e && h === e) {
      return true;
    }
  }
  return false;
}

// requestAllowed: request mạng (http, https, ws, wss) tới host được phép. data:/blob:/about: không ra mạng.
export function requestAllowed(url, hosts) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  switch (u.protocol) {
    case 'http:':
    case 'https:':
    case 'ws:':
    case 'wss:':
      return hostAllowed(u.hostname, hosts);
    case 'data:':
    case 'blob:':
    case 'about:':
      return true;
  }
  return false;
}

// navigationAllowed: URL trang chính có được giữ không. about: và trang lỗi nội bộ của trình duyệt (sau một
// request bị huỷ) được giữ; http(s) phải đúng host; mọi scheme khác (data:, file:, javascript:...) bị chặn.
export function navigationAllowed(url, hosts) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  switch (u.protocol) {
    case 'about:':
    case 'chrome-error:':
      return true;
    case 'http:':
    case 'https:':
      return hostAllowed(u.hostname, hosts);
  }
  return false;
}

// resolverRules: giá trị cho --host-resolver-rules của Chromium: mọi tên không phân giải được trừ các host
// được phép. Địa chỉ IP viết thẳng không qua phân giải, nên chỉ route chặn được chúng.
export function resolverRules(hosts) {
  const rules = ['MAP * ~NOTFOUND'];
  for (const h of hosts ?? []) {
    const n = normalizeHost(h);
    if (n && /^[a-z0-9*.:-]+$/.test(n)) rules.push('EXCLUDE ' + n);
  }
  return rules.join(', ');
}

// isChromiumFamily: chromium tải về và các kênh msedge/chrome đều nhận cờ dòng lệnh của Chromium.
export function isChromiumFamily(browser) {
  return browser === 'chromium';
}

// installGuard gắn các lớp chặn vào context. onBlock({kind, url}) nhận mỗi lần chặn: kind là
// navigation | popup | websocket | request. mainPage() trả trang chính của phiên (popup là trang khác).
export async function installGuard(context, hosts, { mainPage, onBlock }) {
  const report = (kind, url) => {
    try {
      onBlock?.({ kind, url });
    } catch {
      // báo cáo hỏng không được làm hỏng việc chặn
    }
  };

  // blocked báo và xử lý một request bị chặn đúng một lần (route huỷ nó, rồi requestfailed cũng tới).
  const seen = new WeakSet();
  const blocked = (req) => {
    if (seen.has(req)) return;
    seen.add(req);
    const url = req.url();
    let page = null;
    let top = false;
    let nav = false;
    try {
      nav = req.isNavigationRequest();
      const frame = req.frame();
      page = frame.page();
      top = nav && frame === page.mainFrame();
    } catch {
      // request đầu của popup chưa có trang (frame() ném lỗi); service worker không có frame
      top = nav;
    }
    if (top && page !== mainPage()) {
      report('popup', url);
      page?.close().catch(() => {}); // popup chưa có trang: đóng ở sự kiện 'page'
    } else {
      report(top ? 'navigation' : 'request', url);
    }
  };

  await context.route('**/*', async (route) => {
    const req = route.request();
    if (requestAllowed(req.url(), hosts)) {
      await route.continue().catch(() => {});
      return;
    }
    blocked(req); // báo trước khi huỷ: lệnh đang chờ request này kết thúc ngay khi huỷ xong
    await route.abort('blockedbyclient').catch(() => {});
  });
  // Bước redirect và request đầu của popup không phải lúc nào cũng qua route (Chromium chặn chúng ở lớp
  // DNS, WebKit/Firefox tuỳ bản): request tới host lạ thất bại vẫn được báo và popup vẫn bị đóng.
  context.on('requestfailed', (req) => {
    if (!requestAllowed(req.url(), hosts)) blocked(req);
  });

  await context.routeWebSocket(
    (u) => !requestAllowed(u.href, hosts),
    (ws) => {
      report('websocket', ws.url());
      Promise.resolve(ws.close({ code: 1008, reason: 'blocked' })).catch(() => {});
    },
  );

  const watch = (page) => {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (navigationAllowed(url, hosts)) return;
      if (page === mainPage()) {
        report('navigation', url);
        page.goto('about:blank').catch(() => {});
      } else {
        report('popup', url);
        page.close().catch(() => {});
      }
    });
  };
  context.on('page', (page) => {
    watch(page);
    if (page === mainPage()) return;
    const url = page.url();
    if (!navigationAllowed(url, hosts)) {
      report('popup', url);
      page.close().catch(() => {});
    } else if (url.startsWith('chrome-error:')) {
      page.close().catch(() => {}); // popup mà request đầu đã bị chặn (đã báo ở trên)
    }
  });
  for (const page of context.pages()) watch(page);
}
