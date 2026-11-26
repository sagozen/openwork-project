// Sản phẩm của app web này trên shell dùng chung (packages/ui-shell đọc qua @product/product).
// code khớp contracts/products.json; APP_CODES khớp các app product "chatqa" trong contracts/apps.json (registry.test.ts).
import type { LandingAgentSkill, LandingLearn, LandingPricing, LandingSection, LandingTrial, LandingTrust, LandingVideo } from '@shell/pages/public/landing-types';

export const PRODUCT = {
  code: 'chatqa',
  name: 'ChatQASoftware',
  /** ChatQASoftware chưa có hàng đợi đồng bộ nào: null = thanh tiêu đề không hiện pill đồng bộ lúc rảnh. */
  syncDoneLabel: null,
  /** Viên tên công ty ở thanh tiêu đề: HS Desk không hiện, chỉ ChatQASoftware hiện. */
  companyBadge: true,
  /** Màn kích hoạt lần đầu: link sang trang chủ để nhận license miễn phí 1 năm. */
  freeLicense: { text: 'Chưa có mã bản quyền?', cta: 'Nhận 1 năm miễn phí', url: 'https://chatqasoft.zhst.app/#dung-thu' } as { text: string; cta: string; url: string } | null,
  /** Nội dung trang chủ công khai (shell đọc qua @product/product): Google OAuth cần trang chủ mở được khi chưa đăng nhập. */
  landing: {
    tagline: 'Kiểm thử app chat · MCP · Agent',
    headline: 'Kiểm thử app chat trên Android, iOS và web',
    intro:
      'Chạy flow trên máy thật và trình duyệt, giữ lại ảnh chụp, nhật ký và báo cáo cho từng lượt. Điều khiển từ app, từ Claude Code, Codex, Cursor qua MCP, hoặc giao cho đội agent.',
    /** Dòng nhỏ dưới các nút ở đầu trang; null = câu mặc định về tài khoản do công ty cấp. */
    accountNote: 'Mã nguồn mở. ChatQA MCP và bản tự host miễn phí. ChatQA ADK Agent dùng key riêng hoặc trả theo lượng dùng.' as string | null,
    /** Dòng chú thích dưới thẻ minh hoạ; null = không hiện. */
    heroNote: null as string | null,
    /** Kho mã nguồn: icon GitHub ở thanh trên; null = không hiện. */
    repoUrl: 'https://github.com/sagozen/openwork-project' as string | null,
    /** Video giới thiệu quay trên app thật (MCP, iOS, web, bằng chứng, đội agent), lồng tiếng, có phụ đề; tệp ở public/intro/. */
    heroVideo: {
      src: '/intro/chatqa-intro.mp4',
      poster: '/intro/chatqa-intro-poster.jpg',
      label: 'Video giới thiệu ChatQASoftware: MCP, chạy flow trên iOS và web, bằng chứng, đội agent Google ADK',
      subtitles: { src: '/intro/chatqa-intro.vi.vtt', lang: 'vi', label: 'Tiếng Việt' },
    } as LandingVideo | null,
    /** Skill cho AI agent: tệp ở public/skills/chatqa/, zip sinh lúc build (skill-zip.ts). */
    agentSkill: {
      name: 'chatqa',
      zip: '/skills/chatqa.zip',
      skillMd: '/skills/chatqa/SKILL.md',
      title: 'Cài ChatQA Skill để agent của bạn biết dùng ChatQA',
      intro:
        'Một skill cho Claude Code, Codex, Cursor và Claude: cách kết nối MCP, 49 tool, luật viết flow Maestro và Playwright, chạy lâu, bí mật, và cách giao việc cho đội agent Google ADK. Agent đọc skill rồi tự làm đúng quy trình, không phải đoán tham số.',
      examples: [
        'Xem máy nào đang rảnh, chạy flow đăng nhập của app mexpress trên mọi máy Android rồi báo p50/p95 và lỗi.',
        'Mở /login trên máy web-staging, viết flow .spec.ts đăng nhập bằng biến USERNAME và PASSWORD, chạy đạt thì lưu.',
        'Phân tích ảnh hưởng repo này từ v1.4.0 đến HEAD và cho biết nên chạy flow nào.',
        'Giao cho đội agent ADK chạy pipeline từ v1.4.0 đến v1.5.0, chờ xong rồi tóm tắt báo cáo.',
      ],
    } as LandingAgentSkill | null,
    /** Khoá học miễn phí trên mytutorlms: link "Học" ở đầu/chân trang và khối ngay dưới đầu trang. */
    learn: {
      navLabel: 'Học',
      url: 'https://mytutorlms.zhst.app/courses/chatqa-co-ban',
      kicker: 'Khoá học miễn phí',
      title: 'ChatQA Software cơ bản',
      intro:
        '19 bài ngắn có video, cẩm nang PDF, script cài đặt và buổi hỏi đáp qua Zoom. Làm theo từng bước trên máy Windows mới và điện thoại Android, đến khi Claude và Codex chạy được flow đầu tiên.',
      points: [
        'Cài app, kích hoạt, cài adb, bật gỡ lỗi USB',
        'Nối Claude Desktop, Claude Code, Codex qua MCP',
        'Tải cẩm nang PDF, cấu hình mẫu, câu lệnh mẫu',
      ],
      cta: 'Vào học miễn phí',
    } as LandingLearn | null,
    featuresTitle: 'Một app cho cả vòng kiểm thử',
    features: [
      { title: 'Điều phối máy', text: 'Android, iOS và trình duyệt. Xem màn hình trực tiếp, xếp hàng lượt chạy, đặt ngân sách và cảnh báo.' },
      { title: 'Flow', text: 'Maestro YAML cho Android và iOS, Playwright Test cho web.' },
      { title: 'Bằng chứng', text: 'Ảnh chụp, nhật ký, evidence.html, so sánh giữa các lượt, thống kê flaky.' },
      { title: 'Tài liệu và độ phủ', text: 'Gắn yêu cầu với flow, đo độ phủ, tìm ca bị ảnh hưởng từ git diff.' },
      { title: 'Đồng bộ nhóm', text: 'Flow, tài liệu và bằng chứng qua kho S3-compatible. Tuỳ chọn, xung đột do người gộp.' },
      { title: 'Quản trị', text: 'Phân quyền theo vai, quản lý thiết bị, ngân sách AI và nhật ký trên bản web.' },
    ],
    cardBadge: null as string | null,
    storeLabel: 'Dữ liệu trên máy · đồng bộ nhóm qua S3',
    /** Khối "Đã có tài khoản?" cuối trang; null = không hiện (đầu trang đã có nút Đăng nhập). */
    loginNote: null as string | null,
    pricing: {
      title: 'Miễn phí để bắt đầu, chỉ trả khi dùng model của chúng tôi',
      intro:
        'ChatQA MCP và bản tự host miễn phí. ChatQA ADK Agent chạy bằng API key của bạn, hoặc bằng model cloud của chúng tôi: nền tảng trả phí cho nhà cung cấp model, bạn dùng bao nhiêu trả bấy nhiêu.',
      plans: [
        {
          name: 'ChatQA MCP',
          price: 'Miễn phí',
          priceNote: 'License gửi qua email, gia hạn mỗi năm',
          text: 'Dùng trong Claude Code, Claude Desktop, Codex, Cursor và các client MCP khác, với model và tài khoản AI của chính bạn.',
          points: ['49 tool điều khiển máy, flow và tài liệu', 'Chạy cục bộ qua 127.0.0.1 và token', 'Gia hạn miễn phí, không cần thẻ'],
          cta: { label: 'Nhận license', href: '#dung-thu' },
        },
        {
          name: 'Tự host',
          price: 'Miễn phí',
          priceNote: 'Mã nguồn mở trên GitHub',
          text: 'Tự build từ mã nguồn và chạy trên hạ tầng của bạn. Toàn quyền với dữ liệu, cấu hình và nhà cung cấp model.',
          points: ['Build từ mã nguồn công khai', 'Tự chọn nhà cung cấp model', 'Dữ liệu nằm trên hạ tầng của bạn'],
          cta: { label: 'Xem mã nguồn', href: 'https://github.com/sagozen/openwork-project' },
        },
        {
          name: 'ChatQA ADK Agent',
          price: 'Theo lượng dùng',
          priceNote: 'Tài khoản mới được tặng $5 dùng thử',
          text: 'Đội agent Google ADK. Dùng API key của bạn, hoặc dùng model cloud của chúng tôi và trả đúng phần đã dùng.',
          points: ['Key riêng: trả thẳng cho nhà cung cấp model', 'Model cloud: không phí hằng tháng', 'Trần chi phí cho mỗi lượt và mỗi tháng'],
        },
      ],
    } as LandingPricing | null,
    trust: [
      { icon: 'cloud', title: 'Dữ liệu chạy trên máy bạn', text: 'Lượt chạy, báo cáo và bằng chứng lưu cục bộ. Máy chủ chỉ giữ license, bản phát hành và proxy AI.' },
      { icon: 'lock', title: 'Đồng bộ S3 là tuỳ chọn', text: 'Tắt mặc định. Khoá S3 nằm trong Keychain hoặc DPAPI, không đi vào log, MCP hay giao diện.' },
      { icon: 'shield', title: 'Bí mật không tới AI', text: 'AI chỉ thấy tên biến. Giá trị bị che trong kết quả tool và báo cáo.' },
    ] as readonly LandingTrust[],
    sections: [
      {
        kicker: 'ChatQA MCP',
        title: 'Dùng từ Claude Desktop, Claude Code, Codex và Cursor',
        intro: 'Bật ở Điều phối → Kết nối AI (MCP). AI dùng chung quyền, ngân sách và nhật ký lệnh với giao diện.',
        items: [
          { title: '49 tool', text: 'tower_*, device_*, web_*, test_*, docs_*, sync_*.' },
          { title: 'AI viết flow', text: 'Soạn Maestro hoặc Playwright, chạy kiểm chứng, đạt mới lưu.' },
          { title: 'Chạy cục bộ', text: '127.0.0.1 với token, cần app đang mở. AI chỉ thấy tên biến, không thấy giá trị bí mật.' },
        ],
      },
      {
        kicker: 'ChatQA ADK Agent',
        title: 'Đội agent Google ADK',
        intro: 'Từ git diff đến báo cáo: chọn flow, chạy trên máy rảnh, phân loại lỗi và viết báo cáo. Dùng API key riêng, hoặc model cloud của chúng tôi tính theo lượng dùng.',
        items: [
          { title: 'Sáu vai trò', text: 'coordinator, planner, runner, triage, reporter, flowfixer.' },
          { title: 'Phân loại lỗi', text: 'app, selector, data, environment. Nhớ lỗi đã biết và theo dõi flaky.' },
          { title: 'Người duyệt và giới hạn', text: 'Hỏi trước khi đổi dữ liệu, chạm production hoặc áp bản nháp. Trần bước, thời gian, token và chi phí mỗi lượt.' },
          { title: 'CI và mở rộng', text: 'ChatQASoftware --pipeline hoặc API /agent/. MCP ngoài theo allowlist, OpenTelemetry về collector riêng.' },
        ],
        note: 'Tắt mặc định, bật ở Cài đặt → Agent. Đặt key riêng ở Cài đặt → Dịch vụ AI.',
      },
    ] as readonly LandingSection[],
    trial: {
      title: 'Nhận license ChatQA MCP miễn phí',
      intro: 'Nhập email để nhận License Key và tài khoản quản trị. License có hiệu lực 1 năm, hết hạn thì gia hạn miễn phí.',
      perks: ['3 phân hệ: Điều phối, Kiểm thử, Giám sát', 'Dùng trên 3 máy', 'Windows tự cập nhật (OTA)'],
    } as LandingTrial | null,
  },
} as const;

export const APP_CODES = ['cqs.tower', 'cqs.test', 'cqs.monitor'] as const;
