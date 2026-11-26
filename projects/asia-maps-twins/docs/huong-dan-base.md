# Hướng dẫn base: gợi ý địa chỉ · phân giải địa chỉ · khoảng cách thực tế

Base cung cấp ba API. Kiến trúc và lý do chọn engine: [ADR-0005](adr/0005-engine-ba-nang-luc-loi.md). Kế hoạch: plan.

## Thành phần

| Thành phần | Vai trò | Cổng |
|---|---|---|
| API (FastAPI, `core/bds`, container `bds-api`) | Ba năng lực lõi, log vận hành, metric `/metrics` | 8800 |
| PostGIS 17 | Đơn vị hành chính, đường, địa chỉ, địa danh, bảng gợi ý (schema `geo`) | 55433 |
| Valhalla | Tuyến đường (ô tô, xe máy `motor_scooter`, xe tải) | 8002 |
| OSRM (MLD) | Ma trận khoảng cách (nhanh) | 5005 |

Mã nguồn chia theo ADR-0001: `core/` là phần chung (sẽ mở mã), `connectors/` và `deployments/` dành cho phần riêng của công ty.

## Dựng nhanh một lệnh

```bash
make bootstrap
```

Lệnh tự tải dữ liệu, dựng OSRM/Valhalla, nạp dữ liệu và kiểm tra nhanh; chạy lại nhiều lần được. Xong thì mở trang demo `http://127.0.0.1:8800/demo`. Kịch bản quay video: [demo-video.md](demo-video.md). Demo ontology: `make ontology-demo`.

## Dựng từ đầu (từng bước)

Cần Docker, `uv`, và khoảng 16 GB RAM cho Docker (bước dựng OSRM dùng tới khoảng 12 GB).

```bash
mkdir -p data/osm && curl -L -o data/osm/vietnam-latest.osm.pbf https://download.geofabrik.de/asia/vietnam-latest.osm.pbf
```

```bash
uv sync
```

```bash
make osrm-build
```

```bash
make up
```

```bash
make valhalla-config
```

```bash
make import
```

```bash
make api
```

Hoặc chạy API trong container cùng các service khác: `make docker-build` rồi `make up`.

Thời gian tham khảo trên MacBook M1 Pro: Valhalla tự dựng tile khoảng 4 phút; `make import` khoảng 2 phút (đọc OSM 72 giây, dựng bảng gợi ý 31 giây); `make osrm-build` khoảng 10 phút.

Số đo vòng 1 (MacBook M1 Pro, toàn quốc): gợi ý p95 33 ms; phân giải p95 26 ms, 72% địa chỉ OSM để dành nằm trong 200 m; tuyến đường xe máy p50 37 ms; ma trận 100×100 khoảng 0,3 giây cho cả ba loại xe.

`make valhalla-config` nâng giới hạn của Valhalla (mặc định ma trận tối đa 2.500 cặp, xe máy tối đa 500 km); chạy sau lần khởi động Valhalla đầu tiên.

## Kiểm thử và đo

```bash
make test-unit
```

```bash
make test
```

```bash
make eval
```

- `test-unit`: không cần dịch vụ nào.
- `test`: thêm test tích hợp; tự bỏ qua nếu PostGIS, Valhalla hoặc OSRM chưa chạy.
- `eval`: đo độ chính xác phân giải trên địa chỉ OSM để dành (20% điểm có số nhà, resolver không được dùng); kết quả ghi vào `data/eval/`. Chạy trước và sau mỗi lần sửa resolver.

## Hiểu địa chỉ nhiều tầng và tự học

Thiết kế: [ADR-0007](adr/0007-hieu-dia-chi-nhieu-tang-tu-hoc.md). Năm tầng: luật → cache → tagger học máy (CRF) → mô hình quyết định (xác suất đã hiệu chỉnh) → LLM chạy ngoài luồng.

```bash
make learn
```

Vòng học (khoảng 3 phút) sinh dữ liệu huấn luyện từ OSM và danh mục hành chính, huấn luyện tagger và mô hình quyết định, so với phiên bản đang dùng, và chỉ đưa vào dùng khi không kém hơn. API tự nạp phiên bản mới trong vòng 60 giây. Đặt lệnh này vào cron hằng đêm.

LLM (tuỳ chọn, tự host): đặt `BDS_LLM_URL` (ví dụ `http://127.0.0.1:11434` cho Ollama) và `BDS_LLM_MODEL` (ví dụ `qwen2.5:7b`). Vòng học sẽ gửi các địa chỉ khó trong log 7 ngày (đã che số điện thoại) cho LLM gán nhãn. Nhãn chỉ được nhận khi mọi giá trị là đoạn có thật trong địa chỉ; nếu tagger đang chắc mà bất đồng thì nhãn vào hàng chờ người duyệt (`ml.label`, `status = 'review'`).

