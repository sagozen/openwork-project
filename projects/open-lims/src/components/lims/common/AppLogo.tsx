/* Dấu hiệu nhận diện của Đa Liên Phát dùng chung cho mọi màn.
 *
 * Gom về một chỗ để thanh điều hướng, màn đăng nhập, màn SSO và ứng dụng lấy mẫu hiện trường
 * luôn hiển thị cùng một dấu hiệu. Khi có logo ảnh chính thức, chỉ cần thay phần <svg> bên dưới
 * (hoặc trỏ sang file ảnh) là toàn bộ các màn cập nhật theo. */

type AppLogoVariant = "accent" | "on-accent";

type AppLogoProps = {
  /** Cạnh của khối logo, tính bằng px. */
  size?: number;
  /** `on-accent` dùng khi đặt logo trên nền màu chủ đạo (thanh tiêu đề mobile). */
  variant?: AppLogoVariant;
  className?: string;
};

export function AppLogo({ size = 32, variant = "accent", className }: AppLogoProps) {
  const onAccent = variant === "on-accent";
  const tile = onAccent ? "rgba(255,255,255,0.22)" : "var(--action-primary)";
  const glyph = onAccent ? "currentColor" : "var(--foreground-on-accent)";

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Đa Liên Phát"
      style={{ flex: `0 0 ${size}px`, display: "block" }}
    >
      <rect width="64" height="64" rx="14" fill={tile} />
      <text
        x="32"
        y="33"
        textAnchor="middle"
        dominantBaseline="central"
        fill={glyph}
        fontFamily="var(--font-family-base, system-ui, sans-serif)"
        fontSize="34"
        fontWeight="700"
        letterSpacing="-1"
      >
        D
      </text>
    </svg>
  );
}
