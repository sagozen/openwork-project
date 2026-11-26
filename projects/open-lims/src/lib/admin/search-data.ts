/* Chỉ mục tìm kiếm toàn cục (mock) - bám theo mockup DLP LIMS. */

export type SearchGroupKey = "hoso" | "mau" | "kh" | "phieu";

export interface SearchItem {
  g: SearchGroupKey;
  gn: string;
  title: string;
  /** Phụ đề; {KH} sẽ được thay bằng tên khách hàng (hoặc mask khi thiếu quyền PII). */
  sub: string;
  customer?: string;
  keys: string;
  tone: "info" | "success" | "danger" | "warning";
  tts: string;
  /** Đường dẫn mở khi chọn kết quả. */
  to: string;
}

export const SEARCH_GROUP_ORDER: SearchGroupKey[] = ["hoso", "mau", "kh", "phieu"];

export const PII_MASK = "••••••••";

export const SEARCH_INDEX: SearchItem[] = [
  {
    g: "hoso",
    gn: "Hồ sơ kiểm nghiệm",
    title: "26100012",
    sub: "Sầu riêng · {KH}",
    customer: "Cty TNHH XNK Nông sản An Phát",
    keys: "26100012 abcd1234567 51c-543.21 an phat sau rieng vang o cadimi",
    tone: "info",
    tts: "Chưa về PTN",
    to: "/ho-so-chi-tiet/26100012",
  },
  {
    g: "hoso",
    gn: "Hồ sơ kiểm nghiệm",
    title: "26100011",
    sub: "Mít · {KH}",
    customer: "Cty CP Thực phẩm Bình Minh",
    keys: "26100011 binh minh mit cadimi",
    tone: "success",
    tts: "Đang thử nghiệm",
    to: "/ho-so-chi-tiet/26100011",
  },
  {
    g: "hoso",
    gn: "Hồ sơ kiểm nghiệm",
    title: "26100009",
    sub: "Sầu riêng · {KH}",
    customer: "Cty TNHH Trái cây Phương Nam",
    keys: "26100009 phuong nam sau rieng qua han",
    tone: "danger",
    tts: "Quá hạn TT · khoá lab",
    to: "/ho-so-chi-tiet/26100009",
  },
  {
    g: "mau",
    gn: "Mẫu con và task",
    title: "2610001201VO",
    sub: "Task Vàng O · mẫu con 2610001201 · SKIN",
    keys: "2610001201vo 26100012 vang o task",
    tone: "success",
    tts: "Đang phân tích",
    to: "/ho-so-chi-tiet/26100012",
  },
  {
    g: "mau",
    gn: "Mẫu con và task",
    title: "2610001201CD",
    sub: "Task Cadimi · mẫu con 2610001201 · WHOLE",
    keys: "2610001201cd 26100012 cadimi task",
    tone: "info",
    tts: "Chờ xử lý",
    to: "/ho-so-chi-tiet/26100012",
  },
  {
    g: "mau",
    gn: "Mẫu con và task",
    title: "2610001202",
    sub: "Mẫu con · quả số 2 · đã chia vial",
    keys: "2610001202 26100012 mau con",
    tone: "success",
    tts: "Đã chia mẫu",
    to: "/ho-so-chi-tiet/26100012",
  },
  {
    g: "kh",
    gn: "Khách hàng",
    title: "Cty TNHH XNK Nông sản An Phát",
    sub: "45 Lê Lợi, TP. Cần Thơ · 6 hồ sơ đang mở",
    customer: "Cty TNHH XNK Nông sản An Phát",
    keys: "an phat xnk nong san can tho khach hang",
    tone: "success",
    tts: "Đang hợp tác",
    to: "/ho-so",
  },
  {
    g: "kh",
    gn: "Khách hàng",
    title: "Cty CP Thực phẩm Bình Minh",
    sub: "KCN Quang Minh, Hà Nội · 2 hồ sơ đang mở",
    customer: "Cty CP Thực phẩm Bình Minh",
    keys: "binh minh thuc pham khach hang",
    tone: "success",
    tts: "Đang hợp tác",
    to: "/ho-so",
  },
  {
    g: "phieu",
    gn: "Phiếu kết quả",
    title: "KQ26000045",
    sub: "Hồ sơ 26100012 · v2 · chờ phê duyệt",
    keys: "kq26000045 26100012 phieu ket qua",
    tone: "info",
    tts: "Chờ phê duyệt",
    to: "/ho-so-chi-tiet/26100012",
  },
  {
    g: "phieu",
    gn: "Phiếu kết quả",
    title: "KQ26000044",
    sub: "Hồ sơ 26100011 · đã phát hành 31/07",
    keys: "kq26000044 26100011 phat hanh",
    tone: "success",
    tts: "Đã phát hành",
    to: "/ho-so-chi-tiet/26100011",
  },
];

export const RECENT_SEARCHES: { kind: string; text: string }[] = [
  { kind: "Mã lượt", text: "26100012" },
  { kind: "Container", text: "ABCD1234567" },
  { kind: "Khách hàng", text: "An Phát" },
];

/** Bỏ dấu tiếng Việt + hạ chữ thường để so khớp gần đúng. */
export function normalize(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

export function resolveSub(item: SearchItem, canPii: boolean): string {
  if (!item.sub.includes("{KH}")) return item.sub;
  return item.sub.replace("{KH}", canPii ? (item.customer ?? "") : PII_MASK);
}

export function resolveTitle(item: SearchItem, canPii: boolean): string {
  if (item.g === "kh" && !canPii) return PII_MASK;
  return item.title;
}

export function searchIndex(query: string, canPii: boolean): SearchItem[] {
  const nq = normalize(query).trim();
  if (!nq) return [];
  return SEARCH_INDEX.filter((i) =>
    normalize(`${i.title} ${resolveSub(i, canPii)} ${i.keys}`).includes(nq),
  );
}

export function groupHits(
  hits: SearchItem[],
  limitPerGroup?: number,
): { key: SearchGroupKey; name: string; count: number; items: SearchItem[] }[] {
  return SEARCH_GROUP_ORDER.map((g) => {
    const items = hits.filter((i) => i.g === g);
    if (!items.length) return null;
    return {
      key: g,
      name: items[0]!.gn,
      count: items.length,
      items: limitPerGroup ? items.slice(0, limitPerGroup) : items,
    };
  }).filter(Boolean) as {
    key: SearchGroupKey;
    name: string;
    count: number;
    items: SearchItem[];
  }[];
}