- `GET /v1/geocode/explain?address=`: kết quả kèm từng tầng (chuẩn hoá, hành chính, nhãn tagger, các ứng viên và xác suất).
- `GET /v1/ml/status`: mô hình đang dùng, số đo, nhãn theo nguồn, cache.

## Xác thực và log

Khi đặt `BDS_API_KEYS="oms:AIza...,app:AIza..."`, mọi lời gọi phải có key (API gốc: header `X-API-Key`; API tương thích Google: tham số `key`). Mỗi lời gọi được ghi vào schema `ops` kèm tên hệ thống gọi và `request_id` (header `X-Request-Id`). Vận hành shadow, sao lưu và báo cáo: [van-hanh-shadow.md](van-hanh-shadow.md).

## API

Ngoài API gốc dưới đây, base có bộ endpoint tương thích Google Maps (`/maps/api/...`) để app/web hiện tại chỉ cần đổi host: xem [api-tuong-thich-google.md](api-tuong-thich-google.md).

### Gợi ý địa chỉ

`GET /v1/suggest?q=pho hue ha noi&limit=5[&lat=..&lon=..][&province_code=01]`

Trả danh sách `{label, kind, lat, lon, ward_code, province_code, score}`. `kind` là `province`, `ward`, `street`, `place` hoặc `address`. Truyền `lat/lon` để ưu tiên kết quả gần.

### Phân giải địa chỉ

`GET /v1/geocode?address=59 Nguyễn Huệ, P. Bến Nghé, Q.1, TP.HCM[&order_id=..][&ref_lat=..&ref_lng=..]`

Trả `{lat, lon, level, confidence, source, admin, components, notes}`.

| `level` | Ý nghĩa | Độ tin cậy gốc |
|---|---|---|
| `ROOFTOP` | Số nhà khớp đúng một điểm địa chỉ | 0,8–0,9 |
| `RANGE_INTERPOLATED` | Nội suy giữa hai số nhà gần nhất cùng phía đường, hoặc số nhà khớp nhưng nằm trong ngõ | 0,6–0,75 |
| `STREET` | Điểm trên đường khớp tên trong xã; đường càng dài càng kém tin cậy | 0,2–0,5 |
| `PLACE` | Địa danh khớp tên (thôn/xóm, chợ, toà nhà, khu công nghiệp...) | 0,45–0,55 |
| `WARD_CENTROID` | Tâm xã/phường | 0,3 |
| `PROVINCE_CENTROID` | Tâm tỉnh | 0,15 |
| `NOT_FOUND` | Không nhận ra tỉnh/xã | 0 |

Độ tin cậy được nhân với hệ số theo cách nhận diện hành chính: địa chỉ 2 cấp mới ×1,0; địa chỉ cũ 3 cấp phải chuyển đổi ×0,9; chỉ biết tỉnh ×0,6. Khi phải mở rộng bán kính tìm thì nhân thêm 0,7 và ghi vào `notes`.

### Khoảng cách thực tế

`POST /v1/route` với `{"points": [{"lat":..,"lon":..}, ...], "vehicle": "motorbike"}`, trả `{distance_m, duration_s, source, shape}`.

`POST /v1/matrix` với `{"sources": [...], "targets": [...], "vehicle": "car"}`, tối đa 10.000 ô; trả ma trận `distance_m`, `duration_s` và `source` cho từng ô.

`vehicle` là `car`, `motorbike` hoặc `truck`. `source` cho biết giá trị đến từ đâu: `valhalla`, `osrm`, hoặc `fallback` (đường chim bay × hệ số đường vòng, dùng khi engine lỗi hoặc không tìm được đường).

Giới hạn hiện tại: ma trận chạy bằng OSRM với profile ô tô. Xe máy được xấp xỉ bằng profile ô tô loại cao tốc; thời gian xe máy và xe tải trong ma trận là ước lượng. Tuyến đường (`/v1/route`) dùng costing thật của Valhalla cho cả ba loại xe.

## Nguồn dữ liệu

- Đơn vị hành chính 2 cấp, toạ độ tâm, chuyển đổi địa chỉ cũ: thư viện `vietnamadminunits` (MIT).
- Đường, địa chỉ có số nhà, địa danh: OpenStreetMap qua Geofabrik (ODbL).

Mọi bảng trong schema `geo` là dẫn xuất và dựng lại được bằng `make import`.
