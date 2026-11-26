// Đo thời gian mở màn hình khi mạng bị giới hạn (giả lập mạng nội bộ chậm), cache trống.
import { chromium } from 'playwright-core'
for (const mbps of [50, 10, 4]) {
  const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] })
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  const cdp = await ctx.newCDPSession(p)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: mbps * 125000, uploadThroughput: mbps * 125000 })
  await p.goto(process.env.APP_URL ?? 'http://localhost:5175/')
  await p.waitForFunction(() => window.__perf?.().firstFrameMs != null, null, { timeout: 120000 })
  const perf = await p.evaluate(() => window.__perf())
  console.log(`${mbps} Mbps: khung đầu có dữ liệu ${perf.firstFrameMs} ms`)
  await b.close()
}
