// Nguồn duy nhất của khoá "Sử dụng ChatQASoftware": giáo trình, ghi chú bài học, cảnh video và lời đọc.
// PDF (build-handbook.mjs), slide + video (build-slides.mjs, build-videos.py) và dữ liệu đăng lên LMS (publish-course.mjs) đều đọc file này.
//
// Mỗi bài: id (ổn định, dùng làm id bài trên LMS và tên file media), title, minutes, notes (ghi chú hiện trong lớp học và PDF,
// chữ thường, xuống dòng giữ nguyên), scenes (cảnh video: visual + say = lời đọc; caption = phụ đề nếu khác lời đọc),
// resources (khoá trong RESOURCES, tải về kèm bài).
//
// Dữ kiện lấy từ mã nguồn hs-desk (apps/chatqa, packages/ui-shell, docs/MCP_CLIENTS.md) ngày 26/11/2026.
// Phần về Windows, Android, Claude Desktop, Claude Code và Codex viết theo tài liệu chính thức của từng hãng; cần quay thử trên máy thật.

export const SITE = 'https://mytutorlms.zhst.app';
export const MEDIA_PREFIX = 'courses/chatqa';
export const mediaUrl = (file) => `${SITE}/_emdash/api/media/file/${MEDIA_PREFIX}/${file}`;

export const COURSE = {
  slug: 'chatqa',
  title: 'ChatQA Software cơ bản',
  summary:
    'Cài ChatQASoftware trên máy Windows mới, nối điện thoại Android, rồi giao việc kiểm thử cho Claude và Codex qua MCP. Miễn phí, có video, PDF và buổi hỏi đáp trực tiếp.',
  description: [
    'Khoá học dành cho người chưa từng dùng ChatQASoftware, kể cả khi bạn chưa biết lập trình.',
    'Bạn sẽ làm theo từng bước trên một máy Windows mới và một điện thoại Android: nhận license miễn phí 1 năm, cài app, kích hoạt, cài adb, bật gỡ lỗi USB, thấy điện thoại trong app, rồi nối Claude Desktop, Claude Code và Codex qua MCP để AI tự viết và chạy flow kiểm thử.',
    'Mỗi bài có video ngắn, ghi chú làm theo được, tài nguyên tải về (cẩm nang PDF, cấu hình mẫu, script cài đặt) và lịch đào tạo trực tiếp qua Zoom để hỏi đáp.',
  ].join('\n\n'),
  instructor: 'Đội ngũ ChatQASoftware',
  access: 'open',
};

// Tài nguyên tải về. file nằm trong resources/ (hoặc build/ với PDF), đăng lên R2 dưới MEDIA_PREFIX.
export const RESOURCES = {
  handbook: { label: 'Cẩm nang PDF đầy đủ của khoá học', file: 'chatqa-cam-nang.pdf', built: true },
  checklist: { label: 'Danh sách kiểm tra trước khi bắt đầu (PDF 1 trang)', file: 'chatqa-checklist.pdf', built: true },
  setupScript: { label: 'Script PowerShell: cài app vào đúng chỗ và cài adb', file: 'cai-dat-chatqa.ps1' },
  claudeDesktop: { label: 'Mẫu claude_desktop_config.json cho Windows', file: 'claude_desktop_config.json' },
  codexToml: { label: 'Mẫu config.toml cho Codex', file: 'codex-config.toml' },
  cursorJson: { label: 'Mẫu mcp.json cho Cursor', file: 'cursor-mcp.json' },
  prompts: { label: 'Bộ câu lệnh mẫu giao việc cho AI', file: 'cau-lenh-mau.txt' },
  firstFlow: { label: 'Flow mẫu đầu tiên (Maestro YAML)', file: '01_mo_cai_dat.yaml' },
  troubleshooting: { label: 'Bảng xử lý sự cố (PDF)', file: 'chatqa-xu-ly-su-co.pdf', built: true },
};

const shot = (name, caption) => ({ type: 'screen', image: `screens/${name}.png`, caption });
const steps = (title, items, note) => ({ type: 'steps', title, items, note });
const code = (title, lang, body, note) => ({ type: 'code', title, lang, body, note });
const title = (kicker, heading, sub) => ({ type: 'title', kicker, heading, sub });
const phone = (title, items, highlight) => ({ type: 'phone', title, items, highlight });

