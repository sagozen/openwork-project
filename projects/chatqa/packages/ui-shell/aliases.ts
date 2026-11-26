// Đường dẫn dùng chung cho mọi app web trong monorepo (vite + vitest; tsconfig khai báo cùng bộ trong "paths").
//  @shell    -> packages/ui-shell/src   (shell, đăng nhập, quản trị, nền tảng desktop/pwa)
//  @product  -> <app>/src               (danh mục phân hệ + trang nghiệp vụ của từng sản phẩm)
//  @contracts-> contracts/              (nguồn duy nhất dùng chung Go / Web / Worker)
import { resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '../..');

export function deskAliases(appDir: string) {
  return {
    '@shell': resolve(repoRoot, 'packages/ui-shell/src'),
    '@product': resolve(appDir, 'src'),
    '@contracts': resolve(repoRoot, 'contracts'),
  };
}
