# TÀI LIỆU TRÌNH DUYỆT

## ĐỀ ÁN BẢN ĐỒ SỐ Global — HỆ THỐNG PHÂN GIẢI ĐỊA CHỈ PHỤC VỤ LOGISTICS

**Phiên bản:** 1.0 — Trình duyệt kiến trúc, vận hành, AI Agent, quản trị dữ liệu và kế hoạch 90 ngày
**Đơn vị trình:** [Khối Core – AI]
**Người trình:** [Họ tên]
**Ngày:** [dd/mm/yyyy]
**Cấp duyệt:** [Ban Tổng Giám đốc / Ban Công nghệ]

> **Ghi chú về ảnh minh hoạ:** Mỗi vị trí `[HÌNH x.y]` kèm prompt tạo ảnh (dùng Midjourney / DALL·E / Ideogram / Nano Banana). Các công cụ vẽ chữ tiếng Việt thường lỗi dấu, nên prompt dùng **nhãn tiếng Anh ngắn**; sau khi có ảnh, chèn chú thích tiếng Việt bên dưới trong Word. Prompt nào ghi *(diagram)* nên ưu tiên Ideogram hoặc Nano Banana vì vẽ chữ chính xác hơn.

---

## MỤC LỤC

1. Tóm tắt điều hành
2. Bối cảnh và chẩn đoán hiện trạng
3. Mục tiêu và phạm vi
4. Tham chiếu các hệ thống bản đồ lớn
5. Kiến trúc hệ thống
6. Mô hình vận hành
7. Vận hành bằng AI Agent 24/7
8. Quản trị dữ liệu
9. Hiệu năng, bảo mật và tuân thủ
10. Kế hoạch 90 ngày và việc cần làm
11. Chỉ số đo lường (KPI)
12. Chi phí và nguồn lực
13. Rủi ro và biện pháp
14. Đề xuất phê duyệt

---

## 1. TÓM TẮT ĐIỀU HÀNH

**Vấn đề.** Dự án Bản đồ số đã triển khai nhiều quý với mục tiêu "90–95% chính xác so Google", ngân sách đề xuất 12 tỷ làm giàu dữ liệu và tuyển thêm 4 nhân sự GIS, nhưng chưa có kết quả đo được trên vận hành thực tế. Nguyên nhân gốc: thiếu **bộ dữ liệu chuẩn (golden set)**, thiếu **vòng phản hồi tự động từ bưu tá**, và API không trả **độ tin cậy** để các hệ thống hạ nguồn sử dụng.

**Đề xuất.** Tái định hướng từ "xây bản đồ" sang "xây hệ thống phân giải địa chỉ" trả lời 3 câu hỏi cho 100% đơn hàng: *địa chỉ ở đâu — khách đang gõ gì — từ A đến B bao xa*. Triển khai theo mô hình **Rule + Cache + AI quyết định (Jev/System One, tự host) + AI sinh (LLM)**, dữ liệu mở (OSM, Overture) kết hợp **nhãn miễn phí từ mỗi lần phát thành công**, vận hành bởi **AI Agent 24/7** dưới sự kiểm soát của 1 kỹ sư.

**Kết quả cam kết sau 90 ngày.**
- 1 tỉnh pilot chạy 100% Autocomplete + Geocoding nội bộ, Google chỉ còn là dự phòng.
- Độ chính xác ≥ 90% trong bán kính 200 m, đo trên GPS phát thực.
- Chi phí vận hành < 5% chi phí Google tương đương.
- Hệ thống **tự cải thiện mỗi đêm** mà không cần mua dữ liệu hay tuyển mới.

**Nguồn lực đề nghị.** 1 kỹ sư toàn thời gian, 1 máy chủ 8 vCPU/32 GB + **1 PC workstation RTX 3090 24 GB** (chạy LLM + tagger + model quyết định), ~5 triệu đồng/tháng cho công cụ AI, quyền truy cập log quét phát và GPS bưu tá. **Không** cần ngân sách 12 tỷ và 4 nhân sự theo đề xuất cũ.

**[HÌNH 1.1 — Tổng quan một trang]**

![HÌNH 1.1 — Tổng quan một trang](images/hinh_1_1.jpg)
> *Prompt (diagram):* "Clean executive one-page infographic, white background, corporate red and dark navy palette. Left: a stressed timeline labeled 'Old approach: buy data, hire 4 GIS, compare to Google' with a flat line chart. Right: a rising line chart labeled 'New approach: self-learning from every delivery'. Center: three icons in a row — map pin labeled 'Where?', search box labeled 'Suggest?', route arrow labeled 'How far?'. Bottom banner: '90 days · 1 province · <5% Google cost'. Minimal, flat vector style, no clutter."

---

## 2. BỐI CẢNH VÀ CHẨN ĐOÁN HIỆN TRẠNG

### 2.1 Những gì đã làm (ghi nhận)
- CSDL 213.908 địa chỉ cấp 4, 863.095 địa danh cấp 5 toàn quốc.
- Độ chính xác phân giải địa danh (tỉnh/xã) trên 98%.
- 20 tỉnh hoàn tất chuyển đổi mô hình hành chính 2 cấp.
- Thông luồng tạo đơn trên app/web/API.

Đây là **tài sản** và sẽ được dùng làm dữ liệu khởi tạo (seed) cho hệ thống mới.

### 2.2 Vì sao chưa ra kết quả

| Dấu hiệu | Vấn đề gốc | Hệ quả |
|---|---|---|
| KPI "90% so Google" | Thước đo sai; Google cũng sai ở ngõ/hẻm/tổ/thôn Việt Nam | Không chứng minh được đơn giao thành công hơn |
| Đề xuất 12 tỷ làm giàu 5 triệu địa chỉ/tháng | Mua dữ liệu một lần, không có vòng tự học | Dữ liệu mua xong lại lỗi thời |
| Phạm vi gồm Lidar, camera, thời tiết, địa hình, Deep Learning | Scope quá rộng, không use case nào đi đến cùng | Nhiều quý không có sản phẩm dùng được |
| "Xác minh chéo tự động với Google" | Vi phạm điều khoản Google (cấm cache >30 ngày, cấm xây CSDL cạnh tranh) | Rủi ro pháp lý |
| "Autocomplete 60% → 90%" | Không định nghĩa 90% của chỉ số nào | Không kiểm chứng được |

### 2.3 Tài sản chưa khai thác
Mỗi ngày, hàng vạn bưu tá quét mã "phát thành công" kèm GPS điện thoại. Đây là **nhãn đúng miễn phí** cho từng địa chỉ — tương đương cách GrabMaps dùng GPS tài xế. Hệ thống cũ không sử dụng nguồn này.

### 2.4 Đội cũ đang mất thời gian vào đâu — và cách mới thay thế

Bảng dưới ghi cụ thể **7 việc dữ liệu nặng nhất** mà đề án cũ đang làm (trích từ kế hoạch quý và đề xuất 12 tỷ), vì sao mỗi việc chậm/tốn, cách mới thay thế — kèm **ước tính nhân lực và chi phí tránh được**.

| Việc dữ liệu đội cũ | Vì sao chậm / tốn | Cách mới | Nhân lực tránh được (ước) | Chi phí tránh được (ước/năm) |
|---|---|---|---|---|
| Làm giàu 5 triệu địa chỉ/tháng (đề xuất 12 tỷ) | Mua 1 lần, không vòng phản hồi → lỗi thời | Nhãn GPS "phát thành công" miễn phí, cập nhật mỗi đêm | Không cần đội làm giàu | **~12 tỷ** (bỏ ngân sách đề xuất) |
| Xác minh chéo tự động với Google/Goong | Vi phạm ToS Google; tốn API; Google cũng sai ở ngõ/hẻm VN | Golden set đối chiếu GPS thực; benchmark mẫu ≤200/đêm, không lưu | ~0 (tự động; gánh nặng là tiền + rủi ro pháp lý) | ~20 tỷ/năm (nếu 100% Google) → còn <2 triệu/tháng |
| Chuẩn hoá / nhập tay 213k cấp 4 + 863k cấp 5 | Chậm, dễ sai, cần 4 nhân sự GIS; không scale được | Parser tagger tự lưu trữ (retrain đêm) + LLM cho đuôi khó; agent tự ra PR | **4 GIS (≈640 h/tháng)** | **~1,2 tỷ/năm** (lương 4 GIS) |
| Xe khảo sát / Lidar / camera / xử lý ảnh | Chi phí ≥10 lần; không vào được ngõ/hẻm sâu | Bưu tá = cảm biến, phủ đúng nơi giao hàng | ~2–3 người vận hành khảo sát | ≥10 lần (ước hàng tỷ đồng) |
| Gom nhiều nguồn (TCTK, Bing, vietbando, Azure, Grab…) | Tốn công hợp nhất, bản quyền rắc rối | OSM + Overture + điểm giao nội bộ; 1 nguồn sự thật | ~1–2 người × 3–6 tháng | Bản quyền + tích hợp (ước vài trăm triệu) |
| Làm giàu một lần rồi để đó | Dữ liệu lỗi thời, phải làm lại từ đầu | Vòng phản hồi khép kín hàng đêm | ~0 vĩnh viễn | Tránh lặp lại ~12 tỷ mỗi chu kỳ |
| Routing kèm thời tiết / giao thông / địa hình | Không có nguồn VN đáng tin, ROI chưa đo được | Hoãn; RouteMatrix hub↔hub + hệ số vùng từ GPS | ~1–2 quý R&D | API traffic/thời tiết (ước hàng tỷ nếu làm) |