export const MODULES = [
  {
    id: 'm1',
    title: 'Chương 1. Bắt đầu',
    lessons: [
      {
        id: 'chatqa-01-gioi-thieu',
        title: 'ChatQASoftware là gì và bạn sẽ làm được gì',
        minutes: 5,
        resources: ['handbook'],
        notes: `ChatQASoftware là app kiểm thử app chat (và app di động nói chung) trên điện thoại Android, iPhone và trình duyệt.

Bạn dùng nó để:
- Chạy flow kiểm thử trên điện thoại thật cắm vào máy tính, xem màn hình trực tiếp.
- Giữ lại ảnh chụp, video, nhật ký và báo cáo của từng lượt chạy.
- Điều khiển bằng tay trong app, hoặc giao việc cho Claude, Codex, Cursor qua MCP.
- Đặt lịch chạy tự động và nhận cảnh báo qua webhook.

Sau khoá học, trên một máy Windows mới và một điện thoại Android, bạn sẽ:
1. Có license miễn phí 1 năm và app đã kích hoạt.
2. Thấy điện thoại của mình trong app, xem được màn hình trực tiếp.
3. Nối Claude Desktop, Claude Code và Codex với app.
4. Nhờ AI viết flow đầu tiên, chạy lại và đọc báo cáo.

Gói ChatQA MCP miễn phí: license gửi qua email, gia hạn miễn phí mỗi năm, không cần thẻ. Mã nguồn mở: https://github.com/sagozen/openwork-project`,
        scenes: [
          { visual: title('Chương 1 · Bài 1', 'ChatQASoftware là gì?', 'Kiểm thử app chat trên Android, iOS và web'), say: 'Chào bạn. Đây là khoá học dùng ChatQASoftware từ con số không. Bài đầu tiên giúp bạn hiểu app này làm gì và cuối khoá bạn sẽ làm được những gì.' },
          { visual: shot('landing', 'Trang chủ chatqasoft.zhst.app'), say: 'ChatQASoftware là app kiểm thử app chat trên điện thoại Android, iPhone và trình duyệt. Bạn chạy kịch bản kiểm thử, gọi là flow, trên điện thoại thật cắm vào máy tính.' },
          { visual: shot('app-home', 'Màn làm việc chính: Thiết bị, Trò chuyện, Hoạt động, Số đo'), say: 'Mỗi lượt chạy đều giữ lại ảnh chụp, video, nhật ký và báo cáo. Bạn điều khiển bằng tay ngay trong app, hoặc giao việc cho trợ lý AI như Claude và Codex qua kết nối MCP.' },
          { visual: steps('Cuối khoá bạn sẽ có', ['License miễn phí 1 năm, app đã kích hoạt', 'Điện thoại Android hiện trong app', 'Claude Desktop, Claude Code, Codex đã nối với app', 'Flow đầu tiên do AI viết, chạy đạt, có báo cáo']), say: 'Cuối khoá, bạn sẽ có license miễn phí một năm, điện thoại hiện trong app, ba trợ lý AI đã nối với app, và flow kiểm thử đầu tiên do AI viết và chạy đạt. Mình bắt đầu nhé.' },
        ],
      },
      {
        id: 'chatqa-02-chuan-bi',
        title: 'Chuẩn bị máy tính, điện thoại và tài khoản',
        minutes: 5,
        resources: ['checklist'],
        notes: `Chuẩn bị trước khi học (in danh sách kiểm tra PDF đi kèm bài này):

Máy tính
- Windows 10 hoặc Windows 11 bản 64-bit (x64). Bản cho máy chip ARM chưa có.
- Kết nối mạng: cần khi kích hoạt, đăng nhập lần đầu và khi app tải bộ driver thiết bị lần đầu.
- Tài khoản Windows có quyền cài phần mềm cho chính mình (không cần quyền quản trị).

Điện thoại
- Một điện thoại Android, nên dùng máy test riêng, đã sạc pin.
- Cáp USB truyền dữ liệu (không phải cáp chỉ sạc). Cắm thẳng vào máy tính, tránh hub USB.

Tài khoản
- Một email bạn mở được ngay (để nhận License Key).
- Với chương MCP: tài khoản Claude (claude.ai) cho Claude Desktop và Claude Code; tài khoản ChatGPT hoặc khoá OpenAI cho Codex.

Lưu ý an toàn
- Dùng tài khoản test cho app cần kiểm thử, đừng dùng tài khoản thật.
- Không gửi License Key, mật khẩu hay token MCP cho người khác.`,
        scenes: [
          { visual: title('Chương 1 · Bài 2', 'Chuẩn bị', 'Máy tính, điện thoại, tài khoản'), say: 'Trước khi cài, mình kiểm tra nhanh ba thứ: máy tính, điện thoại và tài khoản.' },
          { visual: steps('Máy tính', ['Windows 10 hoặc 11, bản 64-bit', 'Có mạng khi kích hoạt và lần đầu chạy', 'Không cần quyền quản trị']), say: 'Máy tính dùng Windows mười hoặc mười một, bản sáu mươi tư bít. Cần có mạng lúc kích hoạt, đăng nhập lần đầu và khi app tải bộ driver thiết bị lần đầu. Bạn không cần quyền quản trị.' },
          { visual: phone('Điện thoại', ['Android, nên là máy test riêng', 'Cáp USB truyền dữ liệu', 'Cắm thẳng vào máy tính']), say: 'Điện thoại là một máy Android, tốt nhất là máy test riêng. Dùng cáp có truyền dữ liệu, không phải cáp chỉ sạc, và cắm thẳng vào máy tính.' },
          { visual: steps('Tài khoản', ['Email mở được ngay để nhận License Key', 'Tài khoản Claude cho Claude Desktop, Claude Code', 'Tài khoản ChatGPT hoặc khoá OpenAI cho Codex'], 'Không gửi License Key, mật khẩu, token cho người khác'), say: 'Cuối cùng là một email bạn mở được ngay, tài khoản Claude, và tài khoản ChatGPT nếu muốn dùng Codex. Bạn tải danh sách kiểm tra một trang ở phần tài nguyên để đánh dấu từng mục.' },
        ],
      },
    ],
  },
  {
    id: 'm2',
    title: 'Chương 2. Cài đặt trên máy Windows mới',
    lessons: [
      {
        id: 'chatqa-03-nhan-license',
        title: 'Nhận license miễn phí 1 năm',
        minutes: 6,
        resources: [],
        notes: `1. Mở https://chatqasoft.zhst.app trên trình duyệt.
2. Bấm "Nhận license 1 năm miễn phí".
3. Điền form:
   - Họ tên (bắt buộc, 2 đến 80 ký tự)
   - Email (bắt buộc, chính email bạn sẽ đăng nhập)
   - Công ty (không bắt buộc)
4. Gửi form, rồi mở hộp thư. Thư có tiêu đề bắt đầu bằng "License ChatQA" gồm:
   - License Key (mã kích hoạt máy)
   - Tên đăng nhập: chính email bạn đã nhập
   - Mật khẩu tạm: hết hạn sau 72 giờ, phải đổi ở lần đăng nhập đầu
5. Không thấy thư: xem thư mục Spam/Quảng cáo, đợi vài phút.

Ghi nhớ
- License dùng 365 ngày, tối đa 3 máy tính.
- Mỗi email nhận một lần. Gia hạn: gửi lại form bằng cùng email trong 30 ngày trước khi hết hạn hoặc sau khi hết hạn.
- Mỗi địa chỉ mạng gửi tối đa 5 yêu cầu mỗi ngày.`,
        scenes: [
          { visual: title('Chương 2 · Bài 1', 'Nhận license miễn phí', '365 ngày, tối đa 3 máy'), say: 'Bước đầu tiên là nhận license miễn phí một năm.' },
          { visual: shot('landing', 'chatqasoft.zhst.app · nút "Nhận license 1 năm miễn phí"'), say: 'Mở trang chát cu a xóp chấm z h s t chấm app, rồi bấm nút Nhận license một năm miễn phí.' , caption: 'Mở chatqasoft.zhst.app, bấm "Nhận license 1 năm miễn phí".' },
          { visual: steps('Điền form', ['Họ tên: 2 đến 80 ký tự', 'Email: chính email bạn sẽ đăng nhập', 'Công ty: có thể bỏ trống']), say: 'Điền họ tên, email và tên công ty nếu có. Email này cũng là tên đăng nhập của bạn, nên hãy dùng email bạn mở được ngay.' },
          { visual: steps('Trong hộp thư', ['License Key: để kích hoạt máy', 'Tên đăng nhập: email của bạn', 'Mật khẩu tạm: hết hạn sau 72 giờ'], 'Không thấy thư? Xem thư mục Spam'), say: 'Vài phút sau, thư gửi tới gồm License Key, tên đăng nhập và mật khẩu tạm. Mật khẩu tạm hết hạn sau bảy mươi hai giờ, nên hãy cài app và đăng nhập sớm. Không thấy thư thì xem thư mục spam.' },
          { visual: steps('Ghi nhớ', ['Dùng 365 ngày, tối đa 3 máy', 'Mỗi email nhận một lần', 'Gia hạn miễn phí: gửi lại form trong 30 ngày trước hạn']), say: 'License dùng được ba trăm sáu mươi lăm ngày trên tối đa ba máy. Khi gần hết hạn, gửi lại form bằng cùng email để gia hạn miễn phí.' },
        ],
      },
      {
        id: 'chatqa-04-tai-cai-app',
        title: 'Tải và cài ChatQASoftware, vượt cảnh báo SmartScreen',
        minutes: 8,
        resources: ['setupScript'],
        notes: `Cách 1: dùng script (khuyên dùng)
1. Trên trang chủ, bấm "Tải cho Windows". File ChatQASoftware-x.y.z.exe vào thư mục Downloads.
2. Tải script cai-dat-chatqa.ps1 ở phần tài nguyên của bài này, lưu vào Downloads.
3. Bấm phải nút Start, chọn "Terminal" (hoặc "Windows PowerShell"), dán:
   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\\Downloads\\cai-dat-chatqa.ps1"
4. Script chép app vào %LOCALAPPDATA%\\Programs\\ChatQASoftware, tạo lối tắt ngoài Desktop, cài adb và thêm vào PATH.

Cách 2: làm tay
1. Tạo thư mục: %LOCALAPPDATA%\\Programs\\ChatQASoftware (dán đường này vào thanh địa chỉ của File Explorer, tạo thư mục còn thiếu).
2. Chép file exe vừa tải vào đó, đổi tên thành ChatQASoftware.exe.
3. Bấm phải file, chọn "Gửi tới" > "Desktop (tạo lối tắt)".

Vì sao phải đặt đúng thư mục?
- App tự cập nhật (OTA) bằng cách thay file exe ngay tại chỗ, nên cần một thư mục bạn có quyền ghi.
- Claude Desktop sẽ gọi app theo đúng đường dẫn này ở chương MCP. Đừng để app trong Downloads rồi xoá nhầm.

Lần đầu mở app: Windows có thể hiện "Windows protected your PC" (SmartScreen) vì exe chưa ký chứng chỉ Authenticode.
- Bấm "More info" (Thêm thông tin) rồi "Run anyway" (Vẫn chạy).
- Chỉ làm vậy với file tải từ chatqasoft.zhst.app.

Cập nhật về sau: app tự tải bản mới. Khi thấy "Khởi động lại ngay" thì bấm để áp dụng, hoặc "Để sau" (lần mở app sau sẽ tự áp dụng).`,
        scenes: [
          { visual: title('Chương 2 · Bài 2', 'Tải và cài app', 'Đặt đúng thư mục để app tự cập nhật'), say: 'Giờ mình tải và cài app. Có một chi tiết quan trọng: đặt app vào đúng thư mục để app tự cập nhật được.' },
          { visual: shot('landing', 'Bấm "Tải cho Windows" ở thanh trên cùng'), say: 'Trên trang chủ, bấm Tải cho Uyn-đâu. File exe sẽ nằm trong thư mục Downloads.', caption: 'Trên trang chủ, bấm "Tải cho Windows". File .exe nằm trong Downloads.' },
          { visual: code('Cách nhanh: chạy script đi kèm', 'powershell', 'powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\\Downloads\\cai-dat-chatqa.ps1"', 'Script chép app vào %LOCALAPPDATA%\\Programs\\ChatQASoftware, tạo lối tắt, cài adb'), say: 'Cách nhanh nhất là chạy script đi kèm bài học. Mở Terminal, dán đúng một dòng lệnh này. Script chép app vào thư mục Programs của bạn, tạo lối tắt ngoài màn hình và cài luôn công cụ a-đê-bê cho bài sau.', caption: 'Mở Terminal, dán một dòng lệnh. Script chép app, tạo lối tắt và cài luôn adb.' },
          { visual: steps('Hoặc làm tay', ['Tạo %LOCALAPPDATA%\\Programs\\ChatQASoftware', 'Chép file exe vào, đổi tên ChatQASoftware.exe', 'Gửi tới > Desktop (tạo lối tắt)']), say: 'Nếu muốn làm tay, tạo thư mục Programs, ChatQASoftware trong AppData Local, chép file exe vào, đổi tên thành ChatQASoftware chấm exe, rồi tạo lối tắt ra Desktop.' },
          { visual: steps('Cảnh báo SmartScreen lần đầu', ['Hiện "Windows protected your PC"', 'Bấm "More info" (Thêm thông tin)', 'Bấm "Run anyway" (Vẫn chạy)'], 'Bình thường với exe chưa ký chứng chỉ. Chỉ làm với file tải từ chatqasoft.zhst.app'), say: 'Lần đầu mở, Uyn-đâu có thể báo Windows protected your PC. Đây là bình thường vì file chưa ký chứng chỉ. Bấm More info, rồi Run anyway. Chỉ làm vậy với file tải từ trang chính thức.', caption: 'Lần đầu mở có thể hiện "Windows protected your PC": bấm More info, rồi Run anyway.' },
        ],
      },
      {
        id: 'chatqa-05-kich-hoat',
        title: 'Kích hoạt máy và đăng nhập lần đầu',
        minutes: 6,
        resources: [],
        notes: `Bước 1: Kích hoạt máy
- Mở app. Màn "Kích hoạt bản quyền" hiện ra.
- Dán License Key từ email vào ô "Mã bản quyền", bấm "Kích hoạt".
- Thấy "Đã kích hoạt máy này" là xong; app tự chuyển sang đăng nhập sau 3 giây.

Bước 2: Đăng nhập
- Tên đăng nhập: email của bạn. Mật khẩu: mật khẩu tạm trong email.
- App yêu cầu đổi mật khẩu ngay. Đặt mật khẩu mới và ghi nhớ.

Lưu ý
- Kích hoạt và đăng nhập lần đầu cần mạng. Sau đó app vẫn làm việc khi mất mạng, nhưng quá 7 ngày không kết nối thì phải nối mạng lại.
- License dùng cho tối đa 3 máy. Máy thứ tư báo "Công ty đã dùng đủ 3 máy"; nhờ admin thu hồi máy không dùng ở Cài đặt > Máy & bản quyền.
- Đăng nhập sai nhiều lần sẽ bị tạm khoá. Quên mật khẩu: nhờ admin đặt lại (với license dùng thử, bạn chính là admin của công ty mình).`,
        scenes: [
          { visual: title('Chương 2 · Bài 3', 'Kích hoạt và đăng nhập', 'Hai bước, cần mạng ở lần đầu'), say: 'App đã mở. Giờ có hai bước: kích hoạt máy, rồi đăng nhập.' },
          { visual: shot('app-activate', 'Màn "Kích hoạt bản quyền": dán License Key, bấm "Kích hoạt"'), say: 'Màn Kích hoạt bản quyền hiện ra. Dán License Key trong email vào ô Mã bản quyền, rồi bấm Kích hoạt. Khi thấy Đã kích hoạt máy này, app tự chuyển sang đăng nhập sau ba giây.' },
          { visual: shot('app-login', 'Đăng nhập bằng email và mật khẩu tạm'), say: 'Đăng nhập bằng email và mật khẩu tạm trong thư. App sẽ yêu cầu bạn đổi mật khẩu ngay. Hãy đặt mật khẩu mới và ghi nhớ.' },
          { visual: steps('Ghi nhớ', ['Lần đầu cần mạng; sau đó làm việc được khi mất mạng', 'Quá 7 ngày không kết nối thì nối mạng lại', 'Tối đa 3 máy; thu hồi máy cũ ở Cài đặt > Máy & bản quyền']), say: 'Lần đầu cần có mạng. Sau đó app vẫn chạy khi mất mạng, nhưng quá bảy ngày không kết nối thì cần nối mạng lại. License dùng được trên ba máy, máy cũ không dùng thì thu hồi trong phần Cài đặt.' },
        ],
      },
      {
        id: 'chatqa-06-cai-adb',
        title: 'Cài adb (Android platform-tools)',
        minutes: 8,
        resources: ['setupScript'],
        notes: `ChatQASoftware nói chuyện với điện thoại Android qua adb (Android Debug Bridge). Thiếu adb, app báo: "Máy tính chưa có adb (Android SDK platform-tools). Cài rồi thử lại."

Đã chạy script cai-dat-chatqa.ps1 ở bài trước thì adb đã có, chỉ cần kiểm tra (bước 4).

Cài tay
1. Tải gói chính thức của Google: https://dl.google.com/android/repository/platform-tools-latest-windows.zip
2. Giải nén vào %LOCALAPPDATA%\\Android (bạn sẽ có thư mục %LOCALAPPDATA%\\Android\\platform-tools chứa adb.exe).
3. Thêm vào PATH:
   - Bấm Start, gõ "biến môi trường", chọn "Chỉnh sửa các biến môi trường cho tài khoản của bạn".
   - Chọn Path > Edit > New, dán: %LOCALAPPDATA%\\Android\\platform-tools > OK.
4. Mở cửa sổ Terminal MỚI, gõ: adb version
   Thấy "Android Debug Bridge version ..." là đạt.
5. Thoát hẳn ChatQASoftware rồi mở lại, để app đọc PATH mới.

Driver USB
- Điện thoại Pixel, đa số máy Xiaomi/OPPO: Windows 10/11 tự cài driver qua Windows Update.
- Samsung: cài "Samsung Android USB Driver for Windows" từ trang developer.samsung.com nếu adb không thấy máy.
- Máy khác: tìm "OEM USB driver" theo hãng trên developer.android.com/studio/run/oem-usb.

Lần đầu chạy flow, app tự tải bộ driver thiết bị (cần mạng một lần). Nếu báo "Chưa có bộ driver thiết bị và không tải được", hãy nối mạng rồi thử lại.`,
        scenes: [
          { visual: title('Chương 2 · Bài 4', 'Cài adb', 'Cầu nối giữa máy tính và Android'), say: 'App nói chuyện với điện thoại An-đroi qua một công cụ của Google tên là a-đê-bê. Bài này cài nó.', caption: 'App nói chuyện với Android qua công cụ adb của Google. Bài này cài nó.' },
          { visual: steps('Thiếu adb, app báo', ['"Máy tính chưa có adb (Android SDK platform-tools). Cài rồi thử lại."'], 'Đã chạy script ở bài trước? Chỉ cần kiểm tra bằng lệnh adb version'), say: 'Nếu thiếu, app sẽ báo máy tính chưa có a-đê-bê. Nếu bạn đã chạy script ở bài trước thì a-đê-bê đã có, chỉ cần kiểm tra.', caption: 'Thiếu adb, app báo "Máy tính chưa có adb". Đã chạy script ở bài trước thì chỉ cần kiểm tra.' },
          { visual: steps('Cài tay', ['Tải platform-tools-latest-windows.zip từ dl.google.com', 'Giải nén vào %LOCALAPPDATA%\\Android', 'Thêm %LOCALAPPDATA%\\Android\\platform-tools vào Path']), say: 'Cài tay gồm ba bước: tải gói platform tools chính thức của Google, giải nén vào AppData Local, Android, rồi thêm thư mục platform tools vào biến Path của tài khoản bạn.' },
          { visual: code('Kiểm tra trong Terminal mới', 'powershell', 'adb version\n# Android Debug Bridge version 1.0.41 ...', 'Sau đó thoát hẳn ChatQASoftware rồi mở lại'), say: 'Mở một cửa sổ Terminal mới, gõ a-đê-bê version. Thấy dòng Android Debug Bridge là đạt. Sau đó thoát hẳn app rồi mở lại để app nhận đường dẫn mới.', caption: 'Mở Terminal mới, gõ "adb version". Thấy "Android Debug Bridge" là đạt. Thoát hẳn app rồi mở lại.' },
          { visual: steps('Driver USB theo hãng', ['Pixel, Xiaomi, OPPO: Windows tự cài', 'Samsung: Samsung Android USB Driver', 'Hãng khác: developer.android.com/studio/run/oem-usb']), say: 'Về driver U S B: đa số máy Windows tự cài. Máy Samsung có thể cần cài thêm driver của Samsung. Các hãng khác xem danh sách driver trên trang của Android.' },
        ],
      },
    ],
  },
  {
    id: 'm3',
    title: 'Chương 3. Kết nối điện thoại Android',
    lessons: [
      {
        id: 'chatqa-07-go-loi-usb',
        title: 'Bật Tùy chọn nhà phát triển và Gỡ lỗi USB',
        minutes: 6,
        resources: [],
        notes: `Tên mục có thể khác chút theo hãng và phiên bản Android.

1. Mở Cài đặt > Giới thiệu điện thoại (About phone).
   - Samsung: Cài đặt > Thông tin điện thoại > Thông tin phần mềm.
   - Xiaomi: Cài đặt > Giới thiệu điện thoại.
2. Chạm 7 lần liên tiếp vào "Số hiệu bản tạo" (Build number). Xiaomi: chạm vào "Phiên bản MIUI/HyperOS".
   Nhập mã khoá màn hình nếu được hỏi. Thấy "Bạn đã là nhà phát triển" là xong.
3. Quay lại Cài đặt > Hệ thống > Tùy chọn nhà phát triển (Developer options).
   Samsung: mục này nằm ngay cuối Cài đặt.
4. Bật "Gỡ lỗi USB" (USB debugging), bấm OK.
5. Nên bật thêm "Không khoá màn hình khi sạc" (Stay awake): app chỉ chạy được khi màn hình đang sáng.
6. Xiaomi: bật thêm "Gỡ lỗi USB (Cài đặt bảo mật)" để app chạm được vào màn hình.

Tắt đi khi không dùng: tắt "Gỡ lỗi USB" nếu điện thoại là máy cá nhân.`,
        scenes: [
          { visual: title('Chương 3 · Bài 1', 'Bật Gỡ lỗi USB', 'Làm một lần trên mỗi điện thoại'), say: 'Để máy tính điều khiển được điện thoại, cần bật chế độ gỡ lỗi U S B. Việc này chỉ làm một lần trên mỗi điện thoại.' },
          { visual: phone('Mở Tùy chọn nhà phát triển', ['Cài đặt > Giới thiệu điện thoại', 'Chạm 7 lần vào "Số hiệu bản tạo"', 'Thấy "Bạn đã là nhà phát triển"'], 2), say: 'Mở Cài đặt, vào Giới thiệu điện thoại. Chạm bảy lần liên tiếp vào dòng Số hiệu bản tạo, nhập mã khoá màn hình nếu được hỏi. Khi thấy Bạn đã là nhà phát triển là xong. Máy Samsung nằm trong Thông tin phần mềm.' },
          { visual: phone('Bật Gỡ lỗi USB', ['Cài đặt > Hệ thống > Tùy chọn nhà phát triển', 'Bật "Gỡ lỗi USB"', 'Bật "Không khoá màn hình khi sạc"'], 1), say: 'Quay lại Cài đặt, vào Hệ thống, Tùy chọn nhà phát triển. Bật Gỡ lỗi U S B. Nên bật thêm Không khoá màn hình khi sạc, vì app chỉ chạy được khi màn hình đang sáng.' },
          { visual: steps('Lưu ý theo hãng', ['Samsung: Tùy chọn nhà phát triển nằm cuối Cài đặt', 'Xiaomi: bật thêm "Gỡ lỗi USB (Cài đặt bảo mật)"', 'Máy cá nhân: tắt Gỡ lỗi USB khi không dùng']), say: 'Với Xiaomi, bật thêm Gỡ lỗi U S B phần cài đặt bảo mật để app chạm được vào màn hình. Nếu đây là điện thoại cá nhân, nhớ tắt gỡ lỗi khi không dùng.' },
        ],
      },
      {
        id: 'chatqa-08-cam-dien-thoai',
        title: 'Cắm điện thoại, cho phép máy tính và xem màn hình trực tiếp',
        minutes: 7,
        resources: [],
        notes: `1. Mở ChatQASoftware và đăng nhập.
2. Mở khoá điện thoại, cắm cáp vào máy tính.
3. Trên điện thoại hiện "Cho phép gỡ lỗi USB?" kèm mã RSA của máy tính:
   - Tích "Luôn cho phép từ máy tính này", bấm "Cho phép".
4. Ô "Thiết bị" bên trái app hiện tên điện thoại với nhãn "Sẵn sàng".
5. Chọn máy, mở tab "Màn hình" để xem màn hình trực tiếp. Nhấn Enter để phóng to, phím T để giành quyền điều khiển (chạm, vuốt bằng chuột), T lần nữa để trả máy.

Không thấy máy?
- "chưa chấp nhận gỡ lỗi USB trên điện thoại": mở khoá điện thoại, bấm Cho phép ở hộp thoại. Không thấy hộp thoại: rút cáp cắm lại, hoặc vào Tùy chọn nhà phát triển > "Thu hồi uỷ quyền gỡ lỗi USB" rồi cắm lại.
- "adb báo offline: rút cáp cắm lại".
- Vẫn không thấy: mở Terminal, gõ "adb devices". Danh sách trống nghĩa là Windows chưa nhận máy: đổi cáp, đổi cổng, cài driver USB của hãng (bài 2.4). Chọn chế độ USB "Truyền tệp" nếu điện thoại hỏi.
- "Thiết bị chưa sẵn sàng để chạy": màn hình điện thoại đang tắt. Mở khoá, bật "Không khoá màn hình khi sạc".`,
        scenes: [
          { visual: title('Chương 3 · Bài 2', 'Cắm điện thoại', 'Cho phép máy tính, xem màn hình trực tiếp'), say: 'Giờ là lúc cắm điện thoại vào máy tính.' },
          { visual: phone('Cho phép gỡ lỗi USB?', ['Mở khoá điện thoại, cắm cáp', 'Tích "Luôn cho phép từ máy tính này"', 'Bấm "Cho phép"'], 2), say: 'Mở app và đăng nhập, mở khoá điện thoại rồi cắm cáp. Điện thoại hỏi Cho phép gỡ lỗi U S B. Tích Luôn cho phép từ máy tính này, rồi bấm Cho phép.' },
          { visual: shot('app-home', 'Ô "Thiết bị": điện thoại hiện với nhãn "Sẵn sàng"'), say: 'Trong vài giây, ô Thiết bị bên trái hiện tên điện thoại với nhãn Sẵn sàng. Vậy là máy tính đã nói chuyện được với điện thoại.' },
          { visual: { type: 'screen', image: 'screens/live-windows.png', caption: 'Tab "Màn hình": Enter phóng to, T giành quyền điều khiển' }, say: 'Mở tab Màn hình để xem màn hình điện thoại trực tiếp. Nhấn Enter để phóng to, phím T để giành quyền điều khiển, chạm và vuốt bằng chuột. Nhấn T lần nữa để trả máy.' },
          { visual: steps('Không thấy máy?', ['"chưa chấp nhận gỡ lỗi USB": bấm Cho phép trên điện thoại', '"adb báo offline": rút cáp cắm lại', '"adb devices" trống: đổi cáp, đổi cổng, cài driver', '"chưa sẵn sàng": mở khoá, giữ màn hình sáng']), say: 'Nếu không thấy máy, đọc dòng trạng thái app hiện. Chưa chấp nhận gỡ lỗi thì bấm Cho phép trên điện thoại. Báo offline thì rút cáp cắm lại. Nếu lệnh a-đê-bê devices không thấy gì, hãy đổi cáp, đổi cổng hoặc cài driver của hãng.', caption: 'Không thấy máy? Đọc trạng thái app hiện, xử lý theo bảng. "adb devices" trống thì đổi cáp, cổng hoặc cài driver.' },
        ],
      },
    ],
  },
  {
    id: 'm4',
    title: 'Chương 4. Kết nối Claude, Codex qua MCP',
    lessons: [
      {
        id: 'chatqa-09-mcp-la-gi',
        title: 'MCP là gì và 48 tool của ChatQASoftware',
        minutes: 6,
        resources: [],
        notes: `MCP (Model Context Protocol) là cách chuẩn để một trợ lý AI gọi công cụ của app khác. ChatQASoftware có sẵn một máy chủ MCP chạy ngay trong app, chỉ nhận kết nối từ chính máy tính này.

Khi nối, Claude Desktop, Claude Code, Codex hoặc Cursor làm được việc với quyền của người đang đăng nhập app:

Điều phối: tower_fleet (danh sách máy), tower_dispatch (chạy flow trên máy rảnh), tower_tasks, tower_wait_task, tower_report, tower_replay_failed, tower_device_report, tower_health, tower_alerts, tower_budget, tower_deliveries, tower_pause_all.
Thiết bị: device_ui_state (đọc chữ và toạ độ trên màn hình), device_screenshot, device_tap, device_swipe.
Trình duyệt: web_navigate, web_click, web_fill, web_select, web_press, web_wait, web_back.
Kiểm thử: test_flows, test_validate, test_save_flow (AI tự viết flow), test_compile (AI của app viết flow, tốn tiền AI), test_run, test_report, test_stop, test_repair, test_apply_repair, test_compare, test_metrics, test_set_env, test_export_spec, test_delete_flow, test_git_diff, test_save_result.
Tài liệu: docs_list, docs_get, docs_update, docs_requirements, docs_affected_cases, docs_coverage.
Đồng bộ nhóm: sync_status, sync_pull, sync_push.

Luật an toàn có sẵn
- Flow chỉ được lưu khi chạy xác nhận trên thiết bị đạt.
- Mật khẩu đặt trong app; AI chỉ thấy tên biến như \${PASSWORD}, không bao giờ thấy giá trị.
- App phải đang mở và đăng nhập; đóng app hoặc đăng xuất thì AI mất kết nối.
- ChatGPT (bản web) chưa nối được vì cần địa chỉ công khai; máy chủ MCP cố ý chỉ nghe trên máy này.`,
        scenes: [
          { visual: title('Chương 4 · Bài 1', 'MCP là gì?', 'Cho trợ lý AI dùng công cụ của app'), say: 'Chương này nối trợ lý AI với app. Trước hết, M C P là gì?', caption: 'Chương này nối trợ lý AI với app. Trước hết, MCP là gì?' },
          { visual: steps('MCP = cổng công cụ cho AI', ['Trợ lý AI (Claude, Codex, Cursor) gửi yêu cầu', 'ChatQASoftware thực hiện trên điện thoại thật', 'Kết quả, ảnh chụp, báo cáo trả về cho AI'], 'Chỉ nhận kết nối từ chính máy này, cần token'), say: 'M C P là cách chuẩn để trợ lý AI gọi công cụ của một app khác. App có sẵn máy chủ M C P bên trong, chỉ nhận kết nối từ chính máy tính này và cần token.', caption: 'MCP là cách chuẩn để trợ lý AI gọi công cụ của app khác. Máy chủ MCP nằm sẵn trong app.' },
          { visual: steps('48 tool, 6 nhóm', ['Điều phối: xem máy, chạy, chờ, báo cáo', 'Thiết bị: đọc màn hình, chụp, chạm, vuốt', 'Trình duyệt: mở trang, bấm, điền', 'Kiểm thử: viết, lưu, chạy, sửa flow', 'Tài liệu và Đồng bộ nhóm']), say: 'App có bốn mươi tám công cụ chia sáu nhóm: điều phối máy, thao tác thiết bị, điều khiển trình duyệt, viết và chạy flow, đọc tài liệu yêu cầu và đồng bộ với nhóm.' },
          { visual: steps('Luật an toàn có sẵn', ['Flow chỉ lưu khi chạy đạt trên máy thật', 'AI chỉ thấy tên biến bí mật, không thấy giá trị', 'Đóng app hoặc đăng xuất: AI mất kết nối']), say: 'App có sẵn ba luật an toàn: flow chỉ được lưu khi chạy đạt trên máy thật, AI không bao giờ thấy mật khẩu, và khi bạn đóng app hay đăng xuất thì AI mất kết nối.' },
        ],
      },
      {
        id: 'chatqa-10-bat-mcp',
        title: 'Bật MCP và giữ token an toàn',
        minutes: 5,
        resources: [],
        notes: `1. Trong app: Điều phối > Kết nối AI (MCP), hoặc bấm "Kết nối AI" ở thanh dưới cùng.
2. Bấm "Bật MCP". App hiện:
   - Địa chỉ máy chủ: http://127.0.0.1:39017/mcp
   - Token: CHỈ HIỆN MỘT LẦN. Sao chép và lưu ngay vào trình quản lý mật khẩu, rồi bấm "Đã lưu token".
   - Cấu hình dán sẵn cho Claude Code, Claude Desktop, Codex và Cursor, đã điền token và đúng đường dẫn app trên máy bạn.
3. Mất token: bấm "Cấp token mới". Token cũ hết hiệu lực ngay; dán token mới vào cấu hình các client.

An toàn
- Không gửi token cho người khác, không đưa vào git, không dán vào chat công khai.
- Ai có token và ngồi ở máy này khi bạn đang đăng nhập thì điều khiển được thiết bị với quyền của bạn.
- Không dùng nữa: bấm "Tắt MCP".`,
        scenes: [
          { visual: title('Chương 4 · Bài 2', 'Bật MCP', 'Token chỉ hiện một lần'), say: 'Bật máy chủ M C P chỉ mất một phút.', caption: 'Bật máy chủ MCP chỉ mất một phút.' },
          { visual: shot('app-mcp', 'Điều phối > Kết nối AI (MCP) > Bật MCP'), say: 'Vào Điều phối, chọn Kết nối AI, hoặc bấm nút Kết nối AI ở thanh dưới cùng. Bấm Bật M C P. App hiện địa chỉ máy chủ, token, và cấu hình dán sẵn cho từng trợ lý AI.', caption: 'Điều phối > Kết nối AI (MCP) > Bật MCP. App hiện địa chỉ, token và cấu hình dán sẵn.' },
          { visual: steps('Token chỉ hiện một lần', ['Sao chép, lưu vào trình quản lý mật khẩu', 'Bấm "Đã lưu token"', 'Mất token: "Cấp token mới" (token cũ hết hiệu lực)'], 'Không gửi token cho ai, không đưa vào git'), say: 'Token chỉ hiện đúng một lần. Sao chép và lưu ngay, rồi bấm Đã lưu token. Nếu mất, bấm Cấp token mới, token cũ hết hiệu lực ngay. Đừng gửi token cho ai.' },
        ],
      },
      {
        id: 'chatqa-11-claude-desktop',
        title: 'Kết nối Claude Desktop',
        minutes: 8,
        resources: ['claudeDesktop'],
        notes: `1. Cài Claude Desktop cho Windows: https://claude.ai/download, đăng nhập tài khoản Claude.
2. Claude Desktop > Settings > Developer > Edit Config. File cấu hình mở ra:
   %APPDATA%\\Claude\\claude_desktop_config.json
3. Trong ChatQASoftware, màn Kết nối AI (MCP), sao chép khối "Claude Desktop" (đã có token và đường dẫn app). Dạng của nó:

{
  "mcpServers": {
    "chatqa": {
      "command": "C:\\\\Users\\\\<tên bạn>\\\\AppData\\\\Local\\\\Programs\\\\ChatQASoftware\\\\ChatQASoftware.exe",
      "args": ["--mcp"],
      "env": { "CHATQA_MCP_TOKEN": "<token>" }
    }
  }
}

   - File đang có "mcpServers" khác: chỉ thêm khối "chatqa" vào trong, giữ nguyên server cũ, nhớ dấu phẩy.
   - Trong JSON, mỗi dấu \\ của đường dẫn Windows viết thành \\\\.
4. Lưu file. Thoát HẲN Claude Desktop (chuột phải biểu tượng ở khay hệ thống > Quit), rồi mở lại.
5. Bấm biểu tượng công cụ trong ô chat: thấy "chatqa" với các tool tower_*, device_*, web_*, test_*.
6. Thử: "Dùng chatqa, liệt kê các máy đang cắm." Lần đầu Claude hỏi cho phép dùng tool: chọn cho phép.

Lỗi thường gặp: không thấy chatqa thì JSON sai cú pháp (thiếu dấu phẩy, ngoặc) hoặc sai đường dẫn command. Dán nội dung file vào https://jsonlint.com để kiểm tra (xoá token trước khi dán).`,
        scenes: [
          { visual: title('Chương 4 · Bài 3', 'Claude Desktop', 'Nối bằng file cấu hình'), say: 'Bắt đầu với Clốt Đét-tóp, app trò chuyện của Anthropic trên máy tính.', caption: 'Bắt đầu với Claude Desktop, app trò chuyện của Anthropic trên máy tính.' },
          { visual: steps('Mở file cấu hình', ['Cài từ claude.ai/download, đăng nhập', 'Settings > Developer > Edit Config', '%APPDATA%\\Claude\\claude_desktop_config.json']), say: 'Cài Clốt Đét-tóp từ trang claude chấm ai, đăng nhập. Vào Settings, Developer, bấm Edit Config để mở file cấu hình.', caption: 'Cài Claude Desktop từ claude.ai/download. Vào Settings > Developer > Edit Config.' },
          { visual: code('Dán khối "Claude Desktop" từ màn Kết nối AI', 'json', '{\n  "mcpServers": {\n    "chatqa": {\n      "command": "C:\\\\Users\\\\An\\\\AppData\\\\Local\\\\Programs\\\\ChatQASoftware\\\\ChatQASoftware.exe",\n      "args": ["--mcp"],\n      "env": { "CHATQA_MCP_TOKEN": "<token>" }\n    }\n  }\n}', 'Đã có server khác? Chỉ thêm khối "chatqa", nhớ dấu phẩy'), say: 'Trong ChatQASoftware, sao chép khối Clốt Đét-tóp ở màn Kết nối AI, đã có sẵn token và đường dẫn app. Dán vào file. Nếu file đã có server khác, chỉ thêm khối chát cu a vào trong và nhớ dấu phẩy.', caption: 'Sao chép khối "Claude Desktop" ở màn Kết nối AI (đã có token, đường dẫn), dán vào file.' },
          { visual: steps('Khởi động lại và thử', ['Lưu file', 'Thoát hẳn Claude Desktop (khay hệ thống > Quit), mở lại', 'Biểu tượng công cụ có "chatqa"', 'Hỏi: "Dùng chatqa, liệt kê các máy đang cắm"']), say: 'Lưu file, thoát hẳn Clốt Đét-tóp từ khay hệ thống rồi mở lại. Trong ô chat sẽ thấy công cụ chát cu a. Thử hỏi: dùng chát cu a, liệt kê các máy đang cắm. Lần đầu, bấm cho phép dùng công cụ.', caption: 'Lưu, thoát hẳn Claude Desktop rồi mở lại. Thử: "Dùng chatqa, liệt kê các máy đang cắm".' },
        ],
      },
      {
        id: 'chatqa-12-claude-code',
        title: 'Kết nối Claude Code',
        minutes: 7,
        resources: [],
        notes: `Claude Code là trợ lý AI chạy trong Terminal, hợp để giao việc dài và tự động.

Cài trên Windows (tham khảo tài liệu chính thức https://docs.claude.com/claude-code nếu lệnh thay đổi):
1. Cài Git for Windows: https://git-scm.com/download/win (Claude Code dùng Git Bash trên Windows).
2. Mở PowerShell, chạy:
   irm https://claude.ai/install.ps1 | iex
3. Mở Terminal mới, gõ: claude  rồi đăng nhập tài khoản Claude theo hướng dẫn.

Nối với ChatQASoftware (dùng HTTP, không cần đường dẫn app). Sao chép lệnh "Claude Code" ở màn Kết nối AI, dạng:
   claude mcp add --transport http chatqa http://127.0.0.1:39017/mcp --header "Authorization: Bearer <token>"
Kiểm tra:
   claude mcp list      (thấy chatqa: connected)

Dùng
- Trong phiên Claude Code, tool có tên mcp__chatqa__<tool>.
- Đỡ bị hỏi từng lần: gõ /permissions, cho phép mcp__chatqa__*.
- Chạy không tương tác: claude -p --allowedTools "mcp__chatqa__*" "Liệt kê các máy đang cắm"
- Gỡ: claude mcp remove chatqa`,
        scenes: [
          { visual: title('Chương 4 · Bài 4', 'Claude Code', 'Trợ lý AI trong Terminal'), say: 'Tiếp theo là Clốt Cốt, trợ lý AI chạy trong cửa sổ Terminal, rất hợp để giao những việc dài.', caption: 'Tiếp theo là Claude Code, trợ lý AI chạy trong Terminal.' },
          { visual: code('Cài trên Windows', 'powershell', '# 1. Cài Git for Windows: git-scm.com/download/win\n# 2. Cài Claude Code\nirm https://claude.ai/install.ps1 | iex\n# 3. Mở Terminal mới\nclaude', 'Lệnh cài có thể đổi: xem docs.claude.com/claude-code'), say: 'Trên Uyn-đâu, cài Git trước, rồi chạy lệnh cài chính thức trong PowerShell. Mở Terminal mới, gõ claude và đăng nhập.', caption: 'Cài Git for Windows, rồi chạy lệnh cài chính thức trong PowerShell. Mở Terminal mới, gõ claude.' },
          { visual: code('Nối với ChatQASoftware', 'powershell', 'claude mcp add --transport http chatqa http://127.0.0.1:39017/mcp --header "Authorization: Bearer <token>"\nclaude mcp list   # chatqa: connected', 'Sao chép đúng lệnh này ở màn Kết nối AI (đã có token)'), say: 'Sao chép lệnh Clốt Cốt ở màn Kết nối AI, dán vào Terminal. Gõ claude mcp list, thấy chát cu a connected là xong.', caption: 'Dán lệnh "Claude Code" từ màn Kết nối AI. "claude mcp list" thấy "chatqa: connected" là xong.' },
          { visual: steps('Dùng hằng ngày', ['Tool có tên mcp__chatqa__<tool>', '/permissions: cho phép mcp__chatqa__*', 'Gỡ: claude mcp remove chatqa']), say: 'Để khỏi bị hỏi từng lần, gõ gạch chéo permissions và cho phép các công cụ của chát cu a. Muốn gỡ thì dùng lệnh claude mcp remove.', caption: 'Đỡ bị hỏi từng lần: /permissions, cho phép mcp__chatqa__*. Gỡ: claude mcp remove chatqa.' },
        ],
      },
      {
        id: 'chatqa-13-codex',
        title: 'Kết nối Codex (OpenAI)',
        minutes: 8,
        resources: ['codexToml', 'cursorJson'],
        notes: `Codex là trợ lý lập trình của OpenAI chạy trong Terminal. Token đọc từ biến môi trường, không ghi vào file.

Cài (tham khảo https://github.com/openai/codex nếu cách cài thay đổi)
1. Cài Node.js bản LTS: https://nodejs.org
2. Mở Terminal mới: npm install -g @openai/codex
3. Gõ: codex  rồi đăng nhập bằng tài khoản ChatGPT (hoặc khoá OpenAI).
   Gặp lỗi trên Windows: dùng Codex trong WSL theo hướng dẫn của OpenAI.

Nối với ChatQASoftware
1. Mở file %USERPROFILE%\\.codex\\config.toml (tạo nếu chưa có), dán khối "Codex" ở màn Kết nối AI:

[mcp_servers.chatqa]
url = "http://127.0.0.1:39017/mcp"
bearer_token_env_var = "CHATQA_MCP_TOKEN"
default_tools_approval_mode = "approve"

2. Đặt token (PowerShell):
   setx CHATQA_MCP_TOKEN "<token>"
   rồi mở Terminal MỚI. (Chỉ cho phiên hiện tại: $env:CHATQA_MCP_TOKEN = '<token>')
3. Kiểm tra: codex mcp list  (thấy chatqa)
4. Dùng: codex  rồi giao việc, hoặc không tương tác: codex exec "Liệt kê các máy đang cắm"

Vì sao cần default_tools_approval_mode = "approve"? Chế độ codex exec không có ai bấm cho phép nên chặn mọi tool có ghi (chạy flow, lưu flow, chạm), báo "approval policy is never". Trong phiên tương tác, bỏ dòng này nếu muốn Codex hỏi từng lần.

Cursor (tuỳ chọn): Cursor Settings > MCP > Add new global MCP server, dán khối "Cursor" ở màn Kết nối AI vào %USERPROFILE%\\.cursor\\mcp.json, rồi mở lại Cursor.`,
        scenes: [
          { visual: title('Chương 4 · Bài 5', 'Codex', 'Trợ lý AI của OpenAI'), say: 'Cuối cùng là Cô-đếch của OpenAI, cũng chạy trong Terminal.', caption: 'Cuối cùng là Codex của OpenAI, cũng chạy trong Terminal.' },
          { visual: code('Cài', 'powershell', '# 1. Cài Node.js LTS: nodejs.org\nnpm install -g @openai/codex\ncodex   # đăng nhập bằng tài khoản ChatGPT', 'Lỗi trên Windows: dùng Codex trong WSL theo hướng dẫn của OpenAI'), say: 'Cài Node JS bản LTS, rồi cài Cô-đếch bằng lệnh npm. Gõ codex và đăng nhập bằng tài khoản ChatGPT.', caption: 'Cài Node.js LTS, rồi "npm install -g @openai/codex". Gõ codex, đăng nhập bằng ChatGPT.' },
          { visual: code('%USERPROFILE%\\.codex\\config.toml', 'toml', '[mcp_servers.chatqa]\nurl = "http://127.0.0.1:39017/mcp"\nbearer_token_env_var = "CHATQA_MCP_TOKEN"\ndefault_tools_approval_mode = "approve"', 'Dán khối "Codex" ở màn Kết nối AI'), say: 'Mở file config chấm toml trong thư mục chấm codex của bạn, dán khối Cô-đếch từ màn Kết nối AI. Token không nằm trong file, mà đọc từ biến môi trường.', caption: 'Dán khối "Codex" vào %USERPROFILE%\\.codex\\config.toml. Token đọc từ biến môi trường.' },
          { visual: code('Đặt token và kiểm tra', 'powershell', 'setx CHATQA_MCP_TOKEN "<token>"\n# mở Terminal MỚI\ncodex mcp list\ncodex exec "Liệt kê các máy đang cắm"'), say: 'Đặt biến môi trường bằng lệnh setx, mở Terminal mới, gõ codex mcp list để thấy chát cu a. Dòng approve trong cấu hình giúp lệnh codex exec chạy được các công cụ có ghi.', caption: 'setx CHATQA_MCP_TOKEN, mở Terminal mới, "codex mcp list" thấy chatqa.' },
        ],
      },
    ],
  },
  {
    id: 'm5',
    title: 'Chương 5. Kiểm thử cùng AI',
    lessons: [
      {
        id: 'chatqa-14-flow-dau-tien',
        title: 'Nhờ AI viết và chạy flow đầu tiên',
        minutes: 10,
        resources: ['prompts', 'firstFlow'],
        notes: `Flow là kịch bản kiểm thử: điện thoại dùng Maestro YAML, trình duyệt dùng Playwright (.spec.ts). Bạn không cần tự viết: AI đọc màn hình rồi viết giúp.

+++ Bài tập (tuỳ chọn): flow mở app Cài đặt của Android
Dán câu sau vào Claude Desktop, Claude Code hoặc Codex (đổi tên máy nếu cần):

"Dùng chatqa. Xem các máy đang cắm. Trên máy Android đầu tiên, mở app Cài đặt (appId com.android.settings), đọc device_ui_state, rồi viết flow Maestro tên 01_mo_cai_dat.yaml cho app caidat: mở app, chờ màn hình Cài đặt hiện, chụp ảnh. Lưu bằng test_save_flow, sửa tối đa 2 lần nếu chưa đạt, rồi báo kết quả."

Điều sẽ xảy ra
1. AI gọi tower_fleet để xem máy, device_ui_state để đọc màn hình.
2. AI viết YAML và gọi test_save_flow. App chạy thử ngay trên điện thoại.
3. Chạy đạt thì flow được lưu ("saved"). Không đạt thì AI nhận lỗi ("failed_verification") và sửa.
4. Chạy lâu hơn 60 giây: AI nhận "running" kèm saveId và hỏi lại bằng test_save_result. Bình thường, cứ chờ.

+++

Flow mẫu tham khảo (tải ở phần tài nguyên): 01_mo_cai_dat.yaml

Luật app tự kiểm
- Flow có giá trị bí mật viết thẳng, hoặc dùng runScript/evalScript/openLink/addMedia, sẽ bị từ chối.
- Flow trùng tên chỉ bị ghi đè khi AI gửi replace: true.

Thêm câu lệnh mẫu: tải file cau-lenh-mau.txt.`,
        scenes: [
          { visual: title('Chương 5 · Bài 1', 'Flow đầu tiên', 'Để AI đọc màn hình và viết giúp'), say: 'Đến phần thú vị: nhờ AI viết và chạy flow kiểm thử đầu tiên.' },
          { visual: steps('Flow là gì?', ['Kịch bản kiểm thử: mở app, bấm, gõ, kiểm tra', 'Điện thoại: Maestro YAML', 'Trình duyệt: Playwright .spec.ts'], 'Bạn không cần tự viết: AI đọc màn hình và viết giúp'), say: 'Flow là kịch bản kiểm thử: mở app, bấm, gõ chữ và kiểm tra kết quả. Bạn không cần tự viết. AI đọc màn hình điện thoại rồi viết giúp.' },
          { visual: code('Dán vào Claude hoặc Codex', 'text', 'Dùng chatqa. Xem các máy đang cắm. Trên máy Android đầu tiên,\nmở app Cài đặt (appId com.android.settings), đọc device_ui_state,\nrồi viết flow Maestro tên 01_mo_cai_dat.yaml cho app caidat:\nmở app, chờ màn hình Cài đặt hiện, chụp ảnh.\nLưu bằng test_save_flow, sửa tối đa 2 lần nếu chưa đạt, rồi báo kết quả.'), say: 'Dán câu lệnh này vào Clốt hoặc Cô-đếch. Câu lệnh nhờ AI mở app Cài đặt, đọc màn hình, viết flow, lưu và tự sửa tối đa hai lần.', caption: 'Dán câu lệnh này vào Claude hoặc Codex: AI mở Cài đặt, đọc màn hình, viết flow, lưu và tự sửa.' },
          { visual: steps('Điều sẽ xảy ra', ['AI xem máy (tower_fleet), đọc màn hình (device_ui_state)', 'AI viết YAML, gọi test_save_flow', 'App chạy thử ngay trên điện thoại', 'Đạt: "saved". Chưa đạt: AI nhận lỗi và sửa']), say: 'AI xem danh sách máy, đọc màn hình, viết flow rồi gửi cho app. App chạy thử ngay trên điện thoại của bạn. Đạt thì flow được lưu, chưa đạt thì AI nhận lỗi và tự sửa. Nếu chạy quá sáu mươi giây, AI sẽ hỏi lại kết quả, bạn cứ chờ.' },
        ],
      },
      {
        id: 'chatqa-15-chay-va-bao-cao',
        title: 'Chạy flow trong màn Kiểm thử, đọc báo cáo và bằng chứng',
        minutes: 8,
        resources: [],
        notes: `Chạy tay
1. Mở tab "Kiểm thử" trên thanh trên cùng, tìm thẻ "Chạy flow".
2. Chọn:
   - App: caidat (app bạn vừa tạo flow)
   - Nền tảng: Android
   - Flow: để trống là chạy mọi flow của app
   - Số máy: 0 = mọi máy rảnh
   - Số lần lặp: 1 (tăng lên để đo độ ổn định)
   - Ảnh evidence: "Mọi bước", "Chỉ khi lỗi" hoặc "Không chụp"
3. Bấm "Chạy". Theo dõi ở ô "Hoạt động" và tab "Màn hình".

Đọc kết quả
- "Lượt chạy gần nhất": trạng thái đạt/lỗi từng flow, từng máy, thời gian p50/p95.
- "Mở báo cáo": trang evidence.html gồm ảnh từng bước, video, nhật ký.
- "Mở thư mục": toàn bộ file của lượt chạy trên máy bạn.
- Ô "Số đo": p50, p95, tỉ lệ đạt theo từng máy.

Chạy bằng câu lệnh
- Trong ô chat của app hoặc qua Claude/Codex: "Chạy mọi flow của app caidat trên mọi máy Android, báo p50/p95 và lỗi."
- Lỗi: "Chạy lại các flow lỗi của task gần nhất rồi tóm tắt nguyên nhân từ báo cáo."
- "Dừng tất cả": nút trong chat hoặc phím Esc từ ô chat.`,
        scenes: [
          { visual: title('Chương 5 · Bài 2', 'Chạy và đọc báo cáo', 'Mỗi lượt đều có bằng chứng'), say: 'Flow đã lưu. Giờ mình chạy lại trong màn Kiểm thử và đọc báo cáo.' },
          { visual: shot('app-kiem-thu', 'Tab "Kiểm thử": thẻ "Chạy flow", danh sách flow, lượt chạy gần nhất'), say: 'Mở tab Kiểm thử. Ở thẻ Chạy flow, chọn app, nền tảng An-đroi, số máy và số lần lặp. Chọn mức ảnh bằng chứng: mọi bước, chỉ khi lỗi, hoặc không chụp. Rồi bấm Chạy.', caption: 'Tab Kiểm thử, thẻ "Chạy flow": chọn app, nền tảng, số máy, số lần lặp, mức ảnh. Bấm "Chạy".' },
          { visual: steps('Đọc kết quả', ['"Lượt chạy gần nhất": đạt/lỗi từng máy, p50/p95', '"Mở báo cáo": ảnh từng bước, video, nhật ký', '"Mở thư mục": mọi file của lượt chạy', 'Ô "Số đo": tỉ lệ đạt theo máy']), say: 'Ở Lượt chạy gần nhất, bạn thấy đạt hay lỗi trên từng máy và thời gian chạy. Bấm Mở báo cáo để xem ảnh từng bước, video và nhật ký. Mọi file đều nằm trên máy của bạn.' },
          { visual: shot('app-home', 'Hoặc gõ lệnh trong ô chat: "chạy flow ... trên 3 máy, báo p95"'), say: 'Bạn cũng có thể gõ lệnh ngay trong ô chat, hoặc nhờ Clốt và Cô-đếch: chạy mọi flow của app trên mọi máy An-đroi, báo kết quả và lỗi.', caption: 'Hoặc gõ lệnh trong ô chat, hay nhờ Claude, Codex: "Chạy mọi flow của app caidat trên mọi máy Android".' },
        ],
      },
      {
        id: 'chatqa-16-bi-mat-lich-chay',
        title: 'Mật khẩu an toàn, biến môi trường, lịch chạy và webhook',
        minutes: 8,
        resources: [],
        notes: `Mật khẩu và dữ liệu nhạy cảm
- Đặt trong app: Cài đặt > Kiểm thử > "Biến bí mật" (chỉ admin). Ví dụ tên PASSWORD.
- Bảo AI dùng theo tên: "đăng nhập bằng biến USERNAME và mật khẩu \${PASSWORD}". Trong YAML viết \${PASSWORD}.
- AI không bao giờ thấy giá trị; kết quả và báo cáo đã che. Thiếu biến thì app báo secret_missing kèm tên còn thiếu.
- Luôn dùng tài khoản test riêng.

Biến thường (tài khoản test, app id khác nhau giữa iOS và Android): nhờ AI dùng test_set_env, ví dụ "Đặt MEXPRESS_APP_ID cho Android là com.mexpress.app".

Lịch chạy (tab "Giám sát" > "Lịch chạy")
- Điền Tên lịch, App, Flow (trống = mọi flow), Số máy, giờ chạy và các ngày trong tuần, hoặc chạy mỗi N phút.
- Lịch chỉ chạy khi ChatQASoftware đang mở và có người đăng nhập.

Webhook (tab "Giám sát" > "Webhook")
- Gửi thông báo tới Slack, Google Chat hoặc hệ thống của bạn (địa chỉ https).
- Chọn sự kiện: Task lỗi, Task xong, Cảnh báo mới. Khoá ký chỉ hiện một lần: lưu ngay.

Đánh giá ảnh hưởng thay đổi code (tab "Kiểm thử" > "Đánh giá ảnh hưởng (git-impact)")
- Nhập đường dẫn repo, commit cũ và commit mới; app xuất diff để AI lập kế hoạch test và chọn flow cần chạy. Không tốn tiền AI của app.`,
        scenes: [
          { visual: title('Chương 5 · Bài 3', 'Bí mật, lịch chạy, webhook', 'Tự động mà vẫn an toàn'), say: 'Bài này giúp bạn chạy tự động mà vẫn giữ mật khẩu an toàn.' },
          { visual: steps('Mật khẩu: AI chỉ thấy tên biến', ['Cài đặt > Kiểm thử > "Biến bí mật"', 'Bảo AI dùng ${PASSWORD}, không dán mật khẩu', 'Báo cáo tự che giá trị'], 'Luôn dùng tài khoản test riêng'), say: 'Mật khẩu đặt trong phần Biến bí mật của Cài đặt. Khi giao việc, bạn chỉ nói tên biến, ví dụ biến PASSWORD. AI không bao giờ thấy giá trị, và báo cáo tự che giá trị đó.' },
          { visual: shot('app-giam-sat', 'Tab "Giám sát": Cảnh báo, Lịch chạy, Webhook'), say: 'Tab Giám sát có Lịch chạy: đặt tên, chọn app, flow, số máy, giờ chạy và các ngày trong tuần. Lịch chỉ chạy khi app đang mở và có người đăng nhập. Phần Webhook gửi thông báo tới Slack hoặc Google Chat khi có lỗi.' },
          { visual: steps('Đánh giá ảnh hưởng code (git-impact)', ['Tab Kiểm thử > Đánh giá ảnh hưởng', 'Nhập repo, commit cũ, commit mới', 'AI lập kế hoạch test, chọn flow cần chạy']), say: 'Nếu bạn làm cùng đội phát triển, phần Đánh giá ảnh hưởng nhận đường dẫn repo và hai commit, xuất thay đổi để AI lập kế hoạch test và chọn flow nên chạy.' },
        ],
      },
    ],
  },
  {
    id: 'm6',
    title: 'Chương 6. Nâng cao và hỗ trợ',
    lessons: [
      {
        id: 'chatqa-17-doi-agent',
        title: 'Đội agent ADK và ngân sách AI',
        minutes: 6,
        resources: [],
        notes: `Ngoài Claude/Codex bên ngoài, app có đội agent riêng (Google ADK) trong khung chat: điều phối, lập kế hoạch, chạy flow, phân loại lỗi, báo cáo và sửa flow.

Bật
- Mặc định tắt. Admin bật ở Cài đặt > Agent ("Đội agent ADK").
- Khoá AI riêng (nếu có) đặt ở Cài đặt > Dịch vụ AI.
- Công ty mới có $5 dùng thử model đám mây một lần khi chưa có khoá riêng. Hết thì app báo hết credit.

Duyệt và chi phí
- Mỗi lần agent muốn dùng tool, hộp thoại hiện Tool, Tham số, Hậu quả và mức rủi ro: Chỉ đọc, Chạy trên thiết bị, Ghi dữ liệu, Nguy hiểm. Bấm "Đồng ý" hoặc "Từ chối".
- Flow tạo hoặc đổi dữ liệu cần người duyệt chọn flow được chạy.
- Ngân sách AI tháng và trần mỗi thao tác: vượt trần, app hỏi xác nhận; hết ngân sách tháng, vẫn làm tay được, chỉ Quản lý tăng được ngân sách.
- Thanh dưới cùng hiện "Ngân sách LLM còn".

ChatQA ADK Agent tính theo lượng dùng; gói ChatQA MCP (dùng Claude/Codex của bạn) miễn phí.`,
        scenes: [
          { visual: title('Chương 6 · Bài 1', 'Đội agent ADK', 'Trợ lý AI ngay trong app'), say: 'Ngoài Clốt và Cô-đếch bên ngoài, app còn có đội agent riêng ngay trong khung chat.', caption: 'Ngoài Claude và Codex bên ngoài, app có đội agent riêng ngay trong khung chat.' },
          { visual: shot('app-cai-dat-agent', 'Cài đặt > Agent: bật "Đội agent ADK"'), say: 'Đội agent mặc định tắt. Admin bật ở Cài đặt, mục Agent. Công ty mới được tặng năm đô la dùng thử model đám mây.' },
          { visual: steps('Bạn luôn là người duyệt', ['Hộp thoại: Tool, Tham số, Hậu quả, mức rủi ro', 'Chỉ đọc · Chạy trên thiết bị · Ghi dữ liệu · Nguy hiểm', 'Bấm "Đồng ý" hoặc "Từ chối"', 'Ngân sách tháng và trần mỗi thao tác']), say: 'Mỗi lần agent muốn dùng công cụ, app hiện hộp thoại ghi rõ công cụ, tham số, hậu quả và mức rủi ro. Bạn bấm Đồng ý hoặc Từ chối. App còn giữ ngân sách tháng và trần chi phí mỗi thao tác.' },
        ],
      },
      {
        id: 'chatqa-18-xu-ly-su-co',
        title: 'Xử lý sự cố thường gặp',
        minutes: 8,
        resources: ['troubleshooting'],
        notes: `Cài đặt và bản quyền
- "Windows protected your PC": More info > Run anyway (exe chưa ký chứng chỉ).
- Kích hoạt hoặc đăng nhập lần đầu báo cần mạng: nối mạng rồi thử lại.
- "Công ty đã dùng đủ 3 máy": thu hồi máy cũ ở Cài đặt > Máy & bản quyền.
- Mật khẩu tạm hết hạn (sau 72 giờ) hoặc tài khoản bị khoá: nhờ admin đặt lại.

Điện thoại
- "Máy tính chưa có adb": cài platform-tools, thêm PATH, mở lại app (bài 2.4).
- "chưa chấp nhận gỡ lỗi USB trên điện thoại": mở khoá, bấm Cho phép.
- "adb báo offline": rút cáp cắm lại.
- "adb devices" trống: đổi cáp/cổng, cài driver USB của hãng.
- "Thiết bị chưa sẵn sàng để chạy": giữ màn hình sáng, mở khoá.
- "Chưa có bộ driver thiết bị và không tải được": nối mạng một lần để app tải.

MCP
- Connection refused: app chưa mở hoặc MCP đang tắt.
- 401: token sai hoặc đã cấp token mới; dán token mới vào cấu hình.
- 403: người đang đăng nhập không phải người bật MCP, hoặc chưa ai đăng nhập.
- permission_denied: tài khoản thiếu quyền (vd chạy flow); admin cấp quyền trong Quản trị.
- confirm_required: thao tác tốn tiền vượt trần, xác nhận trên thẻ trong app.
- Codex "approval policy is never": thêm default_tools_approval_mode = "approve".
- Claude Desktop không thấy chatqa: JSON sai hoặc sai đường dẫn command; thoát hẳn rồi mở lại.
- Cổng 39017 bị chiếm: đổi cài đặt mcp.port, bật lại MCP, sửa địa chỉ trong cấu hình client.

Vẫn kẹt? Gửi email support@zhst.app kèm: phiên bản app (góc dưới phải), ảnh lỗi, các bước đã làm. Đừng gửi token hay mật khẩu. Hoặc mang câu hỏi tới buổi đào tạo trực tiếp.`,
        scenes: [
          { visual: title('Chương 6 · Bài 2', 'Xử lý sự cố', 'Đọc đúng thông báo, sửa đúng chỗ'), say: 'Bài này gom các lỗi hay gặp nhất và cách xử lý. Bạn tải bảng xử lý sự cố P D F để tra nhanh.', caption: 'Bài này gom các lỗi hay gặp nhất. Tải bảng xử lý sự cố PDF để tra nhanh.' },
          { visual: steps('Điện thoại', ['Chưa có adb: cài platform-tools, mở lại app', 'Chưa chấp nhận gỡ lỗi: bấm Cho phép', 'Offline: rút cáp cắm lại', 'Chưa sẵn sàng: giữ màn hình sáng']), say: 'Với điện thoại: thiếu a-đê-bê thì cài và mở lại app. Chưa chấp nhận gỡ lỗi thì bấm Cho phép trên điện thoại. Báo offline thì rút cáp cắm lại. Báo chưa sẵn sàng thì giữ màn hình sáng.', caption: 'Điện thoại: thiếu adb, chưa chấp nhận gỡ lỗi, offline, chưa sẵn sàng.' },
          { visual: steps('MCP', ['Connection refused: mở app, bật MCP', '401: dán token mới', '403: đăng nhập đúng người đã bật MCP', 'Codex "approval policy is never": thêm dòng approve']), say: 'Với M C P: không kết nối được thì mở app và bật M C P. Lỗi bốn không một là token sai, dán token mới. Lỗi bốn không ba là đang đăng nhập sai người. Cô-đếch báo approval policy thì thêm dòng approve vào cấu hình.', caption: 'MCP: connection refused, 401, 403, Codex "approval policy is never".' },
          { visual: steps('Vẫn kẹt?', ['Email support@zhst.app', 'Kèm phiên bản app, ảnh lỗi, các bước đã làm', 'Không gửi token, mật khẩu', 'Hoặc hỏi ở buổi đào tạo trực tiếp']), say: 'Nếu vẫn kẹt, gửi email cho đội hỗ trợ kèm phiên bản app, ảnh lỗi và các bước đã làm. Đừng gửi token hay mật khẩu. Hoặc mang câu hỏi tới buổi đào tạo trực tiếp.', caption: 'Vẫn kẹt? Email support@zhst.app kèm phiên bản, ảnh lỗi, các bước. Không gửi token.' },
        ],
      },
      {
        id: 'chatqa-19-dao-tao-truc-tiep',
        title: 'Đào tạo trực tiếp qua Zoom và bước tiếp theo',
        minutes: 3,
        resources: ['handbook'],
        notes: `Lịch đào tạo trực tiếp nằm ở mục "Buổi học trực tiếp" của lớp học này. Mỗi buổi có nút "Vào Zoom" (mở 15 phút trước giờ học), nút "Thêm vào Google Calendar" và tệp .ics để thêm vào lịch Outlook hoặc lịch điện thoại.

Chuẩn bị cho buổi học
- Cài sẵn Zoom (https://zoom.us/download) hoặc vào bằng trình duyệt.
- Mở sẵn ChatQASoftware, cắm điện thoại, ghi lại câu hỏi và ảnh lỗi nếu có.

Bước tiếp theo
- Thêm iPhone: cần máy Mac và Apple Team ID (Cài đặt > Kiểm thử).
- Kiểm thử web: cài bộ chạy trình duyệt ở Cài đặt > Kiểm thử > Trình duyệt, thêm hồ sơ trình duyệt.
- Làm việc nhóm: đồng bộ tài liệu và flow qua kho S3 ở Kiểm thử > Đồng bộ.
- Tự host: mã nguồn mở tại https://github.com/sagozen/openwork-project`,
        scenes: [
          { visual: title('Chương 6 · Bài 3', 'Đào tạo trực tiếp', 'Hỏi đáp qua Zoom'), say: 'Chúc mừng bạn đã đi hết khoá học. Bài cuối giới thiệu buổi đào tạo trực tiếp và các bước tiếp theo.' },
          { visual: steps('Buổi học trực tiếp qua Zoom', ['Lịch ở mục "Buổi học trực tiếp" trong lớp học', '"Vào Zoom" mở 15 phút trước giờ học', 'Thêm vào Google Calendar hoặc tệp .ics', 'Mở sẵn app, cắm điện thoại, ghi câu hỏi']), say: 'Lịch đào tạo trực tiếp nằm ở mục Buổi học trực tiếp ngay trong lớp học. Nút Vào Zoom mở mười lăm phút trước giờ học, và bạn thêm buổi học vào lịch chỉ với một lần bấm. Hãy mở sẵn app, cắm điện thoại và ghi sẵn câu hỏi.' },
          { visual: steps('Bước tiếp theo', ['iPhone: cần máy Mac và Apple Team ID', 'Kiểm thử web: Cài đặt > Kiểm thử > Trình duyệt', 'Làm việc nhóm: Kiểm thử > Đồng bộ', 'Tự host: github.com/sagozen/openwork-project']), say: 'Tiếp theo, bạn có thể thêm iPhone nếu có máy Mac, kiểm thử trang web, làm việc nhóm qua đồng bộ, hoặc tự host từ mã nguồn mở. Hẹn gặp bạn ở buổi học trực tiếp.' },
        ],
      },
    ],
  },
];

export const LESSONS = MODULES.flatMap((m) => m.lessons.map((l) => ({ ...l, module: m.title, moduleId: m.id })));
