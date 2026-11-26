import { defineConfig } from 'vitest/config';
import { deskAliases, repoRoot } from '../../../packages/ui-shell/aliases.ts';

export default defineConfig({
  resolve: { alias: deskAliases(import.meta.dirname) },
  define: { __PLATFORM__: JSON.stringify('desktop') },
  // Test của app này (test của packages/ui-shell chạy cùng HS Desk). Môi trường node: render bằng react-dom/server, không cần DOM.
  test: { dir: repoRoot, include: ['apps/chatqa/web/src/**/*.test.{ts,tsx}'], environment: 'node' },
});