> **Điểm mấu chốt:** đề án cũ bỏ tiền và người để *mua* dữ liệu rồi lại lỗi thời; cách mới *tạo ra* dữ liệu từ chính mỗi đơn hàng đã giao — dữ liệu càng dùng càng đúng, chi phí biên gần bằng 0.

> **Tổng ước tính năm đầu:** tránh được **~13 tỷ** chi phí trực tiếp (12 tỷ dữ liệu + ~1,2 tỷ lương 4 GIS) và **~7.700 giờ công/năm**, chưa kể chi phí Google (~20 tỷ/năm) giảm dần theo độ phủ nội bộ. Chi phí đề xuất này ≈ **40 triệu/90 ngày**.
>
> *Giả định: lương GIS ~25 triệu/tháng, 1 tháng = 160 h, Google = 5 USD/1.000 geocode (giá chuẩn). Số chính xác đo lại ở tuần 1 (mục 10.1).*

**[HÌNH 2.1 — Chẩn đoán: vòng lặp bị đứt]**

![HÌNH 2.1 — Chẩn đoán: vòng lặp bị đứt](images/hinh_2_1.jpg)
> *Prompt (diagram):* "Two side-by-side flow diagrams, flat vector, white background. LEFT titled 'Current': boxes 'Buy data' → 'Build map' → 'Compare to Google' → dead-end with a red X, caption 'no feedback'. RIGHT titled 'Proposed': circular loop of four boxes 'Courier delivers (GPS scan)' → 'Label address' → 'Improve model' → 'Better geocode' → back to start, green arrows, caption 'self-improving daily'. Corporate red and navy."

**[HÌNH 2.2 — Bưu tá là cảm biến]**

![HÌNH 2.2 — Bưu tá là cảm biến](images/hinh_2_2.jpg)
> *Prompt (illustration):* "Flat vector illustration of a Vietnamese motorbike courier in red uniform scanning a parcel barcode with a smartphone at a house door in a narrow alley; above the phone a glowing GPS pin and a small checkmark; faint dotted lines connecting the pin to a cloud database icon. Warm daylight, clean modern style, no text."

**[HÌNH 2.3 — Trước/sau: công sức làm dữ liệu]**

![HÌNH 2.3 — Trước/sau: công sức làm dữ liệu](images/hinh_2_3.jpg)
> *Prompt (diagram):* "Split before/after comparison, flat vector, white background. LEFT (grey, heavy): a long assembly line of icons 'buy data', 'survey cars', 'Lidar', 'manual data entry', 'cross-check Google' with many dollar signs and hourglasses, a tall red cost bar. RIGHT (colour): a short green loop 'courier GPS scan → delivery_point → better geocode' with a tiny cost bar near zero. Caption 'Same ground truth, zero data cost'. Navy and red."

---

## 3. MỤC TIÊU VÀ PHẠM VI

### 3.1 Mục tiêu
1. **Geocoding:** địa chỉ → toạ độ + mức tin cậy + zone + bưu cục phục vụ.
2. **Autocomplete:** gợi ý đúng trong top-3 ≥ 85% phiên nhập.
3. **Route Matrix:** ma trận khoảng cách/thời gian cho phân tuyến và tính giá, sai lệch ≤ 20%.
4. **Tự cải thiện:** độ chính xác tăng mỗi tuần không cần can thiệp thủ công.

### 3.2 Trong phạm vi (90 ngày)
- 1 tỉnh pilot (đề xuất: tỉnh sản lượng trung bình, không phải HN/HCM).
- 3 API nêu trên, tích hợp OMS (tạo đơn) và hệ thống phân tuyến.
- Hạ tầng dữ liệu, pipeline phản hồi, bộ đánh giá tự động, giám sát.

### 3.3 Ngoài phạm vi (có lý do, ghi vào backlog)

| Hạng mục | Lý do hoãn | Điều kiện mở lại |
|---|---|---|
| Thời tiết / giao thông thời gian thực | Chưa có nguồn dữ liệu VN đáng tin, ROI chưa đo được | Có API traffic chất lượng và bài toán tính giá động |
| Lidar / camera / xe khảo sát | Chi phí gấp ≥10 lần; dữ liệu phát hàng thay thế được 90% nhu cầu | Không mở lại giai đoạn này |
| Mua 5 triệu địa chỉ/tháng | Không có vòng phản hồi; rủi ro ToS | Sau khi độ phủ nội bộ ≥ 80% vẫn thiếu vùng |
| Bản đồ nền hiển thị (tile server) | Không phải nhu cầu logistics cốt lõi | Khi TMS cần giao diện bản đồ |

**[HÌNH 3.1 — Phạm vi: lõi và vòng ngoài]**

![HÌNH 3.1 — Phạm vi: lõi và vòng ngoài](images/hinh_3_1.jpg)
> *Prompt (diagram):* "Concentric circles diagram, flat vector, white background. Inner solid circle labeled 'CORE 90 days' containing three icons: 'Geocode', 'Autocomplete', 'Route Matrix'. Middle ring labeled 'Later' with 'Learning-to-rank', 'Auto zones', 'Nationwide'. Outer dashed ring labeled 'Backlog' with 'Weather', 'Lidar', 'Buy data', 'Base map tiles' shown greyed out. Navy and red accents."

---

## 4. THAM CHIẾU CÁC HỆ THỐNG BẢN ĐỒ LỚN

| Hệ thống | Cách họ có dữ liệu đúng | Bài học áp dụng |
|---|---|---|
| **Google Maps** | Xe khảo sát + hàng tỷ thiết bị Android | Sao chép **hình dạng API** (session token, mức tin cậy ROOFTOP/APPROXIMATE) để đội tích hợp không phải sửa code |
| **GrabMaps** | Nền OSM + **GPS tài xế** + camera hành trình + tài xế gán POI | Bài học quan trọng nhất: đội xe là cảm biến. Bưu tá VTPost = tài xế Grab |
| **AWS Location** | Không tự làm; gom Esri/HERE/Grab sau một API | Kiến trúc **nhiều nguồn theo tầng**: nội bộ trước, bên ngoài khi tin cậy thấp |
| **Mapbox** | OSM + telemetry SDK; stack mở OSRM/Valhalla/Pelias | Toàn bộ engine cần dùng đã có mã nguồn mở đạt chuẩn production |
| **HERE / TomTom** | Xe khảo sát, Lidar | **Không** đi hướng này — đây là bẫy chi phí trong đề xuất cũ |
| **Goong / Vietmap / Map4D** | Khảo sát riêng + OSM | Dùng làm nguồn dự phòng thứ 3 và để đối chứng, không làm nền |
| **OpenStreetMap / Overture Maps** | Cộng đồng / Meta-MS-Amazon-TomTom | Đường, ranh giới, building footprint miễn phí, cập nhật hàng tháng |

**Năm nguyên tắc rút ra:**
1. Dữ liệu chuẩn lấy từ vận hành của chính mình, không mua.
2. Địa chỉ logistics = điểm giao thành công, không phải hình học.
3. Vòng phản hồi phải đóng hàng ngày.
4. Không tự xây cái đã có mã nguồn mở.
5. Có bộ đánh giá chuẩn trước khi viết dòng code đầu tiên.

