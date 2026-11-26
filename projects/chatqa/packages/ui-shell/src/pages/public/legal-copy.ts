// Nội dung pháp lý công khai cho cả hai sản phẩm (HS Desk, ChatQASoftware): Google OAuth yêu cầu trang chủ và
// chính sách quyền riêng tư mở được mà không cần đăng nhập, và chính sách phải nêu rõ dữ liệu nào được thu thập,
// dùng làm gì, lưu ở đâu, chia sẻ với ai. Tách khỏi React để dễ soát nội dung và test.

export const OPERATOR = 'ZeroHostCMS';
export const CONTACT_EMAIL = 'support@zhst.app';
/** Ngày hiệu lực của cả hai văn bản (hiện ở đầu trang). */
export const EFFECTIVE_DATE = '25/11/2026';
/** Tên chung của nền tảng: hai sản phẩm dùng cùng Worker, tài khoản và bản quyền. */
export const PLATFORM = 'HS Desk và ChatQASoftware';

export interface LegalBullet {
  /** Cụm chữ đậm đầu dòng; bỏ trống thì chỉ có câu. */
  term?: string;
  text: string;
}

export interface LegalSection {
  title: string;
  paragraphs?: string[];
  bullets?: LegalBullet[];
  /** Đoạn kết trong khung nền nhạt (lưu ý quan trọng). */
  note?: string;
}

export const PRIVACY_INTRO =
  `Chính sách này giải thích ${OPERATOR} thu thập, sử dụng, lưu trữ và chia sẻ những dữ liệu nào khi bạn dùng ${PLATFORM} — ` +
  'gồm ứng dụng trên máy tính, bản web/PWA và máy chủ của chúng tôi. Chúng tôi chỉ thu thập dữ liệu cần thiết để vận hành dịch vụ.';

export const PRIVACY_SUMMARY =
  'Tóm tắt: dữ liệu nghiệp vụ của HS Desk (báo giá, lô hàng, tờ khai, sổ dạy AI) nằm trong Google Drive của chính công ty bạn. ' +
  'Dữ liệu kiểm thử của ChatQASoftware (flow, ảnh chụp, nhật ký, báo cáo) nằm trên máy bạn; nếu công ty bật đồng bộ nhóm thì nằm thêm trong bucket S3-compatible do công ty tự cấu hình, ChatQASoftware không dùng Google Drive. ' +
  'Máy chủ của chúng tôi giữ tài khoản, bản quyền, thiết bị, nhật ký bảo mật và (với HS Desk) refresh token Google đã mã hoá. ' +
  'Chúng tôi không bán dữ liệu, không dùng dữ liệu cho quảng cáo và không đọc nội dung Drive của bạn ngoài phạm vi bạn cấp quyền.';

