# ADR-0002 — Modular monolith với PostgreSQL + PostGIS làm lõi

- **Trạng thái:** Đề xuất
- **Ngày:** 2026-11-06
- **Người quyết định:** [Người duy trì dự án]
- **Liên quan:** ADR-0001, ADR-0003, ADR-0004

## Bối cảnh

Nền tảng phải phục vụ lần lượt: danh bạ mạng lưới, luồng sự kiện đơn (đơn tồn, sản lượng ngày), màn điều hành 3D, AI report, rồi engine phân giải địa chỉ, ma trận khoảng cách và dự báo.

Ràng buộc thực tế:

- Đội rất nhỏ (một người duy trì cùng AI agent, như tài liệu nghiên cứu giả định) và người đóng góp đến dần từ cộng đồng.
- Giai đoạn đầu chạy trong hạ tầng của công ty. Sau khi mở mã (ADR-0001), bên triển khai có thể là một tỉnh hoặc một hãng nhỏ chỉ có 1–2 máy chủ.
- Quy mô cần chịu được của một hãng lớn: giả định vài triệu đơn/ngày × 8–10 sự kiện/đơn, tức khoảng 10–30 triệu sự kiện/ngày. Con số này cần đo lại khi có dữ liệu thật.
- Tài liệu nghiên cứu đã chọn PostGIS làm nguồn sự thật duy nhất, các thành phần còn lại là bản dẫn xuất dựng lại được. Nguyên tắc này đúng và cần giữ.

## Quyết định

### 1. Một ứng dụng backend chia module, một nguồn sự thật

- **Backend là một ứng dụng Python 3.12 + FastAPI**, chia module theo miền nghiệp vụ: `core.tenancy`, `core.ontology`, `geo.admin`, `geo.basemap`, `network.registry`, `ops.events`, `ops.metrics`, `twin.api`, `ai.report`. Các module sau này: `geo.resolve`, `geo.routing`, `ops.forecast`.
- **Module chỉ gọi nhau qua interface công khai của module**, không truy cập thẳng bảng của module khác. Có kiểm tra phụ thuộc trong CI (ví dụ `import-linter`).
- **PostgreSQL 17 + PostGIS là nguồn sự thật duy nhất.** Mỗi module sở hữu một schema Postgres riêng.
- **Frontend là React + TypeScript + Vite.** Bản đồ dùng MapLibre GL JS, lớp 3D vận hành dùng deck.gl (ADR-0004).
- Mã riêng của công ty nằm ngoài các module lõi, trong `connectors/` và `deployments/` (ADR-0001).

### 2. Thành phần chạy riêng: chỉ dùng phần mềm có sẵn, không tự viết service

| Thành phần | Vai trò | Khi nào thêm |
|---|---|---|
| PostgreSQL + PostGIS | Nguồn sự thật | Từ đầu |
| Keycloak | Xác thực, đa tổ chức | Từ đầu |
| Martin + PMTiles | Vector tile từ PostGIS; bản đồ nền tĩnh | Từ đầu |
| Valkey | Cache | Khi có đường xử lý cần độ trễ thấp |
| OpenSearch | Autocomplete địa chỉ | Khi làm engine địa chỉ |
| OSRM | Ma trận khoảng cách | Khi làm routing |

### 3. Dữ liệu sự kiện và tổng hợp: bắt đầu trong Postgres

- Bảng sự kiện append-only, **phân vùng theo ngày** bằng partitioning gốc của Postgres.
- Đơn tồn và sản lượng được tính vào **bảng tổng hợp**, làm mới theo chu kỳ 1–5 phút bằng `pg_cron`. Giao diện luôn hiển thị thời điểm cập nhật.
- Sự kiện vào qua **API nạp** và **outbox trong Postgres**; lấy dữ liệu từ hệ thống của hãng bằng CDC (Debezium) hoặc nạp theo lô.
- Đẩy cập nhật lên giao diện bằng WebSocket hoặc SSE từ chính backend.

### 4. Triển khai

