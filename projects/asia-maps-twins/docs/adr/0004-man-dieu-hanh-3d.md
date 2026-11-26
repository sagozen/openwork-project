# ADR-0004 — Màn điều hành 3D cho HO: MapLibre GL JS + deck.gl

- **Trạng thái:** Chấp nhận về công nghệ (PoC 2026-11-06); còn chờ đo trên máy HO và thử với người dùng
- **Ngày:** 2026-11-06
- **Người quyết định:** [Người duy trì dự án]
- **Liên quan:** ADR-0001, ADR-0002, ADR-0003

## Bối cảnh

HO cần điều hành mạng lưới bằng hình ảnh trực quan thay cho bảng số thô: nhìn một màn hình là thấy bưu cục nào đang tồn nhiều, tồn lâu, sản lượng dồn về đâu, luồng trung chuyển nào đang nghẽn.

Yêu cầu chính:

- Hiển thị toàn quốc khoảng 10.000–20.000 điểm mạng lưới (bưu cục, đại lý, hub) cùng lúc, mượt trên laptop văn phòng và màn hình lớn phòng điều hành.
- Ba chiều có nghĩa: chiều cao và màu thể hiện số liệu, không chỉ để trang trí.
- Đi từ toàn quốc xuống tỉnh, xuống từng bưu cục, rồi xuống danh sách đơn tồn.
- Phát lại diễn biến theo thời gian (trong ngày, so sánh cùng kỳ).
- Dữ liệu cập nhật mỗi 1–5 phút từ bảng tổng hợp (ADR-0002).
- Chạy trên trình duyệt, không cài phần mềm; dùng thành phần mã mở để mở mã sau này (ADR-0001).

## Quyết định

### 1. Công nghệ

| Lớp | Công nghệ |
|---|---|
| Bản đồ nền, camera nghiêng/xoay 3D | **MapLibre GL JS** |
| Lớp dữ liệu 3D vận hành | **deck.gl**, chạy chung với MapLibre (interleaved) |
| Bản đồ nền | **PMTiles** dựng từ dữ liệu OSM (bộ Protomaps), tự host; lớp ranh giới hành chính lấy từ dữ liệu 2 cấp trong ontology |
| Lớp động từ PostGIS (vùng phục vụ, ranh giới xã) | **Martin** phục vụ vector tile |
| Ứng dụng | React + TypeScript + Vite (ADR-0002) |

### 2. Các lớp hiển thị của bản v1

| Lớp deck.gl | Hiển thị | Ý nghĩa vận hành |
|---|---|---|
| `ColumnLayer` | Mỗi bưu cục một cột: cao = số đơn tồn, màu = tỉ lệ tồn quá 48h | Phát hiện điểm ùn tắc |
| `H3HexagonLayer` | Lưới lục giác sản lượng ngày (vào / ra / phát thành công) | Thấy vùng sản lượng dồn |
| `ArcLayer` | Cung trung chuyển hub ↔ hub, độ dày = số đơn | Thấy luồng nghẽn |
| `ScatterplotLayer` | Bưu cục không gửi dữ liệu, cảnh báo đang mở | Biết chỗ nào "mù" |
| `TripsLayer` | Phát lại hành trình xe tải trung chuyển | Để sau v1, khi có dữ liệu GPS xe |

### 3. Ba tầng điều hướng

1. **Toàn quốc:** cột và lưới H3, bảng xếp hạng 10 bưu cục tồn nhiều nhất bên cạnh.
2. **Tỉnh:** zoom vào, hiện ranh giới xã và vùng phục vụ, xu hướng 7 và 30 ngày.
3. **Bưu cục:** bảng chi tiết đơn tồn theo tuổi, sự kiện gần nhất, liên kết sang hệ thống tác nghiệp của công ty.

Mỗi màn 3D luôn có **bảng 2D đi kèm** chứa cùng số liệu. 3D giúp nhìn nhanh, bảng giúp hành động và kiểm tra.

### 4. Luồng dữ liệu

- Khi mở màn hình, backend trả một **ảnh chụp** số liệu của mọi điểm (đơn tồn, tuổi tồn, sản lượng ngày) ở dạng gọn (Apache Arrow hoặc JSON nén), đọc từ bảng tổng hợp.
- Sau đó backend đẩy **phần thay đổi** qua WebSocket hoặc SSE mỗi lần bảng tổng hợp làm mới.
- Thanh thời gian đọc bảng tổng hợp theo giờ để phát lại; không đọc bảng sự kiện thô.
- Số liệu lấy từ định nghĩa chỉ số chung trong `ops.metrics` (ADR-0003), nên luôn khớp với API và AI report.
- Mọi màn hình hiển thị "cập nhật lúc …".

### 5. Mục tiêu hiệu năng

| Chỉ tiêu | Mục tiêu |
|---|---|
| Thời gian mở màn hình toàn quốc | < 3 giây trên mạng nội bộ |
| Tốc độ khung hình khi xoay/zoom với 20.000 cột + lưới H3 độ phân giải 7 | ≥ 30 fps trên laptop văn phòng có GPU tích hợp, ≥ 60 fps trên máy phòng điều hành |
| Độ trễ từ lúc bảng tổng hợp làm mới đến lúc màn hình đổi | < 10 giây |