export const PRIVACY: LegalSection[] = [
  {
    title: '1. Phạm vi áp dụng',
    paragraphs: [
      `${OPERATOR} ("chúng tôi") vận hành ${PLATFORM}. Chính sách này áp dụng cho website hsdesk.zhst.app và chatqasoft.zhst.app, ứng dụng cài trên máy tính, bản web/PWA và các API đi kèm.`,
      'Người dùng là nhân viên, quản lý hoặc người được công ty cấp tài khoản. Khi dùng dịch vụ, bạn đồng ý với cách xử lý dữ liệu mô tả dưới đây. Nếu bạn dùng dịch vụ cho một công ty, công ty đó là bên kiểm soát dữ liệu nghiệp vụ; chúng tôi xử lý dữ liệu đó thay mặt công ty.',
    ],
  },
  {
    title: '2. Dữ liệu chúng tôi thu thập',
    paragraphs: ['Chúng tôi thu thập các nhóm dữ liệu sau:'],
    bullets: [
      {
        term: 'Tài khoản và bản quyền.',
        text: 'Tên đăng nhập, tên hiển thị, email (nếu bạn cung cấp), vai trò và quyền được cấp, công ty/đơn vị, mã bản quyền, thời hạn bản quyền và danh sách ứng dụng được bật.',
      },
      {
        term: 'Thiết bị và phiên đăng nhập.',
        text: 'Mã thiết bị và chuỗi băm nhận diện thiết bị, tên máy, hệ điều hành, phiên bản ứng dụng, thời điểm đăng nhập, địa chỉ IP, loại trình duyệt và thời điểm hoạt động gần nhất.',
      },
      {
        term: 'Dữ liệu Google (chỉ HS Desk, khi quản trị viên kết nối Google Drive).',
        text: 'Địa chỉ email Google và thông tin hồ sơ cơ bản (openid, email); các tệp và thư mục do ứng dụng tạo hoặc do bạn chủ động chọn qua Google Picker; nội dung Google Sheets mà ứng dụng đọc hoặc ghi. Refresh token Google được mã hoá bằng AES-256 trước khi lưu.',
      },
      {
        term: 'Dữ liệu nghiệp vụ bạn nhập (HS Desk).',
        text: 'Báo giá, lô hàng, mã HS, biểu thuế, tờ khai, danh mục, ghi chú và sổ dạy AI. Dữ liệu này được lưu trong Google Drive của công ty bạn; máy chủ của chúng tôi không lưu bản sao lâu dài, chỉ xử lý tạm thời khi đồng bộ hoặc khi bạn yêu cầu.',
      },
      {
        term: 'Dữ liệu kiểm thử (ChatQASoftware).',
        text: 'Flow, tài liệu nghiệp vụ, ảnh chụp màn hình, nhật ký và báo cáo lượt chạy được lưu trên máy bạn, không gửi lên máy chủ của chúng tôi. Nếu công ty bật đồng bộ nhóm, các tệp này được đẩy tới bucket S3-compatible do công ty cấu hình; khoá S3 nằm trong kho bí mật của hệ điều hành trên máy bạn, chúng tôi không nhận và không lưu.',
      },
      {
        term: 'Đăng ký dùng thử.',
        text: 'Họ tên, email và tên công ty (không bắt buộc) bạn nhập ở form nhận license dùng thử, cùng chuỗi băm của địa chỉ IP (không lưu IP gốc) để giới hạn lạm dụng. Chúng tôi gửi License Key và thông tin đăng nhập tới đúng email đó.',
      },
      {
        term: 'Dữ liệu gửi cho tính năng AI.',
        text: 'Nội dung bạn gửi để phân tích (mô tả mặt hàng, hình ảnh, mã HS, câu hỏi; với ChatQASoftware là nội dung chat và kết quả công cụ đã che bí mật) và kết quả trả về; số token và chi phí ước tính để áp ngân sách. Không gửi dữ liệu cá nhân nhạy cảm vào ô chat AI.',
      },
      {
        term: 'Nhật ký vận hành và bảo mật.',
        text: 'Lịch sử đăng nhập, thay đổi quyền, kết nối/ngắt kết nối Drive, thao tác quản trị, lỗi hệ thống và sự kiện bảo mật. Nhật ký dùng để truy vết và bảo vệ tài khoản.',
      },
    ],
    note:
      'Chúng tôi không thu thập và không yêu cầu quyền truy cập Gmail, Danh bạ, Lịch, Ảnh hay các tệp Drive khác ngoài phạm vi bạn cấp. Chúng tôi không dùng mã nhận diện quảng cáo, không theo dõi vị trí và không thu thập dữ liệu sinh trắc học.',
  },
  {
    title: '3. Mục đích sử dụng dữ liệu',
    paragraphs: ['Chúng tôi dùng dữ liệu để:'],
    bullets: [
      { text: 'Xác thực đăng nhập, duy trì phiên làm việc và bảo vệ tài khoản khỏi truy cập trái phép.' },
      { text: 'Cấp và kiểm tra bản quyền, quản lý thiết bị, phân quyền theo vai trò và đồng bộ dữ liệu giữa các máy.' },
      { text: 'Thực hiện các tính năng bạn yêu cầu: báo giá, gộp lô, kiểm tra khai báo, sổ dạy AI, kiểm thử chat và báo cáo.' },
      { text: 'Gửi nội dung tới nhà cung cấp AI để tạo gợi ý, phân tích hình ảnh hoặc kiểm tra mâu thuẫn, và ghi nhận chi phí AI.' },
      { text: 'Cấp license dùng thử và gửi thông tin đăng nhập qua email khi bạn đăng ký.' },
      { text: 'Hỗ trợ kỹ thuật, khắc phục lỗi, đo độ ổn định và cải thiện chất lượng sản phẩm trên dữ liệu tổng hợp hoặc đã ẩn danh.' },
      { text: 'Phòng chống gian lận, lạm dụng, tấn công và tuân thủ nghĩa vụ pháp lý khi có yêu cầu hợp pháp.' },
    ],
    note:
      'Căn cứ xử lý: thực hiện hợp đồng hoặc yêu cầu của bạn; sự đồng ý của bạn (kết nối Google, dùng tính năng AI); lợi ích hợp pháp (bảo mật, chống gian lận); và nghĩa vụ pháp luật áp dụng.',
  },
  {
    title: '4. Dữ liệu Google và cam kết Limited Use',
    paragraphs: [
      'Mục này chỉ áp dụng cho HS Desk. ChatQASoftware không yêu cầu quyền truy cập dữ liệu Google. Khi quản trị viên HS Desk kết nối Google Drive, ứng dụng yêu cầu các quyền: openid và email (để biết tài khoản Google đang kết nối) và https://www.googleapis.com/auth/drive.file (chỉ các tệp do ứng dụng tạo hoặc bạn chọn). HS Desk yêu cầu thêm https://www.googleapis.com/auth/spreadsheets để đọc và ghi các Google Sheets nghiệp vụ của công ty.',
      'Chúng tôi chỉ dùng dữ liệu Google cho các tính năng người dùng nhìn thấy: đồng bộ dữ liệu, đọc/ghi bảng tính, tạo thư mục và tệp làm việc. Chúng tôi không bán dữ liệu Google, không dùng cho quảng cáo hoặc xây dựng hồ sơ quảng cáo, không chuyển cho bên thứ ba ngoài các trường hợp cần thiết để vận hành dịch vụ hoặc theo yêu cầu pháp luật, và không cho người đọc dữ liệu Google của bạn trừ khi bạn đồng ý cho hỗ trợ cụ thể hoặc pháp luật yêu cầu.',
      `${OPERATOR}'s use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements.`,
      'Bạn có thể ngắt kết nối bất cứ lúc nào trong phần Quản trị → Kết nối Drive, hoặc tại trang quyền truy cập của Tài khoản Google. Sau khi ngắt, chúng tôi xoá refresh token đã lưu; các tệp đã tạo trên Drive vẫn thuộc quyền quản lý của bạn.',
    ],
  },
  {
    title: '5. Lưu trữ và bảo mật',
    paragraphs: [
      'Hệ thống chạy trên Cloudflare Workers, D1 (cơ sở dữ liệu tài khoản, bản quyền, phiên, nhật ký) và R2 (bản phát hành ứng dụng). Kết nối giữa ứng dụng và máy chủ dùng HTTPS/TLS. Mật khẩu được băm bằng PBKDF2 có muối, không lưu dạng đọc được. Refresh token Google được mã hoá AES-256. Phiên đăng nhập có thời hạn và bị thu hồi khi đổi mật khẩu hoặc khi quản trị viên khoá tài khoản.',
      'Chúng tôi áp dụng phân quyền theo vai trò, nguyên tắc tối thiểu quyền, ghi nhật ký thao tác quản trị và giới hạn tần suất đăng nhập. Dù vậy, không hệ thống nào an toàn tuyệt đối; bạn cần giữ mật khẩu và thiết bị của mình.',
    ],
  },
  {
    title: '6. Chia sẻ dữ liệu với bên thứ ba',
    paragraphs: ['Chúng tôi không bán dữ liệu cá nhân. Dữ liệu chỉ được chia sẻ ở mức cần thiết với:'],
    bullets: [
      { term: 'Cloudflare.', text: 'Lưu trữ máy chủ, cơ sở dữ liệu, tệp phát hành, gửi email license (Cloudflare Email Service) và bảo vệ hạ tầng.' },
      { term: 'Google.', text: 'HS Desk: đăng nhập OAuth và truy cập Drive/Sheets trong phạm vi bạn cấp quyền.' },
      { term: 'Nhà cung cấp S3-compatible.', text: 'ChatQASoftware: nếu công ty bật đồng bộ nhóm, tệp được gửi tới bucket do công ty tự chọn và quản lý; chúng tôi không có quyền truy cập bucket đó.' },
      { term: 'Nhà cung cấp AI.', text: 'Alibaba Cloud Model Studio (Qwen), fal.ai (OpenRouter) hoặc Anthropic (Claude) nhận nội dung bạn gửi để trả kết quả; ở chế độ thử nghiệm, Cloudflare Workers AI có thể được dùng. Nội dung được xử lý theo chính sách của nhà cung cấp tương ứng.' },
      { term: 'Cơ quan có thẩm quyền.', text: 'Khi có yêu cầu hợp pháp, hoặc để bảo vệ quyền, tài sản và an toàn của người dùng.' },
      { term: 'Chuyển giao doanh nghiệp.', text: 'Nếu sản phẩm được chuyển giao, dữ liệu có thể được chuyển cho bên kế thừa với cam kết bảo vệ tương đương.' },
    ],
  },
  {
    title: '7. Thời gian lưu trữ',
    bullets: [
      { text: 'Tài khoản, bản quyền và thiết bị: giữ trong thời gian tài khoản còn hoạt động và tối đa 30 ngày sau khi xoá, trừ dữ liệu phải giữ theo luật.' },
      { text: 'Phiên đăng nhập: theo thời hạn phiên; refresh token Google: đến khi ngắt kết nối hoặc thu hồi quyền.' },
      { text: 'Nhật ký đăng nhập, quản trị và bảo mật: tối đa 24 tháng.' },
      { text: 'Số liệu chi phí AI: tối đa 24 tháng để đối soát ngân sách.' },
      { text: 'Dữ liệu nghiệp vụ trong Google Drive, dữ liệu kiểm thử trên máy và trong bucket S3: do công ty bạn quyết định; chúng tôi không giữ bản sao lâu dài.' },
      { text: 'Yêu cầu dùng thử (họ tên, email, công ty, chuỗi băm IP): gắn với tài khoản được cấp và xoá cùng tài khoản.' },
    ],
  },
  {
    title: '8. Quyền của bạn',
    paragraphs: ['Trong phạm vi pháp luật cho phép, bạn có quyền:'],
    bullets: [
      { text: 'Xem, sao chép và yêu cầu giải thích dữ liệu cá nhân mà chúng tôi đang giữ về bạn.' },
      { text: 'Yêu cầu chỉnh sửa dữ liệu sai hoặc bổ sung dữ liệu còn thiếu.' },
      { text: 'Yêu cầu xoá tài khoản và dữ liệu cá nhân, hoặc hạn chế/phản đối một số cách xử lý.' },
      { text: 'Rút lại sự đồng ý (ví dụ ngắt kết nối Google) mà không ảnh hưởng đến tính hợp pháp của xử lý trước đó.' },
      { text: 'Khiếu nại với cơ quan bảo vệ dữ liệu có thẩm quyền.' },
    ],
    note:
      `Gửi yêu cầu tới ${CONTACT_EMAIL} từ email đã đăng ký. Chúng tôi có thể cần xác minh danh tính và sẽ trả lời trong vòng 30 ngày. Nếu tài khoản thuộc một công ty, yêu cầu về dữ liệu nghiệp vụ có thể được chuyển cho quản trị viên của công ty đó.`,
  },
  {
    title: '9. Cookie và bộ nhớ trình duyệt',
    paragraphs: [
      'Bản web dùng localStorage để giữ token phiên đăng nhập và tên đăng nhập gần nhất, và dùng service worker để tải ứng dụng nhanh hơn. Chúng tôi không dùng cookie quảng cáo, không nhúng trình theo dõi của bên thứ ba và không bán dữ liệu duyệt web.',
      'Bạn có thể xoá dữ liệu trình duyệt bất cứ lúc nào; khi đó bạn sẽ phải đăng nhập lại. Việc xoá dữ liệu trình duyệt không xoá dữ liệu nghiệp vụ trên Google Drive hay dữ liệu kiểm thử trên máy.',
    ],
  },
  {
    title: '10. Chuyển dữ liệu ra nước ngoài',
    paragraphs: [
      'Cloudflare, Google và nhà cung cấp AI có thể xử lý dữ liệu ngoài Việt Nam. Chúng tôi chọn nhà cung cấp có cam kết bảo mật và hợp đồng xử lý dữ liệu phù hợp, đồng thời chỉ chuyển dữ liệu cần thiết để vận hành dịch vụ.',
    ],
  },
  {
    title: '11. Trẻ em',
    paragraphs: ['Dịch vụ dành cho người lao động và doanh nghiệp, không dành cho người dưới 16 tuổi. Chúng tôi không cố ý thu thập dữ liệu của trẻ em; nếu phát hiện, chúng tôi sẽ xoá.'],
  },
  {
    title: '12. Thay đổi chính sách',
    paragraphs: [
      `Khi chính sách thay đổi, chúng tôi cập nhật ngày hiệu lực ở đầu trang và thông báo trong ứng dụng hoặc qua email nếu thay đổi ảnh hưởng đáng kể đến quyền của bạn. Tiếp tục dùng dịch vụ sau ngày hiệu lực nghĩa là bạn chấp nhận bản cập nhật.`,
    ],
  },
  {
    title: '13. Liên hệ',
    paragraphs: [
      `Đơn vị vận hành: ${OPERATOR}. Email: ${CONTACT_EMAIL}. Chúng tôi tiếp nhận câu hỏi, yêu cầu về dữ liệu và khiếu nại qua email này.`,
    ],
  },
];

