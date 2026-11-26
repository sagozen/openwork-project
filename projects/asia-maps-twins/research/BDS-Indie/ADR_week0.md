# ADR — Bản ghi quyết định kiến trúc (Tuần 0)

Ba quyết định nền tảng, chốt **trước khi viết dòng code đầu tiên** (nguyên tắc số 5, Proposal01 §4). Mỗi ADR ghi: Bối cảnh → Quyết định → Phương án đã cân nhắc → Hệ quả.

> **Cách dùng:** trình kèm Proposal01 để lãnh đạo thấy các quyết định đã được cân nhắc có lý do; agent đọc file này trước mọi task (theo CLAUDE.md, Detail07 §2).

---

## ADR-001 — Kiến trúc xử lý yêu cầu: Rule → Cache → AI quyết định → AI sinh

- **Trạng thái:** Đề xuất
- **Ngày:** [dd/mm/yyyy]
- **Người quyết định:** [Khối Core-AI]

### Bối cảnh
- Hệ thống phải trả lời 3 câu cho 100% đơn hàng với ngân sách độ trễ p95: autocomplete < 80 ms, geocode miss < 150 ms, hit < 10 ms.
- LLM quá chậm/đắt để nằm trong đường xử lý nóng; đồng thời cần **xác suất hiệu chỉnh** để hệ thống hạ nguồn tự quyết định (hợp đồng tin cậy, Proposal01 §5.4).
- Cần zero phí bản quyền và tự lưu trữ để không rò dữ liệu cá nhân ra ngoài (NĐ 13/2023).

### Quyết định
Kiến trúc 4 tầng — tầng rẻ/nhanh xử lý trước, AI chỉ nhận phần còn lại:

1. **Rule** — chuẩn hoá + viết tắt + `admin_alias` trie + từ vùng miền. Ổn định (~50 rule), không phình (Detail08).
2. **Cache** — Redis L1 (`geo:{addr_hash}`), autocomplete prefix cache 60 s.
3. **AI quyết định (System One / Jev-compatible)** — Plumb-4B / decider-2B / Lichen (Apache-2.0, tự host trên RTX 3090) cho phán đoán có cấu trúc: khớp mờ địa chỉ, tranh chấp zone, phân loại cảnh báo. Trả **xác suất hiệu chỉnh**, không sinh văn bản.
4. **AI sinh (LLM Qwen2.5-7B)** — chỉ cho đuôi khó + gán nhãn huấn luyện; chạy **batch hàng đêm ngoại tuyến**, không bao giờ trong request path.

Ba lớp AI (tagger, System One, LLM) cùng chạy trên **RTX 3090 24 GB**.

### Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Vì sao bỏ |
|---|---|---|---|
| 100% luật / regex | 0 phụ thuộc AI | Phình to, khó bảo trì, sai địa chỉ lạ | Nợ kỹ thuật dài hạn |
| LLM trong request path | Chính xác văn bản | Chậm (>500 ms), đắt, xác suất không hiệu chỉnh | Vỡ ngân sách p95 + chi phí |
| Dùng Jev hosted (API) | Calibration tốt nhất | Model đóng, trả phí theo request, gửi dữ liệu ra ngoài | PII + chi phí biên |

### Hệ quả
**Tích cực:** nhanh (rule + cache), rẻ (AI chỉ chạy phần nhỏ, offline), calibrated (xác suất nối thẳng vào hợp đồng tin cậy), không rò PII, không phí bản quyền.

**Đánh đổi:**
- Jev gốc là model đóng; bản tự host mở (Plumb-4B / decider / Lichen) **calibration kém hơn một chút** → bù bằng 1 lớp logistic hiệu chỉnh trên golden set GPS bưu tá.
- Vận hành 3 loại model (tagger + decision + LLM) thay vì 1 → agent phụ trách, kỹ sư chỉ duyệt.

**Liên quan:** Proposal01 §5.1–5.4, §7.5; Detail04 §3–4; Detail07 §1; Detail08 §6–7.

---

## ADR-002 — Nguồn dữ liệu & đối chứng nguồn ngoài

- **Trạng thái:** Đề xuất
- **Ngày:** [dd/mm/yyyy]
- **Người quyết định:** [Khối Core-AI]

### Bối cảnh
- Đề án cũ "xác minh chéo tự động với Google 5 triệu địa chỉ/tháng" vi phạm ToS Google (cấm cache >30 ngày, cấm xây CSDL cạnh tranh) — rủi ro pháp lý (Proposal01 §2.2, §13 rủi ro 5).
- Cần con số đối chứng để chứng minh "Google cũng sai ở ngõ/hẻm VN" và để đo hệ thống mới.

