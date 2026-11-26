# Bản ghi quyết định kiến trúc (ADR)

Mỗi ADR ghi một quyết định: bối cảnh, quyết định, phương án đã cân nhắc, hệ quả, và điều kiện để xem lại. Đọc các ADR trước khi đổi kiến trúc; muốn đổi một quyết định thì viết ADR mới thay thế, không sửa lặng lẽ ADR cũ.

| Số | Quyết định | Trạng thái |
|---|---|---|
| [0001](0001-noi-bo-truoc-san-sang-mo-sau.md) | Làm nội bộ cho công ty trước, thiết kế sẵn để mở mã sau | Chấp nhận |
| [0002](0002-modular-monolith-postgres-loi.md) | Modular monolith với PostgreSQL + PostGIS làm lõi | Đề xuất |
| [0003](0003-ontology-as-code.md) | Ontology định nghĩa bằng code (LinkML), bốn khối Object · Link · Action · Function | Chấp nhận (PoC đạt) |
| [0004](0004-man-dieu-hanh-3d.md) | Màn điều hành 3D cho HO: MapLibre GL JS + deck.gl | Chấp nhận về công nghệ; tạm dừng, ưu tiên ba năng lực lõi |
| [0005](0005-engine-ba-nang-luc-loi.md) | Engine cho ba năng lực lõi: Valhalla (tuyến đường), OSRM (ma trận), PostgreSQL full-text + trigram (gợi ý), cascade có độ tin cậy (phân giải) | Chấp nhận |
| [0006](0006-api-tuong-thich-google.md) | API tương thích Google Maps Web Service (legacy): đổi host là chạy | Chấp nhận |
| [0007](0007-hieu-dia-chi-nhieu-tang-tu-hoc.md) | Hiểu địa chỉ khách nhập: luật → cache → tagger ML → mô hình quyết định, LLM ngoài luồng, tự học mỗi đêm | Chấp nhận |

Bối cảnh và phân tích dẫn tới các quyết định này: báo cáo đề xuất kiến trúc base.
ADR của engine phân giải địa chỉ trong tài liệu nghiên cứu: [research/BDS-Indie/ADR_week0.md](../../research/BDS-Indie/ADR_week0.md). ADR-0005 thay một phần các lựa chọn công nghệ trong đó (thêm Valhalla cho tuyến đường có xe máy, giữ OSRM cho ma trận; PostgreSQL thay OpenSearch ở vòng đầu).
