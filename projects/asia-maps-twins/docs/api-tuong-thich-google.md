# API tương thích Google Maps — hướng dẫn chuyển đổi

Base cung cấp các endpoint có **cùng đường dẫn, tham số và cấu trúc JSON** với Google Maps Platform Web Service API (bản legacy). Hệ thống đang gọi `https://maps.googleapis.com/maps/api/...` chỉ cần đổi host sang server của base và đổi `key`.

Đã kiểm chứng bằng chính thư viện chính thức `googlemaps` (Python) của Google, chỉ đổi `base_url`: 17/17 trường hợp chạy đúng ([test](../tests/integration/test_google_compat.py)).

```python
gmaps = googlemaps.Client(key="AIza...", base_url="https://bds.noibo.vn")
```

## Endpoint hỗ trợ

| Google API | Đường dẫn | Ghi chú |
|---|---|---|
| Geocoding | `/maps/api/geocode/json?address=` | Nhận địa chỉ mới 2 cấp và địa chỉ cũ 3 cấp; `components` (`country`, `administrative_area`, `locality`, `route`) |
| Reverse Geocoding | `/maps/api/geocode/json?latlng=` | Trả nhiều kết quả từ chính xác tới tổng quát: số nhà → đường → xã → tỉnh; lọc `result_type`, `location_type` |
| Place Autocomplete | `/maps/api/place/autocomplete/json?input=` | `location` + `radius` (ưu tiên gần), `components=country:vn`, `types` (`geocode`, `address`, `establishment`, `(regions)`, `(cities)`), `offset`, `origin`, `sessiontoken` |
| Query Autocomplete | `/maps/api/place/queryautocomplete/json?input=` | |
| Place Details | `/maps/api/place/details/json?place_id=` | Nhận cả `placeid` (tên cũ); nhận `fields` nhưng luôn trả đủ trường |
| Distance Matrix | `/maps/api/distancematrix/json?origins=&destinations=` | Mỗi điểm là `lat,lng`, `place_id:...` hoặc địa chỉ chữ; tối đa 200 điểm mỗi phía, 10.000 phần tử (Google: 25 và 100) |
| Directions | `/maps/api/directions/json?origin=&destination=` | `waypoints` (bỏ qua `optimize:true`, nhận `via:`); `overview_polyline` và `polyline` theo chuẩn Google |

## Giống Google

- Mọi lỗi nghiệp vụ trả HTTP 200 kèm `status`: `OK`, `ZERO_RESULTS`, `NOT_FOUND`, `INVALID_REQUEST`, `REQUEST_DENIED`, `MAX_ELEMENTS_EXCEEDED`, `MAX_DIMENSIONS_EXCEEDED`, kèm `error_message` khi lỗi.
- `geometry.location_type`: `ROOFTOP`, `RANGE_INTERPOLATED`, `GEOMETRIC_CENTER`, `APPROXIMATE`.
- `partial_match: true` khi kết quả kém chi tiết hơn câu hỏi, hoặc địa chỉ cũ phải chuyển đổi sang đơn vị mới.
- `distance.text` / `duration.text` theo `language` (`vi` mặc định: "12,3 km", "1 giờ 5 phút"; `en`: "12.3 km", "1 hour 5 mins").

## Khác Google (cần biết khi chuyển)

| Điểm khác | Ảnh hưởng | Cách xử lý |
|---|---|---|
| **Chỉ thay được lời gọi HTTP Web Service.** Places SDK (Android/iOS) và Maps JavaScript API (widget `google.maps.places.Autocomplete`) tự gọi máy chủ Google | App dùng SDK hoặc widget JS sẽ không đổi được bằng cách đổi host | Gọi HTTP endpoint ở trên từ app hoặc qua backend, rồi tự vẽ danh sách gợi ý |
| `place_id` của base có dạng `au_…`, `st_…`, `pl_…`, `ad_…`, `gc_…` | `place_id` của Google đã lưu trong DB không tra được | Lưu toạ độ cùng địa chỉ; dùng `place_id` của base cho dữ liệu mới |
| Chỉ còn 2 cấp hành chính: xã/phường mang `administrative_area_level_3` và `sublocality_level_1`, tỉnh mang `administrative_area_level_1` | Không còn `administrative_area_level_2` (quận/huyện) | Code đọc quận/huyện cần bỏ hoặc chấp nhận trống |
| `mode`: hỗ trợ `driving`; thêm `two_wheeler` (xe máy) và `truck`. Chưa hỗ trợ `walking`, `bicycling`, `transit` | `mode` chưa hỗ trợ trả `INVALID_REQUEST` | Muốn `driving` mặc định là xe máy: đặt `BDS_GOOGLE_DRIVING_VEHICLE=motorbike` |
| Directions: mỗi chặng chỉ có một `step`, `html_instructions` rỗng | Chưa có chỉ dẫn rẽ trái/phải | Dùng `overview_polyline` để vẽ tuyến |
| Ma trận xe máy/xe tải là ước lượng (OSRM profile ô tô) | Thời gian xe máy, xe tải lệch so với thực tế | Mỗi phần tử có `bds_source`; sẽ cải thiện khi có profile xe máy |
| Chưa có: Text Search, Nearby Search, Find Place, Place Photos, Roads, Elevation, Time Zone, Places API (New), Routes API | Gọi tới sẽ trả 404 | Báo nếu hệ thống hiện tại dùng, để bổ sung |

## Trường mở rộng

Client cũ bỏ qua các trường này; client mới dùng để ra quyết định:

- Geocoding: khối `bds` với `level`, `confidence` (0–1), `source`, `admin_source`, `notes`. Hợp đồng dùng độ tin cậy: ≥ 0,7 tự gán bưu cục; 0,5–0,69 gán và gắn cờ xác nhận khi phát; < 0,5 hỏi lại khách.
- Distance Matrix: `bds_source` trong từng phần tử (`osrm` hoặc `fallback`).
- Tham số thêm cho Geocoding khi chạy shadow: `order_id` (hoặc header `X-Order-Id`), `ref_lat`, `ref_lng`, `ref_type`, `ref_source`. Xem [van-hanh-shadow.md](van-hanh-shadow.md).
- Directions: `bds_source` trong route (`valhalla` hoặc `fallback`); khi là `fallback` thì `warnings` có thông báo.

## Cấu hình

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `BDS_API_KEYS` | trống | `tên:key` ngăn bằng dấu phẩy, vd. `oms:AIza...,app:AIza...`. Trống thì không kiểm tra key (chỉ dùng cho dev) |
| `BDS_RATE_LIMIT_RPS` | `100` | Giới hạn yêu cầu/giây cho mỗi hệ thống gọi; vượt thì trả `OVER_QUERY_LIMIT` |
| `BDS_GOOGLE_DRIVING_VEHICLE` | `car` | Phương tiện khi client gửi `mode=driving` |
| `BDS_CORS_ORIGINS` | `*` | Nguồn được gọi trực tiếp từ trình duyệt |

Thư viện `googlemaps` chính thức yêu cầu key bắt đầu bằng `AIza`; nên cấp key cho base theo cùng dạng để client cũ không phải sửa kiểm tra.
