import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deskAliases, repoRoot } from '../../../packages/ui-shell/aliases.ts';
import { obfuscationPlugin, hardenedBuild } from '../../../packages/ui-shell/harden.ts';
import { skillZipPlugin } from './skill-zip.ts';

// PWA ChatQASoftware có hostname riêng (CQS_PWA_HOST) trên cùng Worker với HS Desk, nên đường dẫn gốc là "/". Worker chỉ có
// một thư mục assets (worker/wrangler.jsonc: ../apps/hs-desk/web/dist-pwa): bản PWA build vào dist-pwa/_cqs/, Worker đọc
// "/x" của host riêng từ "/_cqs/x" (worker/src/lib/hosts.ts). Build HS Desk xoá sạch dist-pwa: luôn build HS Desk trước,
// ChatQASoftware sau (worker/package.json "deploy").
const PWA_BASE = '/';
const PWA_OUT = resolve(repoRoot, 'apps/hs-desk/web/dist-pwa/_cqs');

// 2 chế độ build từ cùng 1 codebase:
//  - desktop: nhúng vào ChatQASoftware.exe (Wails) -> ../desktop/frontend/dist
//  - pwa:     app web/điện thoại, Worker phục vụ ở hostname riêng -> apps/hs-desk/web/dist-pwa/_cqs
export default defineConfig(({ mode }) => {
  const desktop = mode === 'desktop';
  return {
    base: PWA_BASE,
    plugins: [
      react(),
      tailwindcss(),
      // Giữ .gitkeep trong desktop/frontend/dist: go:embed cần thư mục có file kể cả khi repo vừa clone.
      // Bỏ video giới thiệu (public/intro/) và skill cho AI agent (public/skills/) của trang chủ khỏi bản desktop: app không
      // dùng, đỡ nặng exe và gói OTA.
      desktop && {
        name: 'keep-gitkeep',
        closeBundle() {
          const dist = resolve(import.meta.dirname, '../desktop/frontend/dist');
          writeFileSync(resolve(dist, '.gitkeep'), '');
          rmSync(resolve(dist, 'intro'), { recursive: true, force: true });
          rmSync(resolve(dist, 'skills'), { recursive: true, force: true });
        },
      },
      // Rối hoá mã bản phát hành (bỏ qua ở bản debug). Xem packages/ui-shell/harden.ts.
      obfuscationPlugin(),
      // Skill ChatQA cho AI agent: trang chủ cho tải skills/chatqa.zip (xem skill-zip.ts).
      !desktop && skillZipPlugin(),
      !desktop &&
        VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['app-icon-32.png'],
          manifest: {
            id: PWA_BASE,
            lang: 'vi',
            name: 'ChatQASoftware',
            short_name: 'ChatQASoftware',
            description: 'Gõ một câu, máy test chạy, kết quả hiện thành thẻ.',
            theme_color: '#EE0033',
            background_color: '#F5F6F8',
            display: 'standalone',
            scope: PWA_BASE,
            start_url: PWA_BASE,
            icons: [
              { src: 'app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
              { src: 'app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            ],
          },
          workbox: {
            navigateFallback: `${PWA_BASE}index.html`,
            navigateFallbackDenylist: [/^\/api\//, /^\/skills\//], // skills/: mở SKILL.md, tải zip là tệp thật, không trả index.html
            // Không cache API: màn quản trị và đăng nhập luôn cần mạng; số đo, thiết bị chưa có (sẽ thêm khi có dữ liệu chỉ xem).
          },
        }),
    ],
    resolve: { alias: deskAliases(import.meta.dirname) },
    define: { __PLATFORM__: JSON.stringify(desktop ? 'desktop' : 'pwa'), __PACKED_AT__: JSON.stringify(new Date().toISOString()) },
    build: {
      outDir: desktop ? '../desktop/frontend/dist' : PWA_OUT,
      emptyOutDir: true,
      ...hardenedBuild(),
    },
    server: {
      port: 5174, // HS Desk dùng 5173: chạy dev cả hai sản phẩm cùng lúc không đụng cổng
      proxy: { '/api': 'http://127.0.0.1:8787' }, // wrangler dev
      allowedHosts: ['wails.localhost'], // wails dev chuyển tiếp qua host này
      fs: { allow: [repoRoot] }, // cho phép import packages/ui-shell và contracts/*.json khi dev
    },
  };
});