### Quyết định
1. **Nguồn dữ liệu nền (0đ):** OSM (đường/ranh giới, ODbL — để **database riêng**) + Overture (building/POI, CDLA-P) + `vietnamadminunits` / `undertheseanlp/address` cho sáp nhập hành chính 63→34 tỉnh (10.602 bản ghi xã/phường).
2. **Ground truth:** GPS "phát thành công" của bưu tá → `delivery_points` (tài sản nội bộ).
3. **Đối chứng ngoài = benchmark mẫu nhỏ, không lưu:** 1.000 địa chỉ/đêm vs Goong + 200 vs Google; chỉ ghi **số accuracy**, không lưu kết quả Google vào bất kỳ DB nào.
4. **Fallback production = Goong duy nhất** (tầng 6, chỉ khi conf < 0,5, có đếm chi phí). Google **không bao giờ** là fallback production.

### Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Vì sao bỏ |
|---|---|---|---|
| Xác minh chéo Google toàn bộ | Đầy đủ | Vi phạm ToS, tốn tiền, Google sai ở VN | Pháp lý + chi phí |
| Không đối chứng ngoài | Đơn giản | Mất con số "Google cũng sai" + mất benchmark khách quan | Yếu luận điểm trình duyệt |

### Hệ quả
**Tích cực:** an toàn pháp lý (ghi rõ trong ADR để truy vết), vẫn có số đối chứng thuyết phục, chi phí < 2 triệu/tháng.

**Đánh đổi:** mẫu Google 200/đêm có nhiễu thống kê → dùng Goong 1.000/đêm làm benchmark chính, Google chỉ để minh hoạ.

**Liên quan:** Proposal01 §4, §8.1–8.2, §9.3, §13 (rủi ro 5); Detail03 §3–4; Detail07 §3.3.

---

## ADR-003 — Bảo vệ dữ liệu cá nhân (hash) & Parser bằng sequence tagger

- **Trạng thái:** Đề xuất
- **Ngày:** [dd/mm/yyyy]
- **Người quyết định:** [Khối Core-AI]

### Bối cảnh
- Địa chỉ + SĐT + tên là dữ liệu cá nhân (NĐ 13/2023). `delivery_points` lưu lâu dài → cần tách phần định danh.
- Grammar regex cho địa chỉ VN phình to theo thời gian (nợ bảo trì — đội cũ từng chậm vì làm tay); cần cách **"tốt, dễ bảo trì"**.

### Quyết định
1. **PII / hash:**
   - `delivery_points` chỉ lưu `addr_norm` (địa chỉ chuẩn hoá, **không có tên/SĐT**); tên/SĐT ở lại hệ thống nguồn, không sao chép vào đây.
   - `addr_hash = md5(addr_norm)` **chỉ để dedup/index**. Nếu cần che địa chỉ ở đầu ra (bảng chia sẻ, log) → dùng **HMAC-SHA256 có khoá**; md5 không dùng để bảo vệ PII (địa chỉ entropy thấp, brute-force được).
2. **Parser = sequence tagger (thay grammar regex):**
   - normalize (rule ổn định) → **PhoBERT-base hoặc char-BiLSTM-CRF** gán nhãn số nhà / ngõ-hẻm / đường / thôn-KĐT / xã-phường / tỉnh → LLM chỉ cho đuôi khó.
   - Retrain hàng đêm từ `delivery_points` + `golden_set` trên RTX 3090 (vòng `parser-retrain`).
   - Bootstrap tuần 4 bằng ~50 rule tay sinh nhãn đầu; từ tuần 5–6 tagger là chính.

### Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Vì sao bỏ |
|---|---|---|---|
| Grammar regex thuần | Không cần GPU/huấn luyện | Phình to, khó bảo trì, sai địa chỉ lạ | Nợ kỹ thuật dài hạn |
| LLM parse trực tiếp | Chính xác | Chậm, đắt, phải gọi API (PII) | Vỡ ngân sách + rò PII |
| md5 cho mục đích bảo vệ PII | Đơn giản | Brute-force được | Yếu bảo mật |

### Hệ quả
**Tích cực:** parser là 1 model duy nhất (dễ retrain, không nợ regex); PII tách rõ tên/SĐT khỏi phần không gian; HMAC khi cần che.

**Đánh đổi:**
- Tagger cần dữ liệu huấn luyện ban đầu → tuần 4 phải có 50 rule tay + golden set đủ.
- Retrain hàng đêm tốn GPU nhưng RTX 3090 dư sức (chạy đêm, không ảnh hưởng request path).

**Liên quan:** Proposal01 §5.3, §8.2.6–7, §8.3; Detail04 §2–3; Detail07 §3.2; Detail08 §1–6.