### 6. Lộ trình trưởng thành của digital twin

| Mức | Nội dung | Thuộc phase |
|---|---|---|
| 1. Phản ánh | Trạng thái hiện tại của mạng lưới (bản v1) | 3 |
| 2. Chẩn đoán | Vì sao tồn: lý do thất bại, thiếu bưu tá, hàng dồn từ hub nào | 3–4 |
| 3. Dự báo | Đơn tồn ngày mai theo bưu cục | 6 |
| 4. Đề xuất | Gợi ý điều chuyển nhân lực, xe, tuyến | 6 |

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Vì sao không chọn cho v1 |
|---|---|---|---|
| **CesiumJS** + 3D Tiles | Quả địa cầu, địa hình, toà nhà 3D thật | Nặng hơn nhiều; thế mạnh là hình học đô thị, không phải lớp số liệu dày | Để dành cho tầng đô thị khi cần (xem "Khi nào xem lại") |
| **Kepler.gl** | Dựng nhanh, xây trên deck.gl | Công cụ khám phá dữ liệu, khó tuỳ biến thành ứng dụng điều hành có phân quyền và drill-down | Dùng được cho analyst phân tích ad-hoc, không làm màn điều hành |
| **Three.js / react-three-fiber** | Tự do hoàn toàn | Phải tự làm bản đồ, chiếu toạ độ, tile | Hợp cho twin bên trong trung tâm khai thác, không hợp tầng bản đồ |
| **Unity / Unreal** | Hình ảnh đẹp nhất | Cài đặt nặng, khó chạy trên web, giấy phép thương mại | Không hợp nền web và mở mã sau |
| **Mapbox GL JS** | Tài liệu tốt | Giấy phép thương mại từ v2, tính phí theo lượt tải | MapLibre là bản mở tương đương |
| **Dashboard 2D (Grafana geomap, Superset)** | Có ngay trong vài ngày | Không có 3D, khó tạo cảm giác "điều hành" | Có thể dùng làm bản tạm trong lúc làm v1 |

## Hệ quả

**Tích cực**
- Vẽ hàng chục nghìn đối tượng bằng GPU trên trình duyệt, không cài đặt.
- Toàn bộ thành phần là mã mở, tự host được, không phí theo lượt dùng.
- Cùng một bộ lớp dùng được cho màn hình lớn phòng điều hành và laptop.

**Đánh đổi**
- Cần người làm frontend có kinh nghiệm WebGL/deck.gl ở mức cơ bản.
- Không có địa hình hay toà nhà 3D thật trong v1.
- Phải tự dựng và cập nhật bản đồ nền PMTiles theo chu kỳ.

## Kiểm chứng

Trước khi chuyển trạng thái sang "Chấp nhận", làm PoC:

1. 20.000 điểm với 30 ngày số liệu mô phỏng theo giờ, đủ bốn lớp ở mục 2 (trừ `TripsLayer`).
2. Đo tốc độ khung hình trên đúng loại laptop HO đang dùng và trên máy phòng điều hành.
3. Đo thời gian mở màn hình và độ trễ đẩy cập nhật qua WebSocket.
4. Cho 2–3 người ở HO dùng thử và đo thời gian tìm ra bưu cục đang ùn tắc, so với cách đang làm hiện nay.

**Kết quả (2026-11-06):** bước 1 và 3 đạt. Mở màn hình mất 0,7 giây (2,6 giây ở 4 Mbps); từ lúc đẩy số liệu đến lúc vẽ xong mất 22–52 ms. Bước 2 mới đo trên Apple M1 Pro: thời gian vẽ thật p95 là 7–8 ms, tức khoảng 120–140 fps. Khi không có GPU, mỗi khung mất khoảng 0,5 giây, nên bản thật phải tự chuyển sang chế độ 2D. Bước 4 chưa làm. Chi tiết trong báo cáo PoC.

Bổ sung vào quyết định sau PoC:

- Bán kính cột thay đổi theo mức zoom; bán kính cố định thì cột không nhìn thấy được ở mức toàn quốc.
- Đo hiệu năng bằng *thời gian vẽ thật* của mỗi khung, không dùng nhịp `requestAnimationFrame`.
- Phát hiện máy không có tăng tốc đồ hoạ và chuyển sang chế độ 2D.

## Khi nào xem lại

- HO cần điều hành ở mức khu phố hoặc toà nhà (địa hình, toà nhà 3D): thêm CesiumJS cho tầng đô thị, giữ deck.gl cho tầng vận hành.
- Cần twin bên trong trung tâm khai thác (băng chuyền, vị trí kệ): thêm một màn Three.js riêng.
- PoC không đạt mục tiêu khung hình trên laptop HO: giảm độ phân giải H3 ở tầng toàn quốc, gộp cột theo cụm, hoặc chỉ bật 3D trên máy phòng điều hành.
