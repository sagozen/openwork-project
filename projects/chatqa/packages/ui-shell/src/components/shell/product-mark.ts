// Biểu tượng sản phẩm ở thanh tiêu đề, header web/điện thoại và thẻ đăng nhập. Mỗi app web tự vẽ ở src/brand.tsx
// (shell đọc qua @product/brand) để HS Desk giữ ô cam + kính lúp, ChatQASoftware dùng khung chat có tick (docs/brand/chatqa).
export interface ProductMarkProps {
  /** Kích thước, bo góc, co giãn do chỗ đặt quyết định (vd "h-[22px] w-[22px] shrink-0 rounded-[6px]"). */
  className: string;
  /** Cỡ hình bên trong ô (px), cho sản phẩm vẽ hình trên ô màu nhấn. */
  glyph: number;
  /** Nền đặt biểu tượng: dark = thanh tiêu đề tối (#0E1014), light = nền sáng. */
  tone: 'dark' | 'light';
}
