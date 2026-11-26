# ChatQASoftware brand

Đơn giản, cùng họ với HS Desk: dùng chung khung, font và token của `@desk/ui-shell`, khoác bộ màu Viettel (đỏ `#EE0033`/`#E4002B` + navy `#0A1F44`) và biểu tượng riêng.

## Tên

| Dùng ở đâu | Giá trị |
|---|---|
| Tên hiển thị (UI, cửa sổ, installer) | ChatQASoftware (viết liền, giữ nguyên trong giao diện tiếng Việt) |
| Viết tắt (badge, chỗ hẹp; tiền tố mã app và quyền `cqs.*`) | CQS |
| Product code (contracts, license, release) | `chatqa` |
| Exe Windows / app macOS | `ChatQASoftware.exe` / `ChatQASoftware.app` |
| Thư mục dữ liệu | `ChatQASoftware` |
| Đường dẫn PWA | `/qa/` |
| Câu mô tả | "Gõ một câu, máy test chạy, kết quả hiện thành thẻ." |

## Biểu tượng

Một khung chat có dấu tick bên trong: chat là cách điều khiển, tick là kết quả kiểm thử.

| File | Dùng cho |
|---|---|
| `logo-mark.svg` | Biểu tượng trên nền sáng (header, trang đăng nhập) |
| `logo-lockup.svg`, `logo-lockup-dark.svg` | Biểu tượng kèm chữ, nền sáng và nền tối |
| `app-icon.svg` | Nguồn của icon app (ô navy bo góc 112/512, giống bố cục icon HS Desk) |
| `app-icon-1024.png` | Wails `build/appicon.png` (macOS và nguồn Windows) |
| `icon.ico` | Wails `build/windows/icon.ico` (16 đến 256 px) |
| `app-icon-512.png`, `app-icon-192.png` | Icon PWA trong manifest |
| `app-icon-32.png` | Favicon |

Quy tắc: không đổi màu biểu tượng ngoài hai bộ màu dưới đây, không thêm bóng hay gradient, chừa khoảng trống quanh biểu tượng ít nhất bằng 1/4 chiều rộng của nó. Chữ trong lockup dùng font Be Vietnam Pro; nếu cần file không phụ thuộc font (in ấn), chuyển chữ thành path trước khi dùng.

## Màu

ChatQASoftware ghi đè bộ token màu của ui-shell để khoác nhận diện Viettel; HS Desk giữ nguyên giao diện gốc. Các màu trạng thái (xanh lá/vàng/đỏ) và tím cho AI vẫn giữ nghĩa cũ.

| Token | HS Desk | ChatQASoftware | Ghi chú |
|---|---|---|---|
| `--color-accent` | `#E0592A` | `#E4002B` | Đỏ Viettel (PMS 185C). Chữ trắng trên nền này đạt 4.85:1 (AA) |
| `--color-accent-soft` | `#FDEEE7` | `#FFE9ED` | Nền nhạt cho chip, hàng được chọn |
| `--color-accent-ink` | `orange-700` của Tailwind | `#E4002B` (= `--color-accent`) | Chữ nhỏ mang màu nhấn, vd dòng trên tiêu đề trang |
| `--color-chrome` | `#0E1014` | `#E4002B` | Thanh tiêu đề đỏ Viettel, có gradient nhẹ và dải đỏ đậm dưới chân |
| `--color-sidebar` | `#14161B` | `#0B2244` | Navy Viettel cho sidebar |
| `--color-red` | `#C62828` | `#B42318` | Đỏ lỗi (gạch nung), tách khỏi đỏ thương hiệu |
| (chỉ dùng cho logo) | | `#EE0033` | Đỏ thương hiệu Viettel, dùng trong logo và dải nhấn |

Đỏ thương hiệu dùng cho thanh tiêu đề, nút, liên kết, tab đang mở. Đỏ lỗi (`--color-red`) hạ xuống `#B42318` để màn kiểm thử không lẫn pass/fail với màu nhấn. Logo thích ứng: nền sáng là khung chat đỏ + tick trắng; nền tối là khung chat trắng + tick đỏ.

## Chữ

Giữ font của ui-shell: Be Vietnam Pro cho giao diện, JetBrains Mono cho YAML, log và số liệu.