export const TERMS_INTRO =
  `Các điều khoản này là thỏa thuận giữa bạn (hoặc công ty cấp tài khoản cho bạn) và ${OPERATOR} về việc sử dụng ${PLATFORM}. ` +
  'Vui lòng đọc kỹ, đặc biệt phần về dữ liệu, trí tuệ nhân tạo và giới hạn trách nhiệm.';

export const TERMS: LegalSection[] = [
  {
    title: '1. Chấp nhận điều khoản',
    paragraphs: [
      `Khi tạo tài khoản, đăng nhập hoặc dùng ${PLATFORM}, bạn xác nhận đã đọc và đồng ý với các điều khoản này và Chính sách quyền riêng tư. Nếu bạn dùng dịch vụ thay mặt một công ty, bạn xác nhận có thẩm quyền ràng buộc công ty đó. Nếu không đồng ý, vui lòng không dùng dịch vụ.`,
    ],
  },
  {
    title: '2. Định nghĩa',
    bullets: [
      { term: 'Dịch vụ.', text: `${PLATFORM}, gồm ứng dụng trên máy tính, bản web/PWA, máy chủ và các tính năng AI đi kèm.` },
      { term: 'Tài khoản.', text: 'Tên đăng nhập do quản trị viên công ty cấp, gắn với vai trò và quyền cụ thể.' },
      { term: 'Dữ liệu nghiệp vụ.', text: 'Báo giá, lô hàng, tờ khai, danh mục, sổ dạy AI, báo cáo và nội dung khác bạn nhập hoặc tạo trong Dịch vụ.' },
      { term: 'Chủ tài khoản.', text: 'Công ty hoặc đơn vị sở hữu bản quyền và nơi lưu dữ liệu dùng với Dịch vụ (Google Drive với HS Desk; máy tính và bucket S3 với ChatQASoftware).' },
    ],
  },
  {
    title: '3. Quyền sử dụng',
    paragraphs: [
      'Chúng tôi cấp cho bạn quyền không độc quyền, không chuyển nhượng, có thời hạn để dùng Dịch vụ trong phạm vi bản quyền và quyền được cấp, chỉ cho mục đích kinh doanh hợp pháp của Chủ tài khoản.',
    ],
    bullets: [
      { text: 'Không sao chép, bán, cho thuê lại, phân phối lại hoặc cung cấp Dịch vụ cho bên thứ ba ngoài phạm vi được phép.' },
      { text: 'Không tháo gỡ, vô hiệu hoá hoặc vượt qua cơ chế bản quyền, xác thực, giới hạn thiết bị hay bảo vệ kỹ thuật.' },
      { text: 'Không dịch ngược, sửa đổi mã nguồn hoặc tạo sản phẩm phái sinh, trừ khi pháp luật cho phép.' },
    ],
  },
  {
    title: '4. Tài khoản và bảo mật',
    paragraphs: [
      'Bạn chịu trách nhiệm bảo mật thông tin đăng nhập và mọi hoạt động dưới tài khoản của mình. Không chia sẻ tài khoản cho người không được cấp quyền. Thông báo ngay cho quản trị viên công ty và chúng tôi khi nghi ngờ lộ mật khẩu hoặc truy cập trái phép.',
      'Quản trị viên công ty quản lý người dùng, vai trò, quyền và thiết bị. Chủ tài khoản chịu trách nhiệm về việc cấp và thu hồi quyền cho nhân viên của mình.',
    ],
  },
  {
    title: '5. Dữ liệu và nơi lưu trữ',
    paragraphs: [
      'Dữ liệu nghiệp vụ thuộc Chủ tài khoản. Với HS Desk, dữ liệu được lưu trong Google Drive của Chủ tài khoản; bạn cấp cho chúng tôi quyền truy cập cần thiết để đồng bộ, đọc và ghi trong phạm vi bạn cho phép. Với ChatQASoftware, dữ liệu kiểm thử nằm trên máy bạn và, nếu bật đồng bộ nhóm, trong bucket S3-compatible do Chủ tài khoản tự cấu hình và quản lý. Bạn chịu trách nhiệm sao lưu dữ liệu quan trọng và duy trì dung lượng, quyền truy cập của Google Drive hoặc bucket đó.',
      'Khi ngắt kết nối Google, HS Desk không còn đồng bộ được nhưng các tệp đã tạo vẫn nằm trên Drive của bạn. Chúng tôi không chịu trách nhiệm nếu bạn xoá, di chuyển hoặc thay đổi quyền các tệp đó, hoặc nếu bucket S3 của bạn mất dữ liệu.',
    ],
  },
  {
    title: '6. Tính năng trí tuệ nhân tạo',
    paragraphs: [
      'Các tính năng AI (gợi ý mã HS, phân tích mặt hàng, kiểm tra mâu thuẫn, kiểm thử chat) tạo ra kết quả ước tính dựa trên dữ liệu bạn cung cấp và mô hình của bên thứ ba. Kết quả có thể sai, thiếu hoặc lỗi thời.',
      'Bạn phải tự kiểm tra kết quả trước khi dùng cho báo giá, khai báo hải quan hoặc quyết định kinh doanh. Dịch vụ không thay thế tư vấn pháp lý, thuế hoặc nghiệp vụ của đại lý hải quan có chuyên môn, và không bảo đảm tờ khai được thông quan.',
      'Không gửi vào ô chat AI dữ liệu cá nhân nhạy cảm, bí mật thương mại không được phép chia sẻ hoặc nội dung vi phạm pháp luật.',
    ],
  },
  {
    title: '7. Hành vi bị cấm',
    bullets: [
      { text: 'Dùng Dịch vụ để vi phạm pháp luật, lừa đảo, giả mạo chứng từ hoặc khai báo hải quan sai.' },
      { text: 'Tải lên mã độc, tấn công, dò quét hoặc gây quá tải hệ thống.' },
      { text: 'Truy cập dữ liệu của công ty hoặc người dùng khác khi không được cấp quyền.' },
      { text: 'Thu thập dữ liệu tự động, sao chép hàng loạt hoặc dùng Dịch vụ để xây dựng sản phẩm cạnh tranh.' },
      { text: 'Sử dụng thương hiệu, giao diện hoặc tài liệu của chúng tôi mà không có văn bản đồng ý.' },
    ],
  },
  {
    title: '8. Phí, thời hạn và hoàn tiền',
    paragraphs: [
      'Phí, thời hạn bản quyền, số thiết bị và phạm vi ứng dụng được ghi trong báo giá hoặc hợp đồng giữa hai bên. Bản quyền có thể tạm ngừng khi hết hạn hoặc chưa thanh toán; dữ liệu trên Drive của bạn vẫn được giữ.',
      'Bản MCP của ChatQASoftware luôn miễn phí. Bản full (gồm Google ADK và khoá học nâng cao Agent Teams): license miễn phí 365 ngày, tối đa 3 máy, cấp qua email đăng ký, mỗi email một lần. Chúng tôi có thể thu hồi license dùng thử nếu phát hiện lạm dụng.',
      'Trừ khi hợp đồng hoặc pháp luật quy định khác, phí đã trả không được hoàn lại. Mọi khoản hoàn tiền (nếu có) do hai bên thoả thuận bằng văn bản.',
    ],
  },
  {
    title: '9. Sở hữu trí tuệ',
    paragraphs: [
      `Dịch vụ, mã nguồn, giao diện, tài liệu, nhãn hiệu và các thành phần do ${OPERATOR} phát triển thuộc quyền sở hữu của chúng tôi hoặc bên cấp phép. Bạn chỉ được dùng trong phạm vi các điều khoản này.`,
      'Bạn giữ quyền sở hữu Dữ liệu nghiệp vụ của mình. Bạn cấp cho chúng tôi quyền xử lý dữ liệu đó ở mức cần thiết để cung cấp Dịch vụ, hỗ trợ và khắc phục sự cố.',
    ],
  },
  {
    title: '10. Khả năng sẵn sàng và bảo trì',
    paragraphs: [
      'Chúng tôi nỗ lực duy trì Dịch vụ ổn định nhưng không bảo đảm hoạt động liên tục, không lỗi hoặc không bị gián đoạn. Có thể bảo trì, nâng cấp hoặc tạm ngừng một phần Dịch vụ; khi có thể, chúng tôi thông báo trước.',
      'Dịch vụ phụ thuộc vào hạ tầng Cloudflare, Google và nhà cung cấp AI; sự cố từ các bên này có thể ảnh hưởng đến Dịch vụ ngoài tầm kiểm soát của chúng tôi.',
    ],
  },
  {
    title: '11. Giới hạn trách nhiệm',
    paragraphs: [
      'Trong phạm vi pháp luật cho phép, chúng tôi không chịu trách nhiệm cho thiệt hại gián tiếp, ngẫu nhiên, đặc biệt hoặc hệ quả (mất lợi nhuận, mất dữ liệu, phạt hành chính, chậm thông quan) phát sinh từ việc dùng hoặc không dùng được Dịch vụ.',
      'Tổng trách nhiệm của chúng tôi cho mọi khiếu nại liên quan đến Dịch vụ không vượt quá số phí bạn hoặc Chủ tài khoản đã trả cho Dịch vụ trong 12 tháng trước thời điểm phát sinh khiếu nại. Giới hạn này không áp dụng với hành vi cố ý, gian dối hoặc trách nhiệm pháp luật không thể loại trừ.',
    ],
  },
  {
    title: '12. Chấm dứt',
    paragraphs: [
      'Bạn có thể ngừng dùng Dịch vụ bất cứ lúc nào. Chúng tôi có thể tạm ngừng hoặc chấm dứt quyền truy cập nếu bạn vi phạm điều khoản, không thanh toán, gây rủi ro bảo mật hoặc khi pháp luật yêu cầu. Khi chấm dứt, quyền sử dụng chấm dứt nhưng các nghĩa vụ về thanh toán, bảo mật, sở hữu trí tuệ và giới hạn trách nhiệm vẫn còn hiệu lực.',
    ],
  },
  {
    title: '13. Luật áp dụng và giải quyết tranh chấp',
    paragraphs: [
      'Các điều khoản này được điều chỉnh bởi pháp luật Việt Nam. Hai bên ưu tiên thương lượng thiện chí trong 30 ngày. Nếu không giải quyết được, tranh chấp được đưa ra cơ quan có thẩm quyền tại Việt Nam theo quy định pháp luật.',
    ],
  },
  {
    title: '14. Thay đổi điều khoản',
    paragraphs: [
      `Chúng tôi có thể cập nhật điều khoản để phản ánh thay đổi của Dịch vụ hoặc pháp luật. Ngày hiệu lực mới được ghi ở đầu trang. Thay đổi quan trọng sẽ được thông báo trong ứng dụng hoặc qua email. Tiếp tục dùng Dịch vụ sau ngày hiệu lực nghĩa là bạn chấp nhận điều khoản mới.`,
    ],
  },
  {
    title: '15. Liên hệ',
    paragraphs: [`Đơn vị vận hành: ${OPERATOR}. Email: ${CONTACT_EMAIL}.`],
  },
];
