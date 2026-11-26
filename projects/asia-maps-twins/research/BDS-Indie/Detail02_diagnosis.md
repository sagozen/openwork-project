# 00 — Chẩn đoán bài toán & luận điểm trình bày

## 1. Bài toán thực sự (không phải "bản đồ")
Viettel Post cần một **hệ thống phân giải địa chỉ phục vụ logistics**, trả lời 3 câu cho mỗi đơn:
1. Địa chỉ này ở đâu? → (lat, lng, confidence, zone, bưu cục)
2. Khách đang gõ gì? → gợi ý top-3 đúng ≥ 85%
3. A→B bao xa, bao lâu? → ma trận khoảng cách cho phân tuyến/tính giá

Mọi thứ khác (thời tiết, địa hình, Lidar, camera, bản đồ nền đẹp) là **phụ**, cắt khỏi scope năm nay.

## 2. Vì sao đội cũ chậm (đọc từ slide, không dùng source của họ)
| Dấu hiệu trên slide | Vấn đề gốc |
|---|---|
| "90% so Google" | Thước đo sai. Google sai ở VN; so với Google không chứng minh đơn giao được |
| "5 triệu địa chỉ/tháng, 12 tỷ, tuyển 4 GIS" | Chiến lược mua + thuê. Không có vòng tự học |
| "Lidar, camera, thời tiết, địa hình, LLM, DL" | Scope mở rộng vô hạn, không use case nào đi đến cùng |
| "Xác minh chéo với Google 5tr/tháng" | Vi phạm ToS Google (cấm cache >30 ngày, cấm xây DB cạnh tranh) |
| "Autocomplete 60% → 90%" | Không nói 90% của gì: top-1? top-5? trên tập nào? |
| 213.908 địa chỉ cấp 4, 863.095 địa danh cấp 5 | Có dữ liệu nhưng không có **nhãn đúng/sai** từ vận hành |

Kết luận: thiếu 3 thứ — **golden set**, **vòng feedback từ phát hàng**, **confidence score trong API**.

## 3. Tài sản đang có mà chưa khai thác
- Hàng vạn bưu tá quét mã "phát thành công" mỗi ngày, có GPS điện thoại → **1 nhãn miễn phí / đơn**.
- Lịch sử hàng trăm triệu đơn: chuỗi địa chỉ khách gõ + kết quả phát → dataset learning-to-rank.
- 213k địa chỉ cấp 4 + 863k địa danh cấp 5 đã có → seed cho parser.

## 4. Luận điểm mở màn (dùng nguyên văn khi trình bày)
> "Chúng ta không xây bản đồ. Chúng ta xây hệ thống trả lời 3 câu hỏi cho 100% đơn hàng,
> với độ tin cậy đo được mỗi ngày. Hệ thống cũ cần mua dữ liệu để đúng.
> Hệ thống này đúng hơn mỗi ngày vì mỗi đơn phát thành công là một điểm dữ liệu mới — tự động, miễn phí."

## 5. Việc tuần 0 (bạn tự làm, không delegate được)
- [ ] Xin quyền đọc: log quét phát (mã đơn, timestamp, GPS, bưu tá, bưu cục) từ VTMan/E2 — **không có cái này, dừng dự án**.
- [ ] Xin quyền đọc: bảng đơn hàng (địa chỉ người nhận raw, tỉnh/xã đã chọn, trạng thái phát).
- [ ] Xin 1 máy 8 vCPU / 32 GB RAM / 500 GB SSD, có Docker, mở outbound HTTPS.
- [ ] Chốt 1 tỉnh pilot: chọn tỉnh có sản lượng trung bình, địa chỉ phức tạp vừa phải (gợi ý: Bắc Ninh / Đồng Nai, không chọn HN/HCM đầu tiên).
- [ ] Chốt với lãnh đạo: KPI mới theo `05-kpi.md`, không dùng "so Google".