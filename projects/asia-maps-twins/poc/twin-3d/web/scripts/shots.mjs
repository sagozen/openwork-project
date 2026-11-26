// Chụp ảnh màn điều hành ở các góc nhìn chuẩn. Ghi ra ../bench/*.png. Chạy: node scripts/shots.mjs
import { chromium } from 'playwright-core'

const APP_URL = process.env.APP_URL ?? 'http://localhost:5175/'
const OUT = new URL('../../bench/', import.meta.url).pathname
const VIEWS = [
  { file: 'toan-quoc.png', center: [106.3, 16.2], zoom: 5.25, pitch: 45, bearing: -15 },
  { file: 'ha-noi.png', center: [105.85, 21.02], zoom: 9.6, pitch: 58, bearing: -20 },
]

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto(APP_URL)
await page.waitForFunction(() => window.__perf?.().mapIdleMs != null, null, { timeout: 60000 })
for (const v of VIEWS) {
  await page.evaluate((v) => window.__jumpTo(v), v)
  await page.waitForTimeout(3500)
  await page.screenshot({ path: OUT + v.file })
  console.log('đã chụp', v.file)
}
await browser.close()