**[HÌNH 4.1 — So sánh cách tiếp cận]**

![HÌNH 4.1 — So sánh cách tiếp cận](images/hinh_4_1.jpg)
> *Prompt (diagram):* "Horizontal comparison chart, flat vector, white background. Four columns with logos replaced by generic icons: 'Survey cars + Lidar' (expensive, slow, red cost bar tall), 'Crowd telemetry' (Google-like, medium), 'Fleet GPS' (Grab-like, green cost bar short, label 'our choice'), 'Open data' (OSM/Overture, cost bar near zero). Each column shows a cost bar and an accuracy star rating. Title 'How map providers get ground truth'."

---

## 5. KIẾN TRÚC HỆ THỐNG

### 5.1 Nguyên tắc thiết kế
- **Rule → Cache → AI quyết định → AI sinh:** luật xác định trước, cache ở giữa; phần cần *phán đoán có cấu trúc* dùng **System One model tự host** (Jev-compatible: Plumb-4B / decider / Lichen — Apache-2.0), phần cần *sinh văn bản* dùng LLM tự lưu trữ. Cả hai đều **chạy ngoại tuyến**, không nằm trong đường xử lý yêu cầu nóng.
- **Phán đoán trả xác suất hiệu chỉnh** thay vì ngưỡng cứng (tương đồng ≥ 85%): xác suất nối thẳng vào "hợp đồng dùng mức tin cậy" (mục 5.4).
- **Dữ liệu là trung tâm:** PostGIS là nguồn sự thật duy nhất; mọi thành phần khác là chỉ mục dẫn xuất.
- **Mọi câu trả lời đều có độ tin cậy** để hệ thống hạ nguồn quyết định.
- **Mã nguồn mở, không phí bản quyền:** PostGIS, OSRM, OpenSearch, Redis, FastAPI; model quyết định Plumb-4B / decider / Lichen (Apache-2.0).

### 5.2 Sơ đồ tổng thể

```
OMS / App / Web / TMS / Phân tuyến
        │
┌───────▼──────────────────────────────────────────┐
│ API Gateway: khoá API, giới hạn tốc độ,           │
│ session token, request_id, nhật ký kiểm toán     │
└───┬──────────────────┬──────────────────┬────────┘
┌───▼────────┐  ┌──────▼──────────┐  ┌────▼─────────┐
│/autocomplete│  │/geocode         │  │/matrix       │
│OpenSearch   │  │Parser → Resolver│  │OSRM          │
│+ xếp hạng   │  │theo tầng + conf │  │+ cache cặp   │
└───┬────────┘  └──────┬──────────┘  └────┬─────────┘
    └──────────── Redis (cache L1) ────────┘
┌──────────────────────▼───────────────────────────┐
│ PostGIS — nguồn sự thật                           │
│ admin_units · streets · buildings · pois          │
│ delivery_points · zones · address_alias           │
└──────────────────────▲───────────────────────────┘
┌──────────────────────┴───────────────────────────┐
│ Pipeline hàng đêm (cron + agent)                 │
│ GPS phát ⟷ toạ độ đã geocode → nhãn              │
│ đánh giá golden set → báo cáo → PR retrain parser│
└──────────────────────────────────────────────────┘
```

**[HÌNH 5.1 — Kiến trúc tổng thể]**

![HÌNH 5.1 — Kiến trúc tổng thể](images/hinh_5_1.jpg)
> *Prompt (diagram):* "Clean software architecture diagram, isometric flat style, white background, navy and red palette. Top row: four client app icons labeled 'OMS', 'Courier App', 'TMS', 'Routing'. Below: a wide bar labeled 'API Gateway (auth, rate limit, audit)'. Below that three service boxes side by side: 'Autocomplete (OpenSearch)', 'Geocode (Parser → Resolver)', 'Matrix (OSRM)'. A horizontal cylinder labeled 'Redis cache' under them. Bottom center: large database cylinder 'PostGIS — source of truth'. Right side: a loop arrow labeled 'Nightly feedback & eval' from a robot icon back into the database. Thin connector lines, no clutter."

### 5.3 Bộ phân tích địa chỉ (Address Parser)
Quy trình: *chuẩn hoá (luật ổn định) → gán nhãn bằng tagger nhỏ → (không chắc) LLM ngoại tuyến → retrain tagger*.

1. **Chuẩn hoá:** bỏ dấu đúng cách (NFKD + bảng riêng cho đ/Đ, không naive unidecode), chữ thường, mở viết tắt (P. → phường, KĐT, KCN, ngõ/ngách/hẻm/kiệt, tổ/thôn/xóm/ấp).
2. **Sequence tagger (tự lưu trữ, retrain hàng đêm):** PhoBERT-base hoặc char-BiLSTM-CRF gán nhãn số nhà / ngõ-hẻm / đường / thôn-KĐT / xã-phường / tỉnh — thay grammar regex (vốn phình to khó bảo trì). Bootstrap tuần 4 bằng ~50 rule tay sinh nhãn đầu; từ tuần 5–6 tagger là chính.
3. **LLM dự phòng:** chỉ cho ~5–10% tagger không chắc (parse_conf thấp); chạy theo lô hàng đêm, self-host. Kết quả **bổ sung vào tập huấn luyện → retrain tagger** → parser tốt hơn mỗi ngày, không phát sinh nợ regex.

**[HÌNH 5.2 — Parser: luật trước, AI sau]**

![HÌNH 5.2 — Parser: luật trước, AI sau](images/hinh_5_2.jpg)
> *Prompt (diagram):* "Funnel diagram, flat vector, white background. Top: a messy raw address string shown as a tangled ribbon. Stage 1 'Normalize' (clean ribbon). Stage 2 'Tagger (self-hosted)' — 90% flows out to the right as neat labeled boxes 'house no', 'alley', 'street', 'ward', 'province'. Stage 3 'LLM offline' handles the remaining 10% at the bottom, with a dotted arrow curving back up to Stage 2 labeled 'retrain nightly'. Red and navy."

### 5.4 Bộ phân giải toạ độ theo tầng (Resolver cascade)

| Tầng | Điều kiện | Mức | Tin cậy |
|---|---|---|---|
| 0 | Có trong Redis | cached | như gốc |
| 1 | Khớp chính xác điểm đã phát thành công ≥ 2 lần, GPS hội tụ < 60 m | ROOFTOP | 0,95 |
| 2 | Khớp mờ điểm đã phát: System One chấm "cùng địa chỉ?" trên N ứng viên cùng xã → xác suất hiệu chỉnh | ROOFTOP | theo xác suất |
| 3 | Số nhà + đường: nội suy theo building hoặc tuyến đường | RANGE_INTERPOLATED | 0,70–0,80 |
| 4 | Chỉ có đường / POI / thôn trong xã | GEOMETRIC_CENTER | 0,50 |
| 5 | Tâm xã/phường | APPROXIMATE | 0,30 |
| 6 | Nguồn ngoài (Goong) — chỉ khi tin cậy < 0,5 **và** hệ thống gọi cho phép; có đếm chi phí | EXTERNAL | theo nguồn |

**Hợp đồng dùng mức tin cậy (giao cho OMS / phân tuyến):**

| Mức tin cậy | Hành động hạ nguồn |
|---|---|
| ≥ 0,70 | Tự động gán bưu cục/zone, không cần xác nhận |
| 0,50 – 0,69 | Tự động gán nhưng gắn cờ "bưu tá xác nhận khi phát"; GPS phát chảy ngược thành nhãn mới |
| < 0,50 | Gọi nguồn ngoài (nếu được phép) hoặc chuyển xác nhận bằng gọi điện/chat; không tự gán |

> Đây là điểm bán cốt lõi: **độ tin cậy không để trang trí** — nó là cầu dao quyết định luồng xử lý, và mỗi lần bưu tá xác nhận là một nhãn mới chảy ngược về `delivery_points`.

**[HÌNH 5.3 — Cascade phân giải]**

![HÌNH 5.3 — Cascade phân giải](images/hinh_5_3.jpg)
> *Prompt (diagram):* "Vertical waterfall / staircase diagram, flat vector, white background. Six steps descending left to right, each a rounded box with a confidence badge: 'Cache 1.0', 'Delivered points 0.95', 'Fuzzy match 0.85', 'Interpolate on street 0.75', 'Ward centroid 0.30', 'External API (paid) <0.5 only'. Green shading fades to orange to red as confidence drops. A small coin icon only on the last step labeled 'cost'. Title 'Try cheapest & most reliable first'."