- Docker Compose cho phát triển và triển khai một máy: `make up` dựng được toàn bộ stack.
- k3s + Helm khi cần nhiều máy.

### 5. Chọn thành phần có giấy phép mã mở

Ưu tiên thành phần theo MIT, BSD, Apache-2.0, MPL-2.0 hoặc PostgreSQL License, để khi mở mã (ADR-0001) không phải thay công nghệ. Thành phần chạy như dịch vụ riêng, không nhúng vào mã (ví dụ Grafana), không bị ràng buộc này. Tránh các giấy phép "source-available" như BSL, SSPL, ELv2 cho phần lõi.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Vì sao bỏ |
|---|---|---|---|
| Microservices ngay từ đầu | Tách đội, tách tải | Chi phí vận hành, gỡ lỗi phân tán, hợp đồng giữa service — quá nặng cho một đội nhỏ; bên triển khai nhỏ không chạy nổi | Chưa có nhu cầu đo được |
| Theo đúng sơ đồ của tài liệu nghiên cứu (API Gateway + 3 service geocode/autocomplete/matrix) | Đã thiết kế sẵn | Chỉ phục vụ phân giải địa chỉ; không có chỗ cho danh bạ, sự kiện, 3D | Phải đập lại khi thêm ứng dụng logistics |
| Go cho backend | Hiệu năng, một file chạy | Hệ sinh thái GIS, ML và xử lý tiếng Việt yếu hơn; pipeline AI vẫn phải viết Python, thành hai ngôn ngữ | Phần nặng nằm ở Postgres và tile server, không ở tầng API |
| Kafka làm xương sống sự kiện | Chuẩn công nghiệp, phát lại tốt | Vận hành nặng cho đội nhỏ | Chưa cần ở quy mô hiện tại |
| Redpanda | Nhẹ hơn Kafka | Giấy phép BSL, không phải mã mở | Phải thay khi mở mã (mục 5) |
| TimescaleDB | Nén, continuous aggregates tiện | Các tính năng đó theo Timescale License, không phải giấy phép mã mở; khó dùng khi mở mã (mục 5) | Partitioning gốc đủ cho giai đoạn đầu |
| Neo4j cho quan hệ | Truy vấn đồ thị mạnh | Thêm một nguồn sự thật; GPLv3/thương mại | Dùng Apache AGE trong Postgres khi cần (ADR-0003) |
| Redis | Phổ biến | Đã đổi giấy phép từ 2024 | Dùng Valkey, tương thích giao thức |

## Hệ quả

**Tích cực**
- Một máy chạy được toàn bộ cho bên triển khai nhỏ; người mới đóng góp chỉ cần biết Python, SQL và React.
- Một nguồn sự thật; mọi chỉ mục, tile, bảng tổng hợp đều xoá đi dựng lại được.
- Ranh giới module rõ nên tách service sau này không phải viết lại.

**Đánh đổi**
- Phân tích dài hạn trên hàng tỉ sự kiện sẽ chậm trong Postgres.
- Một module lỗi nặng có thể ảnh hưởng cả ứng dụng; cần giới hạn tài nguyên và timeout trong từng module.
- Kỷ luật ranh giới module phải được CI giữ, không dựa vào ý thức.

## Khi nào xem lại

| Tín hiệu đo được | Hành động |
|---|---|
| Truy vấn phân tích nhiều tháng chậm quá ngưỡng chấp nhận, hoặc sự kiện vượt vài tỉ dòng | Thêm **ClickHouse** (Apache-2.0) làm kho phân tích; Postgres vẫn là nguồn sự thật |
| Nhiều nguồn đẩy sự kiện liên tục, outbox Postgres quá tải hoặc cần phát lại theo luồng | Chuyển sang **NATS JetStream** |
| `ops.events` hoặc `geo.resolve` cần mở rộng hoặc phát hành độc lập với phần còn lại | Tách module đó thành service riêng |
| Màn 3D cần toà nhà, địa hình thật | Thêm CesiumJS cho tầng đô thị, giữ deck.gl cho tầng vận hành |
