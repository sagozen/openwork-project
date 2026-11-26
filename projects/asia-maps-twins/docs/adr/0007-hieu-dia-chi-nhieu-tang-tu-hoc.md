# ADR-0007 — Hiểu địa chỉ khách nhập: nhiều tầng và tự học

- **Trạng thái:** Chấp nhận
- **Ngày:** 2026-11-06
- **Người quyết định:** [Người duy trì dự án]
- **Liên quan:** ADR-0005; tài liệu nghiên cứu `research/BDS-Indie/ADR_week0.md` (ADR-001, ADR-003), `Detail08_vietnamese_nlp.md`

## Bối cảnh

Bộ phân giải vòng 1 hiểu địa chỉ hoàn toàn bằng luật. Khi chạy thử demo đã lộ ba lỗi kiểu "luật vá luật": chữ "p" dính vào tên đường khi khách không gõ dấu phẩy; "thôn Đông" khớp nhầm "Đồng Tháp"; "KCN Quế Võ" mất tên khu công nghiệp. Luật sẽ phình to và khó bảo trì, đúng như cảnh báo của tài liệu nghiên cứu.

Mục tiêu: dữ liệu càng ngày càng chuẩn, ít công vận hành, độ chính xác cao. Ràng buộc từ nghiên cứu vẫn giữ: LLM không bao giờ nằm trong đường xử lý yêu cầu; dữ liệu cá nhân không ra ngoài.

## Quyết định

Năm tầng. Tầng rẻ và nhanh chạy trước; AI chỉ nhận phần khó.

```
Khách gõ
  │ 1. Luật        chuẩn hoá chữ, mở viết tắt, nhận diện đơn vị hành chính (gồm địa chỉ cũ 3 cấp)
  │ 2. Cache       khoá = chuỗi đã chuẩn hoá + phiên bản mô hình → trả ngay nếu đã gặp
  │ 3. Tagger ML   CRF gán nhãn từng từ: số nhà / ngõ / đường / thôn / địa danh / xã / huyện / tỉnh, kèm xác suất
  │                → tạo ứng viên thứ hai bên cạnh ứng viên của luật
  │ 4. Quyết định  mô hình hiệu chỉnh xác suất chấm P(kết quả nằm trong 200 m) cho từng ứng viên,
  │                chọn ứng viên cao nhất; độ tin cậy trả cho khách CHÍNH LÀ xác suất này
  ▼ kết quả + ghi log
Ngoài luồng (mỗi đêm, `make learn`):
  5. LLM          gán nhãn các ca khó (độ tin cậy thấp, tagger không chắc), chỉ nhận giá trị là đoạn con của
                  chuỗi gốc (chặn bịa); bất đồng với tagger → hàng chờ người duyệt
  → huấn luyện lại tagger trên nhãn tổng hợp + nhãn LLM + nhãn người duyệt
  → huấn luyện lại mô hình quyết định trên kết quả đã biết đúng/sai (hôm nay: địa chỉ OSM để dành;
    khi có dữ liệu công ty: GPS phát thành công)
  → cổng chất lượng: mô hình mới chỉ được dùng nếu điểm trên tập đánh giá cố định không giảm
```

### Lựa chọn cụ thể

| Tầng | Chọn | Lý do |
|---|---|---|
| Tagger | CRF (`sklearn-crfsuite`) với đặc trưng từ, hình dạng, ngữ cảnh | Dưới 1 ms mỗi địa chỉ trên CPU; huấn luyện lại vài giây; đủ cho cấu trúc địa chỉ. PhoBERT/BiLSTM là bước sau nếu CRF chạm trần |
| Dữ liệu ban đầu cho tagger | Nhãn tổng hợp: ghép số nhà, đường, thôn, địa danh, xã, tỉnh thật từ OSM và danh mục hành chính, thêm nhiễu (bỏ dấu, viết tắt, bỏ dấu phẩy, đảo thứ tự, địa chỉ cũ 3 cấp, số điện thoại) | Nhãn đúng theo cách dựng; không cần người gán nhãn để khởi động |
| Mô hình quyết định | Hồi quy logistic trên đặc trưng của ứng viên (mức, độ giống tên đường, chiều dài đường khớp, khoảng cách hai mốc nội suy, cách nhận diện hành chính, độ chắc của tagger, luật và tagger có đồng ý không...) | Ra xác suất đã hiệu chỉnh, giải thích được, huấn luyện tức thì. Thay cho "System One/Jev" trong nghiên cứu, vì các model đó chưa xác minh được |
| LLM | Endpoint chuẩn OpenAI (Ollama/vLLM tự host, ví dụ Qwen) cấu hình bằng `BDS_LLM_URL`, `BDS_LLM_MODEL` | Tự host nên không lộ dữ liệu; chưa cấu hình thì vòng học vẫn chạy, chỉ bỏ bước LLM |
| Cache | LRU trong bộ nhớ từng tiến trình | Đủ cho một máy; nhiều máy thì chuyển sang Valkey |

## Phương án đã cân nhắc

| Phương án | Vì sao không chọn |
|---|---|
| Chỉ luật (vòng 1) | Phình to, mỗi lỗi mới thêm một luật |
| LLM trong đường xử lý | Chậm, tốn, xác suất không hiệu chỉnh; trái nguyên tắc của nghiên cứu |
| Chỉ ML, bỏ luật | Luật chuẩn hoá và danh mục hành chính ổn định, chính xác; bỏ đi là phí. Luật vẫn là tầng 1 và là một ứng viên |
| Độ tin cậy gán tay theo mức | Không phản ánh xác suất đúng thật; ngưỡng 0,7 / 0,5 của hợp đồng độ tin cậy không có nghĩa |

## Hệ quả

- Độ tin cậy trở thành xác suất đo được: 0,7 nghĩa là khoảng 70% số kết quả như vậy nằm trong 200 m.
- Thêm schema `ml` (mẫu huấn luyện, hàng chờ duyệt, sổ đăng ký mô hình) và thư mục `data/models/`.
- Mô hình phải được huấn luyện (`make learn`) trước khi các tầng 3–4 hoạt động; chưa có mô hình thì hệ thống chạy như vòng 1.

## Khi nào xem lại

- Tagger CRF chạm trần trên tập đánh giá thật → thử PhoBERT/BiLSTM-CRF.
- Có GPS phát thành công → mô hình quyết định huấn luyện trên nhãn thật thay cho địa chỉ OSM.