### 5.5 Autocomplete
- Chỉ mục OpenSearch gồm điểm đã phát + đường + POI, phân tích không dấu, edge-ngram.
- Xếp hạng theo: tần suất phát thành công, khoảng cách tới người dùng, cùng xã/phường với người gửi.
- Ghi lại phiên nhập (chuỗi gõ → lựa chọn → kết quả phát) để làm dữ liệu học xếp hạng sau này.
- **Chống vòng lặp "phổ biến càng phổ biến":** cộng hệ số khám phá (epsilon-greedy) cho địa chỉ mới/chưa có lịch sử phát — nếu không, địa chỉ hiếm không bao giờ xuất hiện trong gợi ý và top-3 sẽ tự mãn ở các điểm cũ.
- V1 chỉ dùng 3 đặc trưng trên (không cần model); phiên nhập lưu lại là dữ liệu cho learning-to-rank vòng sau, **không phải điều kiện khởi động**.

### 5.6 Ma trận khoảng cách
- OSRM trên dữ liệu OSM Việt Nam, hai hồ sơ phương tiện: xe máy (vào hẻm) và xe tải.
- Tính trước hàng đêm các cặp hub↔hub, bưu cục↔bưu cục; cache theo ô lưới ~150 m.
- Dự phòng khi OSRM quá tải: khoảng cách đường chim bay × hệ số vùng, **học hàng đêm từ GPS bưu tá** (quãng đường thực tế / đường chim bay theo từng ô lưới); ô đủ mẫu → hệ số riêng, chưa đủ mẫu → hệ số toàn tỉnh.
- **Rủi ro lớn nhất toàn đề án:** OSM yếu ở ngõ/hẻm sâu nên last-mile có thể lệch nhiều. Vì vậy ma trận V1 cam kết ở mức **hub↔hub / bưu cục↔bưu cục**; last-mile từng đơn đi bằng tầng điểm giao (mục 5.4), không phụ thuộc OSRM.

**[HÌNH 5.4 — Luồng một yêu cầu geocode]**

![HÌNH 5.4 — Luồng một yêu cầu geocode](images/hinh_5_4.jpg)
> *Prompt (diagram):* "Sequence-style flow, left to right, flat vector, white background. 'OMS creates order' → 'API Gateway' → 'Parser' → 'Resolver cascade' → 'Response: lat/lng + confidence + zone + post office' → 'Routing system assigns courier'. Below the last step a dotted arrow 'courier scans delivery (GPS)' loops back to a database icon 'delivery_points'. Clock icons show '<150 ms'. Navy and red."

### 5.7 Zone phục vụ (bưu cục) — học từ điểm giao
- Mỗi `delivery_point` mang mã bưu cục phát thành công → nhãn zone miễn phí, không cần vẽ tay.
- Hàng đêm: gom điểm giao theo bưu cục → dựng polygon phục vụ (hull, loại nhiễu) → ghi `zones` kèm `valid_from/to`.
- Khi geocode: trả `zone + bưu cục phục vụ` bằng truy vấn điểm-trong-đa giác kèm độ tin cậy; vùng tranh chấp giữa 2 bưu cục → gắn cờ điều chuyển.
- Đầu ra này nối thẳng vào **Smart Sorting / phân tuyến theo zone** của đề án cũ — thứ bản đồ 1.0 chưa làm được từ dữ liệu thực.

---

## 6. MÔ HÌNH VẬN HÀNH

### 6.1 Chu trình hàng ngày

| Giờ | Việc | Thực hiện bởi |
|---|---|---|
| 01:00 | Lấy quét phát 24 h qua, đối chiếu toạ độ đã geocode, cập nhật `delivery_points`, tính độ chính xác theo tỉnh/bưu cục | Pipeline tự động |
| 02:00 | Gom địa chỉ khó, LLM gán nhãn, **retrain tagger, mở PR kèm bảng đánh giá trước/sau** | Agent |
| 03:00 | Đối chứng mẫu 1.000 địa chỉ với Goong (và Google mẫu 200, không lưu) | Pipeline tự động |
| 07:00 | Báo cáo sáng: độ chính xác, chi phí, vùng tụt, PR chờ duyệt | Agent → Telegram/Slack |
| 08:30 | Duyệt PR (10–30 phút) | Kỹ sư |
| Liên tục | Cảnh báo Grafana → agent phân tích log → tạo issue có sẵn chẩn đoán | Agent |
| Thứ 6 | Demo 15 phút cho lãnh đạo | Kỹ sư |
| Thứ 2 | Báo cáo tuần tự động | Agent |

### 6.2 Quy trình thay đổi
- Mọi thay đổi vào nhánh riêng → PR → CI (unit test, đánh giá golden set, load test nhẹ) → duyệt bởi kỹ sư → merge.
- PR làm giảm độ chính xác bị từ chối **tự động**.
- Agent không có quyền ghi vào production; chỉ làm việc trên bản sao staging.

### 6.3 Phát hành
- Shadow mode (chạy song song, không ảnh hưởng người dùng) → 1% → 10% → 100% tỉnh pilot.
- Mỗi bước có điều kiện bật/tắt bằng cấu hình, rollback trong 1 phút.

**[HÌNH 6.1 — Chu trình 24 giờ]**

![HÌNH 6.1 — Chu trình 24 giờ](images/hinh_6_1.jpg)
> *Prompt (diagram):* "Circular 24-hour clock diagram, flat vector, white background. Around the clock face, icons at: 01:00 'Ingest delivery scans', 02:00 'Agent retrains tagger → PR', 03:00 'Benchmark sample', 07:00 'Morning report', 08:30 'Engineer reviews (30 min)', daytime 'Serve traffic + monitor', Friday badge 'Demo'. Robot icon for automated steps, person icon for the single human step. Navy and red."

**[HÌNH 6.2 — Phát hành theo bậc]**

![HÌNH 6.2 — Phát hành theo bậc](images/hinh_6_2.jpg)
> *Prompt (diagram):* "Staircase rollout diagram, flat vector. Steps labeled 'Shadow (0% impact)', '1% traffic', '10% traffic', '100% pilot province', each with a small gate icon labeled 'accuracy ≥ target?' and a 'rollback in 1 min' arrow pointing down. Google logo replaced by a generic cloud labeled 'external fallback' shrinking at each step."

---

## 7. VẬN HÀNH BẰNG AI AGENT 24/7

### 7.1 Phân vai người – agent

| Giai đoạn | Agent làm | Kỹ sư làm |
|---|---|---|
| Nghiên cứu | Đọc tài liệu OSRM/Valhalla/Pelias/Overture, so sánh, viết bản ghi quyết định kiến trúc (ADR) | Chốt quyết định |
| Lập kế hoạch | Sinh đặc tả API, kế hoạch kiểm thử, chia việc thành issue | Cắt phạm vi, sắp ưu tiên |
| Xây dựng | Viết code theo đặc tả + test, migration, cấu hình chỉ mục, docker | Review; làm cùng ở phần khó (resolver) |
| Dữ liệu | Gán nhãn địa chỉ khó theo lô, retrain tagger, PR có test | Duyệt/từ chối PR |
| Kiểm thử | Sinh biến thể địa chỉ (lỗi gõ, không dấu, viết tắt, đảo thứ tự), chạy hồi quy hàng đêm | Định nghĩa golden set ban đầu |
| Dùng thử sớm | Chạy shadow, so sánh, báo cáo sáng | Quyết định tăng % lưu lượng |
| DevOps | CI/CD, hạ tầng dạng mã, nhận cảnh báo → phân tích → mở issue | Trực sự cố thực sự |
| Cải tiến | Theo dõi xu hướng, tìm vùng tụt, đề xuất ưu tiên | Demo, báo cáo |

### 7.2 Bốn vòng lặp agent

