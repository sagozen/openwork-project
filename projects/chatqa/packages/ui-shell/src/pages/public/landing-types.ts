// Kiểu nội dung trang chủ riêng của từng sản phẩm (PRODUCT.landing ở apps/*/web/src/product.ts).
export interface LandingItem {
  title: string;
  text: string;
}

/** Mục giới thiệu thêm giữa trang (vd cách dùng qua MCP, đội agent). */
export interface LandingSection {
  kicker: string;
  title: string;
  intro: string;
  items: readonly LandingItem[];
  note?: string;
}

/** Khối form xin license dùng thử; null/thiếu = không hiện form. */
export interface LandingTrial {
  title: string;
  intro: string;
  perks: readonly string[];
}

/** Một ý ở khối "Dữ liệu & quyền riêng tư" của trang chủ. */
export interface LandingTrust {
  icon: 'cloud' | 'lock' | 'shield';
  title: string;
  text: string;
}

/** Video giới thiệu ở đầu trang chủ (tệp nằm trong public/ của app); thiếu = hiện thẻ minh hoạ. */
export interface LandingVideo {
  src: string;
  poster: string;
  /** Mô tả cho trình đọc màn hình. */
  label: string;
  /** Phụ đề WebVTT trong public/ của app, bật sẵn; thiếu = không có phụ đề. */
  subtitles?: { src: string; lang: string; label: string };
  /** Video avatar tắt tiếng, vuông, dài bằng video chính (nhân vật nói khớp lồng tiếng), hiện ở ô tròn góc dưới; thiếu = không có. */
  avatar?: { src: string; poster?: string };
}

/** Skill cho AI agent (Claude Code, Codex, Cursor, Claude.ai) ở ngay dưới đầu trang chủ; null/thiếu = không hiện.
 *  Tệp nằm trong public/ của app: zip có thư mục <name>/ chứa SKILL.md. Lệnh cài và prompt dựng từ địa chỉ trang đang mở. */
export interface LandingAgentSkill {
  /** Tên thư mục skill, vd "chatqa". */
  name: string;
  /** Đường tải zip, vd "/skills/chatqa.zip". */
  zip: string;
  /** Đường xem SKILL.md, vd "/skills/chatqa/SKILL.md". */
  skillMd: string;
  title: string;
  intro: string;
  /** Câu giao việc mẫu sau khi cài. */
  examples: readonly string[];
}

/** Một gói ở khối bảng giá. cta.href bắt đầu bằng "/" là đường nội bộ, còn lại là liên kết thường (#neo, https://). */
export interface LandingPlan {
  name: string;
  price: string;
  priceNote: string;
  text: string;
  points: readonly string[];
  cta?: { label: string; href: string };
}

/** Khối bảng giá; null = không hiện. */
export interface LandingPricing {
  title: string;
  intro: string;
  plans: readonly LandingPlan[];
}

/** Khoá học dùng sản phẩm (trang ngoài, mở tab mới); null = không hiện link "Học" ở đầu/chân trang và khối giới thiệu khoá học. */
export interface LandingLearn {
  /** Nhãn link ở thanh trên và chân trang, vd "Học". */
  navLabel: string;
  /** Địa chỉ khoá học, phải là https://. */
  url: string;
  kicker: string;
  title: string;
  intro: string;
  points: readonly string[];
  /** Nhãn nút vào học trong khối. */
  cta: string;
}
