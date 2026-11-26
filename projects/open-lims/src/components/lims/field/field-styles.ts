/* Kiểu dựng chung của màn lấy mẫu hiện trường (S-05). Bản nối API và bản minh hoạ phải trông
   giống hệt nhau - khách góp ý trên bản minh hoạ thì góp ý đó mới áp được cho bản chạy thật -
   nên ba kiểu này ở một chỗ thay vì chép hai lần. */

export const card: React.CSSProperties = {
  padding: 14,
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-surface)",
  background: "var(--background-card)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

export const secondary: React.CSSProperties = {
  font: "12px/16px var(--font-family-base)",
  color: "var(--foreground-secondary)",
};

export const cardTitle: React.CSSProperties = {
  font: "600 14px/20px var(--font-family-base)",
};