1. **Phản hồi hàng đêm** — không dùng LLM, thuần SQL/Python: đối chiếu GPS phát với toạ độ đã trả, cập nhật điểm giao, tính KPI.
2. **Retrain parser** — dùng LLM tự lưu trữ gán nhãn địa chỉ khó → bổ sung vào tập huấn luyện → retrain tagger (PhoBERT/char-BiLSTM) → PR kèm eval trước/sau.
3. **Đối chứng mẫu** — 1.000 địa chỉ/đêm so với nguồn ngoài, không lưu kết quả bên ngoài.
4. **Xử lý cảnh báo** — sự kiện từ Grafana → agent đọc log → chẩn đoán → issue.

### 7.3 Rào chắn an toàn
- File quy tắc cố định cho agent trong repo: đọc kiến trúc trước, test trước code, không gọi API ngoài ngoài module cho phép, không log dữ liệu cá nhân, không merge vào main.
- Bảo vệ nhánh main: chỉ merge qua PR + CI xanh + 1 người duyệt.
- Agent chỉ có thông tin đăng nhập staging.
- Trần chi phí LLM API: 5 USD/ngày, ngắt tự động.
- **Plan-mode mặc định:** agent đề xuất thay đổi (PR + bảng trước/sau), không tự áp dụng; với parser/resolver (phần nhạy cảm) agent chỉ làm trên staging và cần 1 người duyệt.
- **Đánh giá chéo:** PR của agent do một agent thứ hai phản biện (adversarial review) trước khi đến người — lọc PR yếu, người chỉ cần duyệt.
- **Runtime 24/7 headless:** dùng CLI không tương tác (Claude Code `-p` / agent runner / DSH harness) gắn cron; không phụ thuộc editor mở tay.

### 7.4 Công cụ và chi phí

| Vai trò | Công cụ | Chi phí/tháng |
|---|---|---|
| Agent lập trình | Claude Code / Cursor | 2,5–5 triệu đồng |
| LLM tách địa chỉ theo lô | Qwen2.5-7B tự lưu trữ trên RTX 3090 24 GB (hoặc API giá rẻ) | 0–1,3 triệu đồng |
| Model quyết định (System One) | Plumb-4B / decider-2B / Lichen tự host trên RTX 3090 24 GB | 0 |
| CI/CD, lịch chạy, cảnh báo | GitHub/GitLab CI, cron, Grafana | 0 |

> **Ghi chú Jev:** Jev của TypeSafe là model đóng (chỉ qua API, không có weights). Bản **tự host** là các model nói cùng giao thức `/v1/systemone` (Plumb-4B, decider, Lichen, Laya), trên JevBench 1.4.2 đã vượt Jev về tốc độ/chi phí, thua nhẹ về *calibration*. Dùng để **chấm quyết định có cấu trúc** (khớp mờ, chọn zone, phân loại cảnh báo); việc *sinh* văn bản vẫn là LLM.

### 7.5 So sánh model quyết định tự host (Jev-compatible)

| Model | Tham số / nền | License | Phần cứng | Độ trễ | JevBench 1.4.2 |
|---|---|---|---|---|---|
| **Plumb-4B** | 4B — huấn luyện trên quyết định khó (2–16 lựa chọn) | Apache-2.0 | ≈ 8–16 GB (đo trên RTX 4080 Super) | 1 lượt (one-pass) | **65,8** — top bảng mở |
| **decider** | 2B–35B-A3B — fine-tune từ Qwen3.5 | Apache-2.0 | ~4 GB (bản 2B) | 1 lượt (one-pass) | 64,1 (bản 4B v2) |
| **Lichen** | 26B-A4B (MoE, nền Gemma 4) | open weights (nền Gemma) | ≈ 16 GB (GPU laptop) | ~93 ms (trung vị) | 207/231 quyết định JevBench (tự công bố) |
| **Laya** | 421M / 322M encoder | Apache-2.0 | CPU / GPU rất nhỏ | 1 lượt (non-autoregressive) | không nằm top-5 |

