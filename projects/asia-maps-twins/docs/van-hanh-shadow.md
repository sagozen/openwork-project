# Vận hành shadow: chạy base song song với Google trước khi chuyển hẳn

Mục tiêu của giai đoạn shadow: base nhận cùng yêu cầu với hệ thống thật nhưng **không ảnh hưởng người dùng**, ghi lại mọi kết quả để đo, rồi mới tăng dần lưu lượng thật (1% → 10% → 100%). Lộ trình theo tài liệu nghiên cứu (`Proposal01` mục 6.3).

## Chuẩn bị

| Việc | Lệnh / cấu hình |
|---|---|
| Dựng toàn bộ stack (API, PostGIS, Valhalla, OSRM) | Xem [huong-dan-base.md](huong-dan-base.md), sau đó `make up` |
| Cấp key cho từng hệ thống gọi | `BDS_API_KEYS="oms:AIza...,app:AIza...,web:AIza..."` (tên hệ thống xuất hiện trong log và metric) |
| Giới hạn tốc độ mỗi hệ thống | `BDS_RATE_LIMIT_RPS=100` (mặc định; 0 = không giới hạn) |
| Xe máy là mặc định khi `mode=driving` | `BDS_GOOGLE_DRIVING_VEHICLE=motorbike` (tuỳ chọn) |
| Sao lưu log mỗi ngày | `make backup` (giữ 14 bản trong `data/backup/`) |
| Dọn log quá 180 ngày | `make ops-retention` |
| Giám sát | Prometheus đọc `http://<host>:8800/metrics` |

Đặt `make backup` và `make ops-retention` vào cron (ví dụ 01:30 hằng ngày).

## Ba cách đưa lưu lượng vào base

### A. OMS gửi bản sao yêu cầu (khuyến nghị)

Sau khi đã nhận kết quả từ Google như hiện nay, OMS gửi thêm một yêu cầu tới base theo kiểu "gửi rồi quên", không chờ kết quả:

```
GET /maps/api/geocode/json?address=<địa chỉ>&key=<key OMS>&order_id=<mã đơn>
    &ref_lat=<lat Google>&ref_lng=<lng Google>&ref_type=<location_type Google>
```

- `order_id`: bắt buộc trong shadow. Đây là cầu nối để sau này đối chiếu với GPS phát thành công; có thể gửi qua header `X-Order-Id`.
- `ref_lat`, `ref_lng`, `ref_type`: kết quả của Google cho cùng địa chỉ. Base **chỉ lưu khoảng cách** giữa hai kết quả, không lưu toạ độ của Google (điều khoản của Google cấm lưu kết quả quá 30 ngày và cấm dựng CSDL từ kết quả của họ).
- Gửi kèm `X-Request-Id` nếu OMS muốn tra lại một yêu cầu cụ thể; base trả lại header này trong mọi phản hồi.

Gợi ý địa chỉ làm tương tự với `/maps/api/place/autocomplete/json` (kèm `sessiontoken`), và `/maps/api/place/details/json` khi người dùng chọn. Nhờ vậy base đo được tỉ lệ mục được chọn nằm trong top-3.

### B. Phát lại dữ liệu lịch sử (khi OMS chưa sửa được)

Xuất địa chỉ lịch sử ra CSV (UTF-8, có dòng tiêu đề) rồi chạy:

```bash
make shadow-replay FILE=dia-chi.csv OUT=ket-qua.csv
```

| Cột | Bắt buộc | Ý nghĩa |
|---|---|---|
| `address` | có | Địa chỉ khách nhập |
| `order_id` | không | Mã đơn |
| `ref_lat`, `ref_lng` | không | Kết quả nguồn tham chiếu (vd. Google), chỉ để tính khoảng cách |
| `truth_lat`, `truth_lng` | không | Toạ độ đúng (GPS phát thành công). Có cột này thì công cụ in luôn độ chính xác @50m/@200m/@500m, tức là **chạy golden set** |

