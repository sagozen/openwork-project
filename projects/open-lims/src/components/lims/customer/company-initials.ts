/** Từ chỉ loại hình doanh nghiệp, không phải tên riêng. Bỏ chúng đi thì «Cty TNHH XNK Nông sản
 *  An Phát» ra NP chứ không phải C như mọi công ty khác trong danh sách. */
const LEGAL_FORM_WORDS = new Set([
  "cty",
  "công",
  "cong",
  "ty",
  "tnhh",
  "cp",
  "ctcp",
  "mtv",
  "dntn",
  "htx",
  "một",
  "thành",
  "viên",
  "co",
  "ltd",
  "jsc",
  "corp",
  "xnk",
  "xnk.",
  "tm",
  "dv",
  "sx",
  "sxtm",
  "dt",
  "xd",
]);

/** Chữ tắt lấy từ chữ đầu và chữ cuối của phần tên riêng - hai công ty cùng ngành nghề vẫn ra
 *  hai chữ tắt khác nhau. */
export function companyInitials(name: string): string {
  const words = name
    .split(/[\s.,\-/()]+/)
    .filter(Boolean)
    .filter((w) => !LEGAL_FORM_WORDS.has(w.toLowerCase()));
  const picked = words.length >= 2 ? [words[0], words[words.length - 1]] : words;
  const initials = picked
    .map((w) => (w ?? "").charAt(0))
    .join("")
    .toUpperCase();
  return initials || name.trim().charAt(0).toUpperCase();
}
