# ADR-0005 — Engine cho ba năng lực lõi: gợi ý, phân giải, khoảng cách

- **Trạng thái:** Chấp nhận
- **Ngày:** 2026-11-06
- **Người quyết định:** [Người duy trì dự án]
- **Liên quan:** ADR-0002, ADR-0003; tài liệu nghiên cứu `research/BDS-Indie/Detail04_architecture.md`

## Bối cảnh

Base phải có ba năng lực trước mọi tầng khác: gợi ý địa chỉ khi gõ, phân giải địa chỉ thành toạ độ, và tính khoảng cách/thời gian theo đường thật. Tài liệu nghiên cứu chọn OpenSearch cho gợi ý và OSRM cho khoảng cách. Hai lựa chọn này được xem lại với hai ràng buộc: làm nhanh, sửa nhanh với đội nhỏ; và phương tiện chính của logistics Việt Nam là xe máy.

## Quyết định

### 1. Khoảng cách: Valhalla thay cho OSRM

- Valhalla có sẵn costing `motor_scooter` (xe máy), `auto`, `truck` trên **cùng một bộ dữ liệu**, chọn lúc gọi API. OSRM cần dựng lại đồ thị cho mỗi profile và phải tự viết `motorbike.lua`.
- Valhalla có ma trận (`sources_to_targets`), tuyến đường, isochrone, và hỗ trợ ràng buộc xe tải (tải trọng, chiều cao).
- Đánh đổi: ma trận lớn chậm hơn OSRM MLD. Chấp nhận vì tiêu chí là 100×100 < 2 giây; nếu đo không đạt thì thêm OSRM riêng cho ma trận hub↔hub.
- Mọi chỗ gọi đi qua interface `RoutingEngine`. Khi engine lỗi hoặc quá thời gian, hệ thống trả kết quả dự phòng (đường chim bay × hệ số vùng) và **ghi rõ `source: fallback`**, không trả lỗi.

**Cập nhật sau khi đo (2026-11-06): ma trận chuyển sang OSRM, tuyến đường giữ Valhalla.** Ma trận của Valhalla 3.9.1 trên dữ liệu Việt Nam mất khoảng 0,1 giây cho mỗi điểm nguồn: 100×100 trong nội thành TP.HCM mất 10–11 giây. Ngoài ra 15–17% ô không có kết quả, dù `/route` cho cùng cặp điểm vẫn tìm được đường. Đã loại trừ các nguyên nhân: ổ đĩa (đưa tile vào ổ trong container vẫn 10,5 giây), giả lập kiến trúc (image chạy native arm64), cấu hình `allow_second_pass` và thuật toán TimeDistanceMatrix (chậm hơn, 36–38 giây). Vì vậy kích hoạt phương án đã ghi sẵn: ma trận dùng OSRM (MLD, profile ô tô). Xe máy được xấp xỉ bằng `exclude=motorway`; tuyến đường từng chuyến vẫn dùng costing `motor_scooter` của Valhalla.

### 2. Gợi ý: bắt đầu bằng PostgreSQL (pg_trgm + unaccent), chưa dùng OpenSearch

- Một service ít hơn; dữ liệu gợi ý nằm cạnh dữ liệu phân giải nên không phải đồng bộ.
- Interface `SuggestIndex` cho phép thay bằng OpenSearch mà không đổi API.
- Chuyển sang OpenSearch khi p95 vượt 80 ms ở quy mô thật, hoặc khi cần xếp hạng học máy.
- Cách lấy ứng viên sau khi đo: full-text của PostgreSQL (mọi từ có mặt, từ cuối khớp tiền tố, chỉ mục GIN) là đường chính; trigram KNN (GiST) chỉ chạy khi full-text không ra kết quả, để chịu được gõ sai. Trên khoảng 340 nghìn mục toàn quốc: p50 4,7 ms, p95 32,6 ms.

### 3. Phân giải: cascade có độ tin cậy, parser bằng luật trước

- Parser vòng 1 là luật: chuẩn hoá chữ, mở viết tắt, nhận diện đơn vị hành chính bằng từ điển (gồm tên cũ 3 cấp ánh xạ sang 2 cấp), tách số nhà / ngõ / đường. Tagger học máy là vòng sau, khi có nhãn từ vận hành.
- Cascade: điểm giao thành công (khi có dữ liệu công ty) → số nhà khớp địa chỉ OSM → đường trong xã → POI → tâm xã → tâm tỉnh. Mỗi tầng trả mức và độ tin cậy theo hợp đồng của tài liệu nghiên cứu.

### 4. Dữ liệu nguồn

- Đơn vị hành chính 2 cấp, toạ độ tâm xã, ánh xạ cũ→mới: thư viện `vietnamadminunits` (MIT).
- Đường, POI, địa chỉ có số nhà: OpenStreetMap (Geofabrik, ODbL).
- Ở giai đoạn base, đơn vị hành chính, đường, POI và địa chỉ OSM đều là **lớp dẫn xuất** nạp lại được từ nguồn, nằm ở schema `geo`, không đi qua action từng bản ghi. `AdminUnit` sẽ được đăng ký thành object của ontology (ADR-0003) khi có object nghiệp vụ cần liên kết tới nó (bưu cục, điểm giao).

## Phương án đã cân nhắc

| Phương án | Vì sao không chọn |
|---|---|
| OSRM như tài liệu nghiên cứu | Không có xe máy sẵn; mỗi profile một đồ thị |
| GraphHopper | Bản mã mở thiếu một số tính năng ma trận; Java, thêm một hệ sinh thái |
| OpenSearch ngay từ đầu | Thêm service và bước đồng bộ khi chưa đo thấy cần |
| Pelias/Photon cho phân giải | Thiết kế cho địa chỉ phương Tây; không hiểu ngõ/ngách/hẻm, xã/phường 2 cấp và địa chỉ cũ |

## Hệ quả

- Ba service ngoài ứng dụng: PostGIS, Valhalla (tuyến đường) và OSRM (ma trận). Bước dựng dữ liệu OSRM cần khoảng 12 GB RAM.
- Cần dựng tile Valhalla từ dữ liệu OSM Việt Nam (chạy một lần, cập nhật định kỳ).
- Chất lượng phân giải vòng 1 bị giới hạn bởi độ phủ số nhà của OSM; tầng điểm giao thành công sẽ bù khi có dữ liệu công ty.

## Khi nào xem lại

- Ma trận 100×100 không đạt < 2 giây với Valhalla.
- Gợi ý không đạt p95 < 80 ms trên PostgreSQL.
- Có đủ nhãn từ vận hành để thay parser luật bằng tagger.