Không đưa tên, số điện thoại người nhận vào file. Số điện thoại lẫn trong chuỗi địa chỉ được tự che thành `[SĐT]` trước khi ghi log.

### C. Chuyển dần lưu lượng thật

Khi số đo shadow đạt điều kiện (mục dưới), OMS đổi host của một phần yêu cầu sang base: 1% → 10% → 100% tỉnh pilot. Giữ cấu hình để quay về Google trong 1 phút nếu số tụt.

## Đọc kết quả

```bash
make shadow-report DAYS=7
```

| Mục trong báo cáo | Dùng để |
|---|---|
| Lưu lượng theo hệ thống gọi | Kiểm tra OMS/app đã gửi đủ; độ trễ p50/p95 |
| Phân giải theo mức | Tỉ lệ ROOFTOP / RANGE / STREET / PLACE / tâm xã |
| Theo hợp đồng độ tin cậy | Bao nhiêu đơn tự gán được (≥ 0,7), cần xác nhận (0,5–0,69), phải hỏi lại (< 0,5) |
| So sánh shadow | Khoảng cách trung vị tới Google, tỉ lệ trong 50 m / 200 m, tỉ lệ lệch quá 1 km |
| Gợi ý: vị trí mục được chọn | Tỉ lệ người dùng chọn mục trong top-3 và top-1 |
| Khoảng cách: tỉ lệ dự phòng | Số ô ma trận / tuyến phải ước lượng vì engine không trả kết quả |

Lưu ý khi đọc "So sánh shadow": lệch Google **không có nghĩa là base sai**, vì Google cũng sai ở ngõ/hẻm/thôn. Thước đo đúng là khoảng cách tới GPS phát thành công. Ngay khi có quyền đọc log quét phát, đối chiếu `ops.geocode_log.order_id` với GPS phát để có độ chính xác thật.

## Điều kiện đề xuất để chuyển từ shadow sang lưu lượng thật

| Chỉ số | Ngưỡng đề xuất |
|---|---|
| Độ trễ phân giải p95 | < 150 ms |
| Tỉ lệ `NOT_FOUND` | < 2% |
| Tỉ lệ ≥ 0,7 độ tin cậy (tự gán được) | Không thấp hơn tỉ lệ đơn đang tự gán được với Google |
| Tỉ lệ lệch Google > 1 km | < 5%, và đã xem tay một mẫu các ca lệch |
| Gợi ý top-3 | ≥ 75% |

Người duy trì chốt lại các ngưỡng này cùng đội vận hành trước khi bật lưu lượng thật.

## Metric Prometheus

| Metric | Ý nghĩa |
|---|---|
| `bds_requests_total{endpoint, client, status}` | Số yêu cầu; `status` là trạng thái kiểu Google (`OK`, `ZERO_RESULTS`...) hoặc mã HTTP |
| `bds_request_latency_seconds{endpoint}` | Phân bố độ trễ |
| `bds_geocode_level_total{level}` | Kết quả phân giải theo mức |
| `bds_routing_fallback_total{kind}` | Số giá trị khoảng cách phải ước lượng |
| `bds_rate_limited_total{client}` | Số yêu cầu bị chặn vì vượt giới hạn |
| `bds_log_dropped_total{reason}` | Số bản ghi log bị bỏ (hàng đợi đầy hoặc DB lỗi); khác 0 là cần xem ngay |

Container API chạy 4 worker; metric được gộp qua `PROMETHEUS_MULTIPROC_DIR` nên đọc `/metrics` lần nào cũng ra tổng của cả 4.

## Dữ liệu vận hành và bảo vệ dữ liệu cá nhân

- Log nằm ở schema `ops`, tách khỏi schema `geo` (dữ liệu dẫn xuất). `make import` không bao giờ chạm vào `ops`.
- Không lưu tên, số điện thoại. Số điện thoại lẫn trong địa chỉ được che trước khi ghi.
- Địa chỉ và toạ độ vẫn là dữ liệu cá nhân (NĐ 13/2023): chỉ người vận hành base đọc được schema `ops`; không xuất ra ngoài.
