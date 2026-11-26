# 06 — Xử lý tiếng Việt cho địa chỉ (playbook)

Đội cũ tốn rất nhiều thời gian cho tiếng Việt. Mục này gom kỹ thuật + thư viện có sẵn (0đ, self-host) để **không phát minh lại bánh xe**.

## 1. Chuẩn hoá chữ (normalize) — đúng cách
- **Không dùng naive `unidecode`**: nó làm mất "đ" (đ→d lẫn với d) và gập dấu không nhất quán.
- Dùng **NFKD decomposition + bảng riêng cho đ/Đ** (đúng cách `undertheseanlp/address` làm): đ→d nhưng có bảng kiểm soát; ă→a, â→a, ê→e, ô→o, ơ→o, ư→u.
- Thư viện: [underthesea](https://github.com/undertheseanlp/underthesea) (`text_norm`), [visen](https://github.com/nguyenthanhhuy/visen) (telex→unicode + bỏ dấu).
- Nguyên tắc: **giữ dấu cho hiển thị** (lưu `addr` gốc), chỉ fold dấu vào `addr_norm` để index/so khớp.

## 2. Viết tắt (abbreviation)
`P.→phường, Q.→quận, H.→huyện, TP./T.P.→thành phố, TX./T.X.→thị xã, TT./T.T.→thị trấn, X.→xã, KP.→khu phố, TDP→tổ dân phố, KCN→khu công nghiệp, KĐT→khu đô thị, CC→chung cư, CHCC→chung cư cao cấp, Đ./Đường, Số`

## 3. Từ vựng vùng miền (synonym — phần "Rule" ổn định, không phình)
- ngõ (Bắc) = hẻm (Nam) = kiệt (Huế) = ngách (Bắc, ngõ nhỏ)
- thôn (Bắc) = ấp (Nam) = xóm = tổ dân phố = khu phố

## 4. Sáp nhập hành chính 2025 (63→34 tỉnh, 3→2 cấp) — có sẵn, đừng tự xây
- [vietnamadminunits](https://pypi.org/project/vietnamadminunits/) (MIT): mapping tỉnh/huyện/xã cũ→mới.
- [undertheseanlp/address](https://huggingface.co/undertheseanlp/address) (Apache-2.0): **10.602 bản ghi mapping xã/phường** (merged/renamed/divided), kèm normalizer + parser + converter sẵn.
- → Dùng làm seed cho `admin_units` + `admin_alias` (schema Detail04 §2). Đây là phần đội cũ làm tay nhiều quý.

## 5. So khớp địa chỉ nhiều âm tiết
- Tiếng Việt là **âm tiết**: "Hai Bà Trưng" là 1 tên đường 3 âm tiết → so khớp theo **syllable n-gram**, không tách từ kiểu tiếng Anh.
- Tách từ: [underthesea word_tokenize](https://github.com/undertheseanlp/underthesea) hoặc [VnCoreNLP](https://github.com/vncorenlp/VnCoreNLP).
- Fuzzy: [rapidfuzz](https://github.com/rapidfuzz/RapidFuzz) trên chuỗi đã `addr_norm`.

## 6. Model gán nhãn (sequence tagger) — lựa chọn dễ bảo trì
- [PhoBERT](https://github.com/VinAIResearch/PhoBERT) (base ~135M, có NER) hoặc char-level BiLSTM-CRF nhỏ (<5ms).
- Huấn luyện trên `delivery_points` + `golden_set` (nhãn tự sinh mỗi đêm), retrain đêm trên **RTX 3090 24GB**.
- Thay grammar regex phình to bằng **1 model duy nhất** → dễ bảo trì, dễ retrain, không nợ kỹ thuật.

## 7. Phân vai pipeline
| Tầng | Công cụ | Loại |
|---|---|---|
| Normalize | NFKD + đ/Đ + viết tắt (underthesea/visen) | Rule ổn định |
| Gán nhãn | PhoBERT / char-BiLSTM tagger | Model nhỏ, retrain đêm |
| Khớp mờ | System One (Jev) + rapidfuzz | Quyết định có xác suất |
| Đuôi khó | LLM Qwen2.5-7B | Sinh cho tail |
