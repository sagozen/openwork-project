# ADR-0006 — API tương thích Google Maps Web Service (bản legacy)

- **Trạng thái:** Chấp nhận
- **Ngày:** 2026-11-06
- **Người quyết định:** [Người duy trì dự án]
- **Liên quan:** ADR-0005; hướng dẫn [api-tuong-thich-google.md](../api-tuong-thich-google.md)

## Bối cảnh

App và web hiện tại đang gọi Google Maps Platform. Yêu cầu: sau khi đổi endpoint sang base, hệ thống cũ chạy được ngay, không phải viết lại phần tích hợp. Tài liệu nghiên cứu cũng đã đề xuất "sao chép hình dạng API của Google để đội tích hợp không phải học format mới".

## Quyết định

1. Base cung cấp router `/maps/api/...` có cùng đường dẫn, tham số và cấu trúc JSON với **Web Service API bản legacy** của Google: Geocoding (thuận và ngược), Place Autocomplete, Query Autocomplete, Place Details, Distance Matrix, Directions.
2. Lỗi nghiệp vụ trả HTTP 200 kèm `status`, như Google.
3. Thông tin riêng của base (mức, độ tin cậy, nguồn) nằm trong khối mở rộng `bds` hoặc trường `bds_source`; client cũ bỏ qua.
4. API gốc `/v1/...` của base giữ nguyên. Router tương thích chỉ là lớp định dạng, không có logic phân giải riêng.
5. Tiêu chí tương thích: thư viện chính thức `googlemaps` của Google chạy toàn bộ test khi chỉ đổi `base_url`.

## Phương án đã cân nhắc

| Phương án | Vì sao không chọn |
|---|---|
| Chỉ có API riêng `/v1/...` | Mọi app/web phải viết lại phần tích hợp |
| Tương thích Places API (New) và Routes API | Hai API mới dùng POST, field mask và header riêng; khó đổi chỉ bằng host. Bổ sung sau nếu hệ thống hiện tại đang dùng |
| Proxy: chuyển lời gọi sang Google khi base không chắc | Lộ dữ liệu ra ngoài; giữ chi phí Google. Phương án dự phòng nguồn ngoài thuộc cascade của resolver, không thuộc lớp API |

## Hệ quả

- App/web/backend gọi Web Service HTTP đổi được bằng host + key.
- Không thay được Places SDK (Android/iOS) và widget của Maps JavaScript API vì chúng tự gọi máy chủ Google; các nơi này phải chuyển sang gọi HTTP.
- `place_id` của base khác Google; `place_id` Google đã lưu không tra được.
- Mỗi khi đổi resolver hoặc gợi ý, test tương thích chạy lại cùng `make test`.

## Khi nào xem lại

- Hệ thống hiện tại dùng Places API (New), Routes API, Text Search hoặc Nearby Search.
- Google đổi cấu trúc phản hồi của các API legacy.
