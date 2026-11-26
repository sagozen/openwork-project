// Cứng hoá bản phát hành web (chống dịch ngược), dùng chung cho mọi app: chatqa + hs-desk.
// Chi tiết và cách build bản debug: docs/HARDENING.md.
//
// Bản debug: đặt HS_DEBUG_BUILD=1 trước `vite build` -> KHÔNG rối hoá, giữ sourcemap, minify nhẹ để dễ đọc và sửa lỗi.
//   vd: npm run build:desktop:debug  (hoặc  HS_DEBUG_BUILD=1 npm run build:desktop)
import obfuscator from 'vite-plugin-javascript-obfuscator';
import type { PluginOption, BuildOptions } from 'vite';

export function isDebugBuild(): boolean {
  return process.env.HS_DEBUG_BUILD === '1';
}

// Mức "mạnh": mảng chuỗi mã hoá base64 + control-flow flattening + chèn mã chết + rối tên/khoá object.
// Ngưỡng đặt dưới 1 để cân bằng giữa độ khó đọc và phình bundle/chậm runtime; nâng lên 1 nếu muốn tối đa.
const OBFUSCATE = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.6,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 10,
  transformObjectKeys: true,
  // Đường dẫn module trong import() / lazy(): tách chuỗi hay đưa vào mảng chuỗi thì bundler không còn thấy chunk,
  // lúc chạy trình duyệt xin "assets/lot/LotListPage" (không tồn tại) => "Failed to fetch dynamically imported module".
  reservedStrings: ['^\\.{1,2}/', '^@shell/', '^@/'],
} as const;

// Chỉ rối hoá CODE CỦA TA (whitelist), không đụng React/thư viện trong node_modules: vừa vô ích vừa làm chậm.
//   apps/<bất kỳ>/web/src/**  và  packages/ui-shell/src/**
const INCLUDE_OURS = [/[\\/](apps[\\/][^\\/]+[\\/]web|packages[\\/]ui-shell)[\\/]src[\\/]/];

// Plugin rối hoá cho plugins[]. Trả về false ở bản debug hoặc khi dev (apply:'build').
export function obfuscationPlugin(): PluginOption {
  if (isDebugBuild()) return false;
  return obfuscator({ apply: 'build', include: INCLUDE_OURS, options: OBFUSCATE as Record<string, unknown> });
}

// Tuỳ chọn build cứng hoá, trộn vào build của từng app. Bản debug: giữ dễ đọc.
export function hardenedBuild(): BuildOptions {
  const debug = isDebugBuild();
  return {
    // Sourcemap trả lại gần như toàn bộ mã gốc -> tắt ở bản phát hành, bật ở bản debug.
    sourcemap: debug,
    // Bản debug: không minify (mã đầy đủ, dễ đọc/đặt breakpoint). Phát hành: terser bỏ console/debugger + chú thích.
    // (Vite 8 chạy trên rolldown/oxc, không còn esbuild sẵn, nên không dùng minify:'esbuild'.)
    minify: debug ? false : 'terser',
    terserOptions: debug
      ? undefined
      : { compress: { drop_console: true, drop_debugger: true }, format: { comments: false } },
    // Gom React/thư viện vào chunk "vendor" (không rối hoá) để tách khỏi code đã rối của ta và cache tốt hơn.
    rollupOptions: {
      output: { manualChunks: (id: string) => (id.includes('node_modules') ? 'vendor' : undefined) },
    },
  };
}
