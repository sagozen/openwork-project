# 01 — Overview các hệ thống Maps lớn & bài học rút ra

## 1. Bảng so sánh
| Hệ thống | Nguồn dữ liệu | Cách họ đúng | Mô hình API/giá | Lấy gì cho mình |
|---|---|---|---|---|
| Google Maps Platform | Xe survey + Street View + người dùng Android + đóng góp | Telemetry khổng lồ | Autocomplete tính theo *session*; Geocode trả `location_type` ROOFTOP/RANGE_INTERPOLATED/GEOMETRIC_CENTER/APPROXIMATE; Routes/Distance Matrix | **Copy hình dạng API**: session token + confidence level → đội tích hợp không phải học format mới |
| GrabMaps | OSM nền + GPS trace tài xế + KartaView (camera dashcam) + tài xế gán POI | **Đội xe = cảm biến**, hyperlocal | Bán qua AWS Location Service | Bài học số 1: bưu tá = Grab driver. Mỗi scan phát = 1 label |
| AWS Location Service | Không tự làm; aggregate Esri / HERE / Grab | Router nhiều nguồn | Pay-per-request | Kiến trúc **cascade nhiều nguồn**: nội bộ trước, ngoài sau khi confidence thấp |
| Mapbox | OSM + telemetry SDK | Open stack: OSRM, Valhalla, Pelias/Photon (từ Mapzen) | Session-based | Toàn bộ stack cần dùng đã có open source production-grade |
| HERE / TomTom | Xe khảo sát, Lidar, hợp đồng OEM | Chi hàng trăm triệu $ | Enterprise license | **KHÔNG** đi hướng này — đây là bẫy "Lidar/camera" trong slide cũ |
| Apple Maps | Xe survey + iPhone | 8 năm, hàng tỉ $ | — | Luận cứ: không ai xây bản đồ toàn diện trong 1 năm |
| Goong / Vietmap / Map4D / Vietbando | Tự khảo sát + OSM | POI VN tốt hơn OSM; ngõ/ngách/tổ/thôn vẫn yếu | Rẻ hơn Google 3–10x | Dùng làm **fallback nguồn 3** + benchmark, không làm nền |
| OpenStreetMap | Cộng đồng | VN: đường chính tốt, ngõ sâu yếu, số nhà rất thưa | ODbL (share-alike) | Nền đường + ranh giới + routing |
| Overture Maps | Meta + MS + Amazon + TomTom | Building footprint, places, admin | CDLA-Permissive 2.0 (dùng thoải mái) | Building VN + places, cập nhật hàng tháng |
| OpenAddresses | Chính phủ các nước | VN gần như không có | — | Bỏ qua |

## 2. Pattern kỹ thuật chung của các bên làm tốt
1. **Geocoding = cascade**: exact match → interpolate → centroid → external. Luôn trả mức độ tin cậy.
2. **Autocomplete = search engine + rerank**: text match chỉ là bước 1; thứ hạng do popularity + khoảng cách + lịch sử.
3. **Ground truth từ vận hành**, không từ mua: Grab (driver GPS), Google (Android), Uber (trip end-point).
4. **Routing dùng engine có sẵn** (OSRM/Valhalla); giá trị nằm ở dữ liệu đường và profile xe, không ở thuật toán.
5. **Eval liên tục**: mọi bên lớn có golden set theo vùng, chạy hàng ngày.

## 3. Nguồn dữ liệu mở dùng ngay (0đ)
| Nguồn | Lấy gì | Cách lấy | License |
|---|---|---|---|
| Geofabrik `vietnam-latest.osm.pbf` | Đường, POI, admin | wget, cập nhật tuần | ODbL |
| Overture `buildings`, `places`, `divisions` | Building footprint, POI, ranh giới | DuckDB `read_parquet` lọc bbox VN | CDLA-P 2.0 |
| Nghị quyết sắp xếp đơn vị hành chính 2025 (2 cấp) | Bảng ánh xạ cũ→mới | Crawl văn bản/Tổng cục Thống kê, agent parse | Công khai |
| Dữ liệu nội bộ: 213k địa chỉ cấp 4, 863k địa danh cấp 5 | Seed parser | Export CSV | Nội bộ |
| Lịch sử phát hàng + GPS scan | **Ground truth** | Query DB/ETL | Nội bộ |

## 4. Ràng buộc pháp lý phải tuân thủ
- Google Maps ToS: không cache quá 30 ngày (trừ place_id), không dùng để xây DB cạnh tranh, không hiển thị trên bản đồ khác. → Chỉ dùng shadow benchmark mẫu ≤ 1.000 địa chỉ, không lưu kết quả vào DB chính.
- OSM ODbL: nếu *trộn* dữ liệu nội bộ vào OSM data rồi phân phối ra ngoài → phải share-alike. Dùng nội bộ không phân phối → không bị ràng buộc. Giữ `delivery_points` ở **database riêng** (không chỉ bảng riêng), chỉ join lúc query; đồ thị routing (OSRM từ OSM) là derivative, không phân phối ra ngoài.
- Overture: dùng tự do, ghi attribution.

## 5. Agent task tuần 0 (giao cho Claude Code / Cursor)