// Biểu tượng ChatQASoftware trên shell dùng chung (packages/ui-shell đọc qua @product/brand): khung chat có tick.
// Hình và màu chép từ docs/brand/chatqa: nền sáng theo logo-mark.svg (đỏ Viettel), nền tối theo app-icon.svg
// (khung trắng trên ô navy, tick đỏ) để biểu tượng đọc rõ trên thanh tiêu đề tối.
import type { ProductMarkProps } from '@shell/components/shell/product-mark';

const MARK = {
  light: {
    bubble: 'M168 96h176a72 72 0 0 1 72 72v120a72 72 0 0 1-72 72H232l-88 64v-64a72 72 0 0 1-48-68V168a72 72 0 0 1 72-72z',
    tick: 'M190 230l50 50 92-96',
    width: 40,
    fill: '#EE0033',
    stroke: '#fff',
  },
  dark: {
    bubble: 'M180 116h152a68 68 0 0 1 68 68v104a68 68 0 0 1-68 68H236l-80 58v-58.5a68 68 0 0 1-44-63.5V184a68 68 0 0 1 68-68z',
    tick: 'M196 238l46 46 84-88',
    width: 38,
    fill: '#FFFFFF',
    stroke: '#E4002B',
  },
} as const;

export function ProductMark({ className, tone }: ProductMarkProps) {
  const m = MARK[tone];
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden="true">
      <path d={m.bubble} fill={m.fill} />
      <path d={m.tick} fill="none" stroke={m.stroke} strokeWidth={m.width} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