> **Khuyến nghị chọn:** dev/demo trên Mac → **Lichen** (MLX) hoặc **OpenJev**; production → **decider-2B** (4 GB, chung GPU với Qwen) hoặc **Plumb-4B** nếu được cấp GPU 16 GB; hoàn toàn không có GPU → **Laya 421M** chạy CPU. Cả 4 đều cần **hiệu chỉnh xác suất trên golden set GPS bưu tá** (một lớp logistic nhỏ) — vì *calibration* là điểm các model mở thua Jev gốc. Số JevBench là của [JevBench](https://github.com/fstandhartinger/jevbench) (Benchmark Heaven, độc lập với TypeSafe), bản 1.4.2.

**[HÌNH 7.1 — Người và agent trong một ngày]**

![HÌNH 7.1 — Người và agent trong một ngày](images/hinh_7_1.jpg)
> *Prompt (illustration):* "Flat vector illustration, white background. Center: one engineer at a desk with a single laptop, calm. Around them, six small friendly robot icons each holding a labeled card: 'Research', 'Write code + tests', 'Retrain tagger', 'Run benchmarks', 'Watch alerts', 'Write report'. Arrows from robots to a tray on the desk labeled 'PRs to review'. One arrow from the engineer labeled 'approve'. Clock showing 24h. Navy, red, soft grey."

**[HÌNH 7.2 — Retrain tagger từ nhãn mỗi đêm]**

![HÌNH 7.2 — Retrain tagger từ nhãn mỗi đêm](images/hinh_7_2.jpg)
> *Prompt (diagram):* "Retraining loop diagram, flat vector. Left: a cloud labeled 'LLM (offline, costly)' labeling a pile of 'hard addresses'. Middle: a database icon labeled 'training set grows nightly'. Right: a small model icon labeled 'Tagger (retrained, fast)' plugging into a machine labeled 'Parser'. Caption arrow 'parser improves every week, no regex debt'."

**[HÌNH 7.3 — Rào chắn an toàn]**

![HÌNH 7.3 — Rào chắn an toàn](images/hinh_7_3.jpg)
> *Prompt (diagram):* "Pipeline with gates, flat vector, white background. Boxes left to right: 'Agent branch' → gate 'Unit tests' → gate 'Golden-set eval must not drop' → gate 'Load test p95' → gate 'Human review' → 'main / production'. Each gate a barrier icon; a rejected PR shown bouncing back at gate 2 with a red arrow. A padlock on 'production DB' with label 'agent has no access'."

---

## 8. QUẢN TRỊ DỮ LIỆU

### 8.1 Phân loại và nguồn

| Lớp dữ liệu | Nguồn | Giấy phép | Chủ sở hữu | Cập nhật |
|---|---|---|---|---|
| Đơn vị hành chính 2 cấp + ánh xạ cũ→mới | Văn bản Nhà nước, TCTK, dữ liệu nội bộ 20 tỉnh | Công khai | Khối Core-AI | Khi có nghị quyết mới |
| Đường, ranh giới | OpenStreetMap (Geofabrik) | ODbL | Cộng đồng | Hàng tuần |
| Building, POI | Overture Maps | CDLA-P 2.0 | Overture | Hàng tháng |
| Địa chỉ cấp 4/5 (213k / 863k) | Đội Bản đồ 1.0 | Nội bộ | VTPost | Seed một lần |
| **Điểm giao thành công (delivery_points)** | Quét phát + GPS bưu tá | Nội bộ, tài sản cốt lõi | VTPost | **Hàng đêm** |
| Nhật ký geocode / phiên autocomplete | Hệ thống mới | Nội bộ | VTPost | Thời gian thực |
| Golden set đánh giá | Trích từ delivery_points, 1.000 địa chỉ/tỉnh | Nội bộ | Khối Core-AI | Hàng quý |

### 8.2 Nguyên tắc
1. **Một nguồn sự thật:** PostGIS. OpenSearch, Redis, OSRM là bản dẫn xuất, có thể xoá và dựng lại.
2. **Tách biệt dữ liệu mở và dữ liệu nội bộ.** OSM để ở **database riêng** (không chỉ bảng riêng), chỉ kết hợp lúc truy vấn. ODbL chỉ kích hoạt chia sẻ ngược khi **phân phối công khai** cơ sở dữ liệu dẫn xuất — dùng nội bộ thì không phát sinh nghĩa vụ; đồ thị routing (OSRM từ OSM) và dữ liệu kết hợp là *derivative*, không phân phối ra ngoài. Ưu tiên Overture (CDLA-P) cho đường/building để giảm gánh nặng pháp lý.
3. **Mọi bản ghi có nguồn gốc (lineage):** trường `source`, `valid_from/to`, `request_id`.
4. **Chất lượng đo tự động:** độ hội tụ GPS, số lần phát thành công/thất bại, độ tin cậy; không nhập tay.
5. **Dữ liệu cá nhân:** địa chỉ + SĐT + tên là dữ liệu cá nhân theo Nghị định 13/2023. Không gửi thô ra mô hình bên ngoài; mask trước khi xử lý; không ghi SĐT/tên vào log.
6. **Lưu giữ:** nhật ký geocode 180 ngày; delivery_points vĩnh viễn, chỉ lưu `addr_norm` (không chứa tên/SĐT — đó mới là phần định danh cần tách); nếu cần tách PII nghiêm ngặt hơn, hash bằng HMAC-SHA256 có khoá (md5 chỉ để dedup/index, không dùng để bảo vệ PII); sao lưu PostGIS hàng ngày, giữ 14 bản.
7. **Toạ độ + địa chỉ chuẩn hoá vẫn là dữ liệu cá nhân** (NĐ 13/2023): "ẩn danh hoá" không đồng nghĩa xoá địa chỉ — tách phần định danh (tên/SĐT) khỏi phần không gian, và không cho agent/LLM đọc bảng thô chưa mask.
8. **Đối chứng nguồn ngoài:** mẫu ≤ 1.000/đêm, không lưu kết quả Google, ghi rõ trong ADR.

### 8.3 Lọc nhãn từ GPS bưu tá
- Chỉ nhận quét có trạng thái "phát thành công".
- Loại quét cách tâm xã/phường > 2 km hoặc độ chính xác GPS > 100 m.
- Một địa chỉ cần ≥ 2 lần phát, GPS hội tụ < 60 m mới được xếp mức ROOFTOP.
- Đề xuất bổ sung nút "ghim vị trí" 1 chạm trong app bưu tá để tăng chất lượng nhãn (không chờ, không phải điều kiện tiên quyết).

**[HÌNH 8.1 — Bản đồ dữ liệu]**

![HÌNH 8.1 — Bản đồ dữ liệu](images/hinh_8_1.jpg)
> *Prompt (diagram):* "Layered data map, flat vector, white background. Four stacked translucent layers viewed at an angle like map sheets: bottom 'Open data: OSM roads, Overture buildings' (grey), 'Admin units 2-level + old→new mapping' (blue), 'Internal seed: 213k / 863k addresses' (navy), top 'Delivery points from courier GPS — grows daily' (red, glowing pins). A lock icon on the top two layers labeled 'internal'. Title 'One source of truth: PostGIS'."

**[HÌNH 8.2 — Vòng đời một địa chỉ]**

![HÌNH 8.2 — Vòng đời một địa chỉ](images/hinh_8_2.jpg)
> *Prompt (diagram):* "Lifecycle timeline, flat vector. 'Customer types address' → 'Parsed + geocoded (confidence 0.5)' → 'Courier delivers, GPS scan' → 'Night pipeline compares' → 'delivery_point created (confidence 0.95)' → 'Next order same address: instant ROOFTOP'. Confidence badge grows from orange to green along the timeline."

**[HÌNH 8.3 — Bảo vệ dữ liệu cá nhân]**

![HÌNH 8.3 — Bảo vệ dữ liệu cá nhân](images/hinh_8_3.jpg)
> *Prompt (diagram):* "Simple flow, flat vector. 'Raw order: name, phone, address' → box 'Mask: remove name & phone, keep address structure' → 'Self-hosted LLM (inside company)' with a building icon and a fence; a crossed-out arrow toward 'Public cloud LLM'. Shield icon labeled 'Decree 13/2023'."

---

## 9. HIỆU NĂNG, BẢO MẬT VÀ TUÂN THỦ

### 9.1 Mục tiêu hiệu năng

| API | p95 | Cách đạt |
|---|---|---|
| /autocomplete | < 80 ms | OpenSearch 1 shard/tỉnh, cache tiền tố 60 s |
| /geocode (cache miss) | < 150 ms | Chỉ mục trigram + không gian, regex biên dịch sẵn |
| /geocode (cache hit) | < 10 ms | Redis |
| /matrix 100×100 | < 2 s | OSRM MLD, cache cặp |

Kiểm tra tải tự động hàng đêm (k6); vượt 20% ngưỡng → CI thất bại.

### 9.2 Bảo mật
- Khoá API theo từng hệ thống gọi; giới hạn tốc độ; danh sách IP nội bộ.
- Mọi yêu cầu có `request_id` và `order_id` để truy vết; không ghi SĐT/tên.
- Bí mật qua Vault/SOPS; CSDL không mở ra ngoài mạng container.
- Agent không có thông tin đăng nhập production.

### 9.3 Tuân thủ
- Điều khoản Google Maps: không cache > 30 ngày, không xây CSDL từ kết quả Google, không hiển thị trên bản đồ khác.
- ODbL (OSM): giữ dữ liệu nội bộ tách bảng; không phân phối dữ liệu dẫn xuất ra ngoài.
- Overture: ghi nguồn (attribution).
- Nghị định 13/2023 về dữ liệu cá nhân: như mục 8.2.

### 9.4 Giám sát
Bảng Grafana 1 trang: độ chính xác hôm nay, chi phí tiết kiệm luỹ kế, phân bố mức tin cậy, số lần gọi nguồn ngoài (= tiền), vùng tụt. Cảnh báo tự động → agent chẩn đoán.

**[HÌNH 9.1 — Bảng điều khiển mẫu]**

![HÌNH 9.1 — Bảng điều khiển mẫu](images/hinh_9_1.jpg)
> *Prompt (UI mockup):* "Dark-theme monitoring dashboard mockup, 16:9. Top-left large line chart 'Accuracy @200m — daily' with three lines: 'Internal' rising, 'Google sample' flat, 'Map 1.0' flat lower. Top-right big number card '₫ saved this month'. Middle: stacked bar 'Confidence distribution' green/yellow/red. Bottom-left: latency p95 gauges for three APIs all green. Bottom-right: small table 'Top 5 wards needing attention'. Clean Grafana-like style."

**[HÌNH 9.2 — Lớp bảo mật]**

![HÌNH 9.2 — Lớp bảo mật](images/hinh_9_2.jpg)
> *Prompt (diagram):* "Castle-wall style layered security diagram, flat vector. Outer wall 'Internal network + IP allowlist', second wall 'API keys + rate limit per system', third 'Audit log with request_id', inner keep 'PostGIS, secrets in vault'. A small robot outside the inner keep with label 'agent: staging only'."

---

## 10. KẾ HOẠCH 90 NGÀY VÀ VIỆC CẦN LÀM

### 10.1 Lộ trình theo tuần

| Tuần | Cột mốc | Kết quả cầm được |
|---|---|---|
| 0 | Quyền truy cập dữ liệu, máy chủ, chọn tỉnh pilot, chốt KPI | 3 bản ghi quyết định kiến trúc; văn bản cấp quyền |
| 1 | **Golden set + đo đối chứng** | Con số: "Bản đồ 1.0 đạt X%, Google đạt Y% trên 1.000 địa chỉ có GPS thực" |
| 2 | Nền dữ liệu | Môi trường chạy bằng 1 lệnh; OSM, Overture, hành chính 2 cấp, 213k/863k địa chỉ đã nạp |
| 3 | Pipeline phản hồi + bộ đánh giá | `delivery_points` tự lớn mỗi đêm; đánh giá chạy trong CI |
| 4 | Parser v1 | Tách được ≥ 85% địa chỉ tỉnh pilot |
| 5 | Resolver theo tầng + API /geocode | Độ chính xác ≥ Bản đồ 1.0 trên golden set |
| 6 | Shadow 1% lưu lượng OMS | Bảng điều khiển độ chính xác và chi phí theo ngày |
| 7 | Autocomplete v1 | Top-3 ≥ 75% ngoại tuyến |
| 8 | A/B tại 2 bưu cục | Top-3 ≥ 85%; thời gian tạo đơn giảm |
| 9 | OSRM + /matrix | Sai lệch ≤ 20% ở ≥ 85% cặp |
| 10 | Vòng lặp retrain parser + xử lý cảnh báo | ≥ 5 PR parser/tuần có bảng trước/sau; cảnh báo Grafana → issue kèm chẩn đoán < 10 phút |
| 11 | 100% tỉnh pilot | Google chỉ còn dự phòng khi tin cậy < 0,5 |
| 12 | Báo cáo + kế hoạch nhân rộng | Số liệu tiết kiệm thực tế; lộ trình 10 tỉnh tiếp theo |

### 10.2 Điểm kiểm tra dừng/điều chỉnh
- **Cuối tuần 3:** nếu không đối chiếu được GPS quét ↔ đơn hàng cho ≥ 70% đơn → thiếu dữ liệu chuẩn → ưu tiên sửa app bưu tá trước.
- **Cuối tuần 6:** nếu độ chính xác < Bản đồ 1.0 → dừng mở rộng, tập trung parser 2 tuần.

### 10.3 Việc cần làm ngay (tuần 0) — cần sự hỗ trợ của cấp duyệt

| # | Việc | Người phụ trách | Hạn | Trạng thái |
|---|---|---|---|---|
| 1 | Cấp quyền đọc log quét phát (mã đơn, thời gian, GPS, bưu tá, bưu cục) từ VTMan/E2 | Khối CNTT / Vận hành | T0 | ☐ |
| 2 | Cấp quyền đọc bảng đơn hàng (địa chỉ thô, tỉnh/xã đã chọn, trạng thái phát) | Khối CNTT | T0 | ☐ |
| 3 | Cấp 1 máy chủ 8 vCPU / 32 GB / 500 GB SSD, Docker, mở HTTPS ra ngoài | Hạ tầng | T0 | ☐ |
| 4 | Phê duyệt chi phí công cụ AI ~5 triệu/tháng | Tài chính | T0 | ☐ |
| 5 | Chốt tỉnh pilot | Ban Vận hành | T0 | ☐ |
| 6 | Chốt bộ KPI mới (mục 11) thay cho "so Google" | Cấp duyệt | T0 | ☐ |
| 7 | Chỉ định đầu mối OMS để bật shadow traffic tuần 6 | Khối Sản phẩm | T4 | ☐ |
| 8 | Chỉ định 2 bưu cục tham gia A/B autocomplete | Ban Vận hành | T7 | ☐ |

**[HÌNH 10.1 — Lộ trình 90 ngày]**

![HÌNH 10.1 — Lộ trình 90 ngày](images/hinh_10_1.jpg)
> *Prompt (diagram):* "Horizontal Gantt-style roadmap, 12 columns labeled W0–W12, flat vector, white background. Swimlanes: 'Data foundation' (W1–W3), 'Geocode' (W4–W6), 'Autocomplete' (W7–W8), 'Route matrix' (W9), 'Agent loops' (W10), 'Pilot 100%' (W11), 'Report' (W12). Milestone diamonds at W1 'Baseline numbers', W6 'Shadow live', W11 'Province live'. Two red checkpoint flags at W3 and W6 labeled 'go/no-go'. Navy bars, red milestones."

**[HÌNH 10.2 — Tuần 0: bốn thứ cần cấp]**

![HÌNH 10.2 — Tuần 0: bốn thứ cần cấp](images/hinh_10_2.jpg)
> *Prompt (illustration):* "Four flat icons in a row on white: a document with a key labeled 'Data access', a server rack labeled '1 server 8 vCPU/32 GB', a small coin stack labeled '~5M VND/month AI tools', a map with one highlighted province labeled 'Pilot province'. Caption 'Week 0 prerequisites'. Clean, minimal."

---

## 11. CHỈ SỐ ĐO LƯỜNG (KPI)

| # | KPI | Định nghĩa | Baseline | Mục tiêu T+90 |
|---|---|---|---|---|
| 1 | **Độ chính xác @200 m** | % địa chỉ golden có toạ độ cách GPS phát ≤ 200 m | Đo tuần 1 | ≥ 90% |
| 2 | Độ chính xác @50 m | Như trên, ≤ 50 m | Đo tuần 1 | ≥ 70% |
| 3 | **Độ phủ nội bộ** | % yêu cầu tin cậy ≥ 0,7 không cần nguồn ngoài | 0% | ≥ 80% |
| 4 | **Chi phí / 1 triệu yêu cầu** | Hạ tầng + AI + nguồn ngoài | Google ≈ 5 USD/1.000 geocode | < 5% Google |
| 5 | Tiết kiệm luỹ kế | Số lần gọi ngoài tránh được × đơn giá Google | 0 | Báo cáo số thực |
| 6 | **Autocomplete top-3** | % phiên chọn 1 trong 3 gợi ý đầu | ~60% | ≥ 85% |
| 7 | Thời gian tạo đơn | Trung vị từ ký tự đầu → chọn địa chỉ | Đo | Giảm ≥ 30% |
| 8 | **Phát thất bại do sai địa chỉ** | Tỉ lệ tại tỉnh pilot | Đo | Giảm ≥ 20% tương đối |
| 9 | Sai lệch ma trận | % cặp lệch ≤ 20% | Đo | ≥ 85% |
| 10 | Tốc độ tự cải thiện | Δ độ chính xác/tuần, không can thiệp thủ công | — | > 0 liên tục 8 tuần |
| 11 | PR do agent đề xuất được duyệt | Số PR/tuần | 0 | ≥ 5 |

Tất cả KPI tính **tự động** từ pipeline và giám sát; không có số nhập tay.

**[HÌNH 11.1 — KPI cũ vs mới]**

![HÌNH 11.1 — KPI cũ vs mới](images/hinh_11_1.jpg)
> *Prompt (diagram):* "Side-by-side cards, flat vector. LEFT card greyed, titled 'Old KPI': '90% vs Google' with a question mark and caption 'not measurable, not tied to delivery'. RIGHT card in colour, titled 'New KPIs': four icons with labels 'Accuracy vs real GPS', 'Cost per 1M requests', 'Failed deliveries due to wrong address', 'Improves weekly without manual work'. Green check marks."

---

## 12. CHI PHÍ VÀ NGUỒN LỰC

| Hạng mục | Đề xuất cũ | Đề xuất này |
|---|---|---|
| Nhân sự | Tuyển thêm 4 GIS | 1 kỹ sư hiện có + AI agent |
| Làm giàu dữ liệu | 12 tỷ đồng | 0 đồng (dữ liệu mở + nhãn từ phát hàng) |
| Hạ tầng | Chưa rõ | 1 máy 8 vCPU/32 GB + 1 PC workstation RTX 3090 24 GB (đã có) |
| Công cụ AI | — | ~5 triệu/tháng |
| Nguồn ngoài (đối chứng) | 100% Google | < 2 triệu/tháng, mẫu nhỏ |
| **Tổng 90 ngày** | ≫ 12 tỷ + lương 4 người | **≈ 30–40 triệu đồng** + lương 1 người |

> **Kiểm tra công suất sớm (tuần 2–3):** đo tải thực 1 máy 8 vCPU/32 GB cho tỉnh pilot (geocode + autocomplete). Nếu đồ thị OSRM MLD toàn quốc ngốn RAM, tách sang máy thứ 2 hoặc chỉ nạp đồ thị vùng. Đây là lý do "1–2 máy": máy 2 dành cho OSRM, không phải dự phòng thừa.

Lợi ích tài chính kỳ vọng: tiến tới thay thế phần lớn chi phí Google (đề xuất cũ ước tính 20 tỷ/năm nếu dùng 100% Google), đo được theo ngày từ tuần 6.

**[HÌNH 12.1 — So sánh chi phí]**

![HÌNH 12.1 — So sánh chi phí](images/hinh_12_1.jpg)
> *Prompt (diagram):* "Two bar columns, flat vector, white background. Left tall red bar labeled 'Old proposal: 12B VND data + 4 hires', right tiny navy bar labeled 'This proposal: ~40M VND + 1 engineer + AI agents'. A dotted green line above both labeled 'Google spend avoided: up to 20B/yr'. Minimal."

---

## 13. RỦI RO VÀ BIỆN PHÁP

| # | Rủi ro | Xác suất | Tác động | Biện pháp |
|---|---|---|---|---|
| 1 | Không được cấp log GPS quét phát | Cao | Dừng dự án | Xin bằng văn bản tuần 0; đây là điều kiện tiên quyết |
| 2 | GPS bưu tá nhiễu / quét sau khi rời điểm | Cao | Nhãn sai | Lọc hội tụ < 60 m, ≥ 2 lần phát; đề xuất nút "ghim vị trí" |
| 3 | Địa chỉ cũ/mới sau sáp nhập hành chính lẫn lộn | Chắc chắn | Parser sai hàng loạt | Bảng ánh xạ cũ→mới có hiệu lực theo thời gian; test riêng |
| 4 | OSM yếu ở ngõ/hẻm sâu | Cao | Nội suy, routing kém last-mile | Bù bằng điểm giao thực tế (tầng 1–2) và hệ số vùng |
| 5 | Vi phạm điều khoản Google khi đối chứng | Trung bình | Pháp lý | Mẫu ≤ 1.000, không lưu, ghi trong ADR |
| 6 | Dữ liệu cá nhân ra mô hình ngoài | Trung bình | Pháp lý/uy tín | Mask bắt buộc; ưu tiên tự lưu trữ; CI chặn |
| 7 | Phụ thuộc 1 người | Chắc chắn | Gián đoạn | Toàn bộ trong repo + tài liệu + runbook; demo hàng tuần |
| 8 | Bị kéo lại scope cũ | Cao | Mất tập trung | Backlog có lý do; KPI đã chốt; yêu cầu mới → sau 90 ngày |
| 9 | Agent làm giảm chất lượng âm thầm | Trung bình | Hồi quy | Đánh giá trong CI, PR không có bảng trước/sau bị từ chối |
| 10 | OMS chưa bật shadow kịp | Trung bình | Thiếu số thật | Thương lượng tuần 4; dự phòng phát lại log ngoại tuyến |
| 11 | Phản ứng từ đội cũ | Trung bình | Cản trở | Ghi nhận dữ liệu họ làm là seed; mời review golden set; nói bằng số liệu |

**[HÌNH 13.1 — Ma trận rủi ro]**

![HÌNH 13.1 — Ma trận rủi ro](images/hinh_13_1.jpg)
> *Prompt (diagram):* "2×2 risk matrix, flat vector, white background, axes 'Likelihood' and 'Impact'. Top-right red cell: 'No GPS access', 'Admin merge old/new names'. Top-left orange: 'Noisy GPS', 'Scope creep'. Bottom-right orange: 'Google ToS', 'PII leak'. Bottom-left green: 'Single server load', 'OMS delay'. Each item a small labeled dot with a shield icon for 'mitigated'."

---

## 14. ĐỀ XUẤT PHÊ DUYỆT

Kính đề nghị cấp duyệt thông qua:

1. **Tái định hướng** dự án Bản đồ số 2.0 theo kiến trúc và phạm vi tại mục 3, 5.
2. **Bộ KPI mới** tại mục 11, thay thế chỉ tiêu "90–95% so Google".
3. **Mô hình vận hành bằng AI Agent** tại mục 6–7, với rào chắn an toàn đã nêu.
4. **Chính sách quản trị dữ liệu** tại mục 8, đặc biệt việc khai thác GPS quét phát làm dữ liệu chuẩn.
5. **Nguồn lực** tại mục 12: 1 kỹ sư, 1 máy chủ 8 vCPU/32 GB + 1 PC RTX 3090 24 GB, ~5 triệu/tháng công cụ AI; tạm dừng đề xuất 12 tỷ và tuyển 4 nhân sự cho đến khi có kết quả pilot.
6. **8 việc tuần 0** tại mục 10.3, trong đó quyền truy cập dữ liệu (việc 1–2) là điều kiện tiên quyết.

Báo cáo tiến độ: demo 15 phút thứ 6 hàng tuần; báo cáo tự động thứ 2 hàng tuần; điểm kiểm tra go/no-go cuối tuần 3 và tuần 6; báo cáo tổng kết tuần 12.

**[HÌNH 14.1 — Ảnh kết]**

![HÌNH 14.1 — Ảnh kết](images/hinh_14_1.jpg)
> *Prompt (illustration):* "Flat vector hero illustration, white background. A stylised map of Vietnam in light grey with one province highlighted in red labeled 'Pilot', glowing pins spreading outward along a dotted path to other provinces labeled 'next 10'. In the corner a small robot and a person shaking hands. Caption area blank. Modern, optimistic, corporate red and navy."

| | Người lập | Người kiểm tra | Người phê duyệt |
|---|---|---|---|
| Họ tên | | | |
| Chức vụ | | | |
| Chữ ký / Ngày | | | |

---

## PHỤ LỤC A — Danh mục prompt ảnh (tổng hợp để tạo một lượt)

| Mã | Vị trí | Loại | Công cụ gợi ý |
|---|---|---|---|
| 1.1 | Tóm tắt | Infographic | Ideogram / Nano Banana |
| 2.1 | Vòng lặp đứt vs khép kín | Diagram | Ideogram |
| 2.2 | Bưu tá quét mã | Illustration | Midjourney / DALL·E |
| 2.3 | Trước/sau: công sức dữ liệu | Diagram | Ideogram |
| 3.1 | Phạm vi vòng tròn | Diagram | Ideogram |
| 4.1 | So sánh nhà cung cấp | Diagram | Ideogram |
| 5.1 | Kiến trúc tổng thể | Diagram | Nano Banana / Ideogram |
| 5.2 | Parser phễu | Diagram | Ideogram |
| 5.3 | Cascade bậc thang | Diagram | Ideogram |
| 5.4 | Luồng một yêu cầu | Diagram | Ideogram |
| 6.1 | Đồng hồ 24 h | Diagram | Ideogram |
| 6.2 | Phát hành theo bậc | Diagram | Ideogram |
| 7.1 | Người và agent | Illustration | Midjourney / DALL·E |
| 7.2 | Chưng cất AI → luật | Diagram | Ideogram |
| 7.3 | Rào chắn an toàn | Diagram | Ideogram |
| 8.1 | Lớp dữ liệu | Diagram | Nano Banana |
| 8.2 | Vòng đời địa chỉ | Diagram | Ideogram |
| 8.3 | Bảo vệ dữ liệu cá nhân | Diagram | Ideogram |
| 9.1 | Dashboard mockup | UI | Nano Banana / DALL·E |
| 9.2 | Lớp bảo mật | Diagram | Ideogram |
| 10.1 | Gantt 90 ngày | Diagram | Ideogram |
| 10.2 | Bốn thứ cần cấp | Icons | DALL·E |
| 11.1 | KPI cũ vs mới | Diagram | Ideogram |
| 12.1 | So sánh chi phí | Diagram | Ideogram |
| 13.1 | Ma trận rủi ro | Diagram | Ideogram |
| 14.1 | Ảnh kết | Illustration | Midjourney |

**Hậu tố dùng chung cho mọi prompt** (dán thêm vào cuối để đồng bộ phong cách): `--style flat vector, white background, corporate palette red #E3000F and navy #1B2A49, minimal, no gradients, high contrast, 16:9`

## PHỤ LỤC B — Thuật ngữ

| Thuật ngữ | Giải thích ngắn |
|---|---|
| Geocoding | Chuyển địa chỉ dạng chữ thành toạ độ |
| Autocomplete | Gợi ý địa chỉ khi người dùng đang gõ |
| Route Matrix | Bảng khoảng cách/thời gian giữa nhiều điểm |
| Golden set | Bộ địa chỉ đã biết toạ độ đúng, dùng để chấm điểm hệ thống |
| Confidence | Mức tin cậy (0–1) của kết quả |
| ROOFTOP / APPROXIMATE | Mức độ chính xác theo chuẩn Google: tới nóc nhà / chỉ gần đúng |
| delivery_points | Bảng điểm giao thành công, học từ GPS bưu tá |
| PostGIS / OSRM / OpenSearch / Redis | CSDL không gian / engine dẫn đường / công cụ tìm kiếm / bộ nhớ đệm — đều mã nguồn mở |
| OSM / Overture | Dữ liệu bản đồ mở |
| Agent | Chương trình AI tự thực hiện chuỗi việc (đọc, viết code, kiểm thử) dưới quy tắc định sẵn |
| System One / Jev | Model quyết định có cấu trúc (Choice/Score/Noul) trả xác suất hiệu chỉnh thay vì văn bản; Jev là model gốc của TypeSafe (đóng), bản tự host là Plumb-4B / decider / Lichen (Apache-2.0) |
| PR | Yêu cầu gộp mã nguồn, phải được người duyệt |
| Shadow mode | Chạy song song để so sánh, không ảnh hưởng người dùng |
| ADR | Bản ghi quyết định kiến trúc |