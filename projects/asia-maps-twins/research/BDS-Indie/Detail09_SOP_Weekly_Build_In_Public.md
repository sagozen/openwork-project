# Detail09 — Quy trình Chuẩn hoá (SOP) Hàng tuần cho Indie Maker: Build-in-Public & YouTube Factory (Dự án Bản đồ số 2.0)

> **Mục tiêu kép:** Vừa duy trì nhịp độ code & nghiên cứu từng module nhỏ của hệ thống **Bản đồ số 2.0 (Logistics Address Resolution)** trong 90 ngày (12 tuần), vừa biến chính quá trình làm việc thực tế thành **24 video YouTube** (12 video Founder Brand + 12 video Product Marketing) với thời gian sản xuất nội dung tối thiểu nhờ chu trình 4 bước xử lý trực tiếp trên mây.

---

## 1. Triết lý "Micro-Research → Code → Proof Video"

Dựa trên bộ tài liệu nghiên cứu (`Detail01` → `Detail08`, `ADR_week0`, `Proposal01`), mỗi tính năng của hệ thống đều tuân thủ nguyên tắc: **Data-first (Golden Set) → Rule → Cache → AI Quyết định (System One) → AI Sinh (LLM Offline)** và **Mọi PR đều có bảng Eval Before/After**.

Thay vì đợi 90 ngày mới làm video giới thiệu, mỗi tuần được chia thành **3 hạt nhân nhỏ (Micro-Units)** từ Thứ 2 đến Thứ 6:
1. **Giả thuyết & Chẩn đoán (Hypothesis/ADR):** Tại sao cách cũ (regex phình to, mua dữ liệu, gọi Google trực tiếp) thất bại?
2. **Thực thi Code & Hạ tầng (Implementation):** Cấu hình Docker/PostGIS/OpenSearch/OSRM, viết rule chuẩn hoá tiếng Việt (`NFKD + đ/Đ`), huấn luyện tagger trên RTX 3090, hoặc tối ưu vòng lặp `nightly-feedback`.
3. **Bằng chứng Đo lường (Eval Proof):** Chạy `make eval` / `make load` (k6), chụp màn hình bảng `before/after` (`acc@200m`, `p95 latency`, `cache_hit_ratio`, tiền tiết kiệm).

Chính **Bảng Eval Before/After** và **Terminal/Grafana Screenshot** là "bằng chứng sống" (Proof of Work) cho cả 2 dòng video mỗi cuối tuần.

---

## 2. Chu trình 4 Bước Hàng Tuần Lưu Trữ & Xử Lý Trực Tiếp Trên Mây

### Bước 1: Thu thập dữ liệu "Small Wins" (Thứ 2 – Thứ 6)
- **Công cụ:** 1 file Google Docs cố định theo tuần (ví dụ: `BDS2.0_Week04_Log`) hoặc ghi chú nhanh trên Google Keep ghim cố định, đồng bộ đám mây.
- **Quy tắc "5 Phút Cuối Ca" & "Trigger Gạch Đầu Dòng":** Không viết văn hoàn chỉnh trong lúc đang code. Hễ gặp 1 trong 4 sự kiện sau, lập tức gạch đầu dòng 1–2 câu + dán thẳng ảnh chụp màn hình (`Cmd+Shift+4` trên Mac) vào Google Docs:
  1. **Tối ưu Database / PostGIS / OpenSearch:** Ví dụ tạo index `gist(geom)` hoặc `addr_hash`, giảm query từ 120ms xuống 8ms.
  2. **Fix bug Logistics / Địa chỉ Tiếng Việt:** Ví dụ xử lý lỗi `unidecode` làm mất chữ `đ/Đ`, chuẩn hoá `ngõ/ngách/hẻm/kiệt` hoặc ánh xạ sáp nhập hành chính 63→34 tỉnh (`10.602 xã/phường`).
  3. **Cấu hình Docker / K3s / Agent Ops:** Ví dụ đóng gói `docker-compose` 1 lệnh `make up` trên máy 8 vCPU/32GB RAM, hoặc cấu hình cron `02:00` trên workstation RTX 3090 24GB tự động retrain PhoBERT/BiLSTM tagger và mở PR.
  4. **Con số Eval / Benchmark đột phá:** Bất kỳ khi nào `make eval` nhảy số (ví dụ `acc@200m` tăng từ 62% lên 78%, hoặc phát hiện Google Maps sai ở hẻm sâu trong khi `delivery_points` từ GPS bưu tá đúng trong bán kính 15m).
- **Template Gạch Đầu Dòng Nhanh trong Google Docs:**
  ```text
  [Thứ X - Module: Parser/PostGIS/Docker/OSRM]
  - Vấn đề gặp phải: ...
  - Cách giải quyết (1 dòng code/kiến trúc): ...
  - Kết quả đo được (Before -> After): ...
  - [Dán Screenshot Terminal / PR / Grafana / Bản đồ ngay bên dưới]
  ```

### Bước 2: Chuẩn hóa kịch bản với Gemini Pro (Sáng Thứ 7: 08:30 – 09:30)
- **Thao tác:** Mở Gemini Pro, đính kèm trực tiếp file Google Docs nhật ký tuần qua từ Google Drive.
- **Prompt chuẩn hóa (Copy & Paste mỗi sáng Thứ 7):**
  ```text
  Dựa trên các ghi chú làm việc tuần qua của tôi trong file Google Docs đính kèm (thuộc dự án Bản đồ số 2.0 - Hệ thống phân giải địa chỉ phục vụ Logistics theo kiến trúc Rule -> Cache -> System One AI -> LLM Offline), hãy lập 2 kịch bản video ngắn (thời lượng 3–6 phút/video) kèm Timecode dự kiến để chia chương YouTube:

  1. VIDEO 1 - GÓC NHÌN KỸ THUẬT & TƯ DUY KIẾN TRÚC (Founder Brand - Quay One-Take):
  - Mục tiêu: Chia sẻ bài học thực chiến của một Solo Indie Maker / Kỹ sư hệ thống khi giải bài toán lớn bằng tài nguyên tinh gọn (1 server 8c/32GB + 1 RTX 3090, 0đ mua dữ liệu).
  - Cấu trúc:
    + [00:00] Hook (Nêu nghịch lý hoặc sai lầm phổ biến mà các đội lớn thường mắc, ví dụ đốt tiền mua API/dữ liệu hoặc lạm dụng LLM trong request path).
    + [00:45] Bài toán thực tế gặp phải trong tuần qua & tư duy đánh đổi (Trade-off / ADR).
    + [02:30] Cách giải quyết bằng kiến trúc tối giản & con số kết quả thực tế (Before/After).
    + [04:00] Bài học rút ra cho anh em Developer / Indie Maker & Call-to-action.
  - Định dạng đầu ra: Gạch đầu dòng các ý chính (Bullet points) ngắn gọn, tự nhiên để tôi nhìn lướt và nói one-take trước camera, không viết thành văn đọc thuộc lòng.

  2. VIDEO 2 - DEMO TÍNH NĂNG & CHỨNG MINH KẾT QUẢ (Product Marketing - Dựng trên Google Vids):
  - Mục tiêu: Chứng minh hệ thống hoạt động thực tế bằng dữ liệu thật, độ trễ thật và độ chính xác thật (Proof of Work).
  - Cấu trúc chia theo từng Scene (Cảnh) để kéo thả vào Google Vids:
    + Cột 1: Thời lượng & Tên Scene (ứng với YouTube Chapters).
    + Cột 2: Visual / Screenshot cần chèn (chỉ rõ lấy ảnh chụp màn hình nào từ file Docs: Terminal, API JSON response, Grafana dashboard, hay bảng so sánh eval).
    + Cột 3: Text hiển thị trên slide (ngắn gọn dưới 10 chữ).
    + Cột 4: Lời bình (Voiceover script) mạch lạc, gãy gọn để đưa vào tính năng tạo giọng đọc AI trên Google Vids.
  ```

### Bước 3: Render và Lồng tiếng trên Mây (Chiều Thứ 7: 14:00 – 16:00)
- **3.1. Với Video 1 — Founder Brand (30–45 phút):**
  - Mở kịch bản Bullet points trên màn hình hoặc điện thoại.
  - Dùng điện thoại hoặc webcam quay **một mạch (one-take)** tại bàn làm việc (có thể để màn hình phía sau hiện sơ đồ kiến trúc `Detail04_architecture.md` hoặc Grafana/Terminal).
  - Upload thẳng file video từ điện thoại/máy tính lên thư mục Google Drive `YouTube_BDS_Indie/Week_XX/`. Không cắt ghép cầu kỳ để giữ sự chân thực của Indie Maker.
- **3.2. Với Video 2 — Product Marketing trên Google Vids (45–60 phút):**
  - Mở **Google Vids** trong Google Workspace → Chọn template kỹ thuật/sản phẩm sạch sẽ.
  - Kéo thả cấu trúc Scene từ kịch bản Gemini vừa tạo.
  - Chèn trực tiếp các ảnh chụp màn hình (Screenshots) từ Google Docs/Drive tuần qua vào từng Scene (ví dụ: JSON trả về `confidence: 0.95`, bảng `make eval`, đồ thị Grafana).
  - Sử dụng tính năng **AI Voiceover** tích hợp sẵn trong Google Vids để sinh giọng đọc tự động cho từng Scene theo cột Lời bình.
  - Export video trực tiếp về Google Drive. (Hạn mức Google Workspace/AI hiện tại đáp ứng dư dả nhu cầu xuất vài chục video/tháng).

### Bước 4: Tối ưu phân phối trên YouTube Studio (Chiều Thứ 7: 16:00 – 17:00)
- Truy cập **YouTube Studio**, upload 2 video trực tiếp từ Google Drive/máy.
- Dùng tính năng **AI của YouTube Studio** ( kết hợp Timecode đã chuẩn bị ở Bước 2) để tự động chia chương (**Auto Chapters**), giúp tăng thời gian xem (Retention) và chuẩn SEO tìm kiếm kỹ thuật.
- Đặt lịch công chiếu cố định:
  - **Video 1 (Founder Brand):** Tối Chủ Nhật hoặc Sáng Thứ 2 (truyền cảm hứng đầu tuần cho cộng đồng Developer/Founder).
  - **Video 2 (Product Marketing / System Proof):** Trưa Thứ 4 hoặc Thứ 5 (chứng minh năng lực kỹ thuật & sản phẩm giữa tuần).

---

## 3. Lộ trình Chia Nhỏ Nghiên Cứu 12 Tuần: Vừa Code Vừa Làm Video (24 Tập)

Bảng dưới đây chia nhỏ toàn bộ tài liệu nghiên cứu (`Detail01` → `Detail08`, `ADR_week0`, `Proposal01`) thành các hạng mục nghiên cứu – code theo từng tuần, gắn sẵn chủ đề cho 2 video mỗi tuần để bạn dùng ngay:

| Tuần | Hạng mục Nghiên cứu & Code (Thứ 2 – Thứ 6) | Bằng chứng Cầm Được (Screenshots cho Google Docs) | Video 1: Góc nhìn Kỹ thuật / Founder Brand (One-Take) | Video 2: Demo Sản phẩm / Product Marketing (Google Vids) |
|---|---|---|---|---|
| **Tuần 0** | **Chẩn đoán & Chốt Kiến trúc (`ADR_week0`, `Detail02`):** Viết 3 ADR (Rule→Cache→AI; Nguồn dữ liệu 0đ; Bảo mật PII & Tagger). Xin quyền đọc log GPS phát hàng & chuẩn bị máy 8c/32GB + RTX 3090. | Sơ đồ kiến trúc ASCII trong `Detail04`; Bảng so sánh 7 việc tốn 12 tỷ của cách cũ vs cách mới (`Proposal01 §2.4`). | *Tại sao tôi từ bỏ tư duy "Xây Bản Đồ 12 Tỷ" để làm hệ thống phân giải địa chỉ 0 đồng mua dữ liệu?* | *Kiến trúc Bản đồ số 2.0: Giải quyết 100% đơn hàng Logistics với Rule, Cache và Local AI.* |
| **Tuần 1** | **Golden Set & Baseline (`Detail05`, `Detail06`):** Viết script lọc 1.000 địa chỉ có ≥3 lần phát thành công, GPS hội tụ `<50m`. Chạy benchmark đối chứng với hệ thống 1.0 và mẫu 200 địa chỉ Google/Goong. | Kết quả truy vấn SQL tạo `golden_set`; Bảng điểm `acc@200m` và `acc@50m` thực tế của Google vs nội bộ. | *Đừng viết 1 dòng code AI nào trước khi có Golden Set: Cú lừa mang tên "Chính xác 90% so với Google Maps".* | *Benchmark thực tế trên 1.000 điểm giao hàng: Khi GPS bưu tá đánh bại Google Maps trong ngõ hẻm Việt Nam.* |
| **Tuần 2** | **Data Foundation & Docker (`Detail03`, `Detail04`):** Dựng `docker-compose` (PostGIS 3.4, OpenSearch 2.x, Redis 7). Ingest OSM (`vietnam-latest.osm.pbf`), Overture buildings/POIs và bảng sáp nhập hành chính 63→34 tỉnh (`10.602 xã/phường`). | Terminal chạy `make up` 1 lệnh lên toàn bộ stack; Bảng PostGIS `admin_units`, `streets`, `buildings` đã nạp đầy dữ liệu. | *Cách tôi nhét toàn bộ dữ liệu bản đồ Việt Nam vào 1 con server 32GB RAM không tốn 1 xu tiền bản quyền.* | *Demo Data Pipeline: Tích hợp OpenStreetMap, Overture Maps và 10.602 đơn vị hành chính mới vào PostGIS.* |
| **Tuần 3** | **Feedback Pipeline & Eval Harness (`Detail07`):** Xây dựng cron `nightly-feedback` (01:00 sáng) tự động join GPS quét phát với `geocode_log`, cập nhật `delivery_points` và chạy `make eval` trong CI. | Log chạy `nightly-feedback`; Bảng `delivery_points` tự tăng số lượng nhãn `ROOFTOP` sau 1 đêm; GitHub/GitLab CI chặn PR giảm điểm. | *Biến hàng vạn bưu tá thành cảm biến bản đồ miễn phí: Học tập mô hình triệu đô của GrabMaps.* | *Cận cảnh đường ống dữ liệu tự học mỗi đêm (Nightly Feedback Loop): Đơn giao càng nhiều, hệ thống càng khôn.* |
| **Tuần 4** | **Xử lý Tiếng Việt & Parser v1 (`Detail08`):** Viết tầng `normalize` bằng `NFKD + đ/Đ` (thay `unidecode`), từ điển viết tắt & vùng miền (`ngõ/ngách/hẻm/kiệt`), 50 rule đầu tay và bootstrap PhoBERT/char-BiLSTM tagger. | Bảng test 300 địa chỉ tiếng Việt viết tắt/không dấu/lộn xộn được tách JSON sạch sẽ với `parse_conf ≥ 0.5` đạt ≥85%. | *Nỗi ám ảnh xử lý địa chỉ tiếng Việt: Tại sao Grammar Regex luôn phình to thành nợ kỹ thuật và cách tôi thay bằng 1 model nhỏ.* | *Demo Address Parser Tiếng Việt: Bóc tách chuẩn xác ngõ, ngách, hẻm, kiệt, thôn, ấp chỉ trong vài mili-giây.* |
| **Tuần 5** | **Resolver Cascade & Hợp đồng Tin cậy (`Detail04 §4`):** Code 6 tầng phân giải (Redis → Delivery Points → System One Fuzzy → Building Interpolation → Centroid → External) kèm `confidence` score và API `/geocode`. | JSON response của `/geocode` trả về `ROOFTOP (0.95)` trong `<10ms` (hit) và `<150ms` (miss); Biểu đồ Prometheus. | *Tại sao LLM không bao giờ được nằm trong Request Path nóng? Nghệ thuật thiết kế Cascade 6 tầng và Hợp đồng độ tin cậy.* | *Demo API Geocoding 6 tầng: Phản hồi dưới 10ms kèm điểm tin cậy giúp tự động gán bưu cục phát hàng.* |
| **Tuần 6** | **Shadow Mode 1% & Grafana Observability (`Detail04 §9`):** Bật middleware nhận 1% shadow traffic thực tế, dựng Grafana Dashboard 1 trang theo dõi accuracy ngày, phân bố confidence và tiền tiết kiệm. | Ảnh chụp Grafana Dashboard thực tế sau 72h chạy shadow; Bảng so sánh chi phí thực tế với đơn giá $5/1k của Google. | *Cách triển khai hệ thống mới vào Production mà rủi ro bằng 0: Chiến thuật Shadow Traffic và bài kiểm tra sống còn ở Tuần 6.* | *Tour tham quan Dashboard Giám sát Thời gian thực: Đo đếm từng đồng chi phí Google API tiết kiệm được mỗi giờ.* |
| **Tuần 7** | **Autocomplete Engine v1 (`Detail04 §5`):** Cấu hình OpenSearch `edge_ngram` + `icu_folding`, viết hàm xếp hạng theo `popularity + proximity + same_ward` và thuật toán `epsilon-greedy` chống thiên kiến phổ biến. | Giao diện/API gõ thử 3–4 ký tự không dấu nhảy ra đúng địa chỉ trong `<80ms`; Log phiên gõ (`session_token`). | *Bẫy "Phổ biến càng phổ biến" trong Search Engine: Cách tôi dùng Epsilon-Greedy để địa chỉ mới không bị chôn vùi.* | *Demo Autocomplete Siêu tốc (<80ms): Gợi ý trúng đích trong Top-3 chỉ sau vài phím gõ không dấu.* |
| **Tuần 8** | **A/B Testing Autocomplete & Learning-to-Rank (`Detail05`):** Thử nghiệm tại 2 bưu cục, thu thập log `(keystrokes → chosen_id → kết quả phát)` và tinh chỉnh trọng số `function_score` đạt Top-3 hit ≥ 85%. | Biểu đồ so sánh thời gian tạo đơn giữa 2 bưu cục A/B (giảm ≥30% thời gian gõ); Tỷ lệ Top-3 hit vượt mốc 85%. | *Đem code ra thực địa: Tôi đã rút ngắn 30% thời gian tạo đơn cho nhân viên bưu cục bằng dữ liệu hành vi như thế nào?* | *Kết quả A/B Testing thực tế: Nâng tỷ lệ gợi ý đúng Top-3 từ 60% lên trên 85% với Learning-to-Rank.* |
| **Tuần 9** | **OSRM Route Matrix & Hệ số Vùng GPS (`Detail04 §6`):** Build OSRM với 2 profile `motorbike.lua` (vào hẻm) và `truck.lua`, precompute `hub↔hub` và học hệ số `k_region` từ GPS thực tế. | Bảng benchmark 10.000 cặp toạ độ trong `<2 giây`; So sánh lộ trình xe máy đi xuyên hẻm vs ô tô. | *Tại sao thuật toán tìm đường của nước ngoài hay chỉ xe máy Việt Nam đi vào đường cụt? Tối ưu OSRM cho hẻm Việt Nam.* | *Demo Route Matrix 100x100 dưới 2 giây: Tính khoảng cách và phân tuyến xe máy/xe tải chuẩn xác cho Logistics.* |
| **Tuần 10** | **AI Agent Ops 24/7: Tự động Retrain & Mở PR (`Detail07`):** Kích hoạt vòng lặp `parser-retrain` (02:00 sáng dùng Qwen2.5-7B trên RTX 3090 gán nhãn đuôi khó → retrain tagger → Claude Code mở PR) và `alert-triage`. | Ảnh chụp Pull Request do AI Agent tự tạo lúc 02:15 sáng kèm bảng `eval before/after`; Cảnh báo Grafana tự thành Issue. | *Một kỹ sư vận hành hệ thống bằng 4 vòng lặp AI Agent 24/7: Ngủ dậy thấy Agent đã tự train lại model và mở PR chờ duyệt.* | *Trình diễn AI Agent tự động sửa lỗi địa chỉ khó lúc 2 giờ sáng trên RTX 3090 mà không rò rỉ dữ liệu cá nhân (NĐ 13/2023).* |
| **Tuần 11** | **Auto-Zone Polygon & Cutover 100% Tỉnh Pilot (`Proposal01 §5.7`):** Tự động gom cụm `delivery_points` dựng đa giác vùng phục vụ (`zones`) cho từng bưu cục, chạy load test `k6` và bật 100% traffic tỉnh pilot. | Bản đồ Polygon vùng phục vụ bưu cục tự sinh từ điểm GPS; Kết quả `k6` load test xanh toàn bộ. | *Vẽ ranh giới bưu cục không cần nhân viên GIS: Để dữ liệu GPS tự khắc hoạ bản đồ vùng phục vụ (Auto-Zone).* | *Cột mốc 100% Traffic Tỉnh Pilot: Vượt qua bài kiểm tra tải k6 và cắt giảm hơn 95% sự phụ thuộc vào API bản đồ ngoại.* |
| **Tuần 12** | **Tổng kết 90 Ngày & Playbook Nhân Rộng (`Detail05`, `Detail06`):** Chạy `weekly-report` tổng hợp 12 tuần, đóng gói quy trình mở rộng sang 10 tỉnh tiếp theo chỉ bằng cấu hình dữ liệu (không sửa code). | Báo cáo 1 trang tổng kết 12 KPI (`acc@200m ≥ 90%`, `cost < 5% Google`, số PR do Agent tạo); Slide 5 trang. | *Tổng kết 90 ngày Solo Indie Maker xây Bản đồ số 2.0: Tiết kiệm hàng chục tỷ đồng bằng dữ liệu thực và AI tự vận hành.* | *Báo cáo Toàn diện Bản đồ số 2.0 sau 90 ngày: Từ con số 0 đến hệ thống tự học mỗi đêm sẵn sàng nhân rộng toàn quốc.* |

---

## 4. Lịch Biểu Mẫu Trong Tuần (Time-Blocking cho Indie Maker)

Để không bao giờ bị "ngợp" giữa việc viết code và làm YouTube, bạn chỉ dành đúng **3,5 giờ mỗi tuần** cho toàn bộ khâu sản xuất video (tất cả dồn vào Thứ 7):

| Thời gian | Hoạt động | Công cụ trên Mây | Thời lượng cho Video |
|---|---|---|---|
| **Thứ 2 – Thứ 6 (Hàng ngày)** | Code theo lộ trình tuần + Duyệt PR của Agent (08:30 sáng). Cuối ngày gạch đầu dòng 3–5 ý + dán screenshot vào Docs. | VS Code / Cursor / Claude Code + **Google Docs / Keep** | **5 phút / ngày** (25 phút/tuần) |
| **Thứ 6 (Chiều)** | Chạy `make eval` chốt số liệu tuần & Demo nội bộ 15 phút. Chụp màn hình bảng kết quả cuối tuần bỏ vào Docs. | Terminal + Grafana + **Google Docs** | **10 phút** |
| **Thứ 7 (08:30 – 09:30)** | **Bước 2:** Đẩy file Google Docs tuần vào **Gemini Pro** bằng Prompt chuẩn hoá để xuất 2 kịch bản (Founder + Product). | **Google Docs + Gemini Pro** | **60 phút** |
| **Thứ 7 (14:00 – 14:45)** | **Bước 3A:** Quay **One-Take** Video 1 (Founder Brand) bằng điện thoại/webcam dựa trên bullet points, upload lên Drive. | Điện thoại/Webcam + **Google Drive** | **45 phút** |
| **Thứ 7 (14:45 – 15:45)** | **Bước 3B:** Mở **Google Vids**, kéo thả kịch bản Video 2, chèn screenshots từ Docs, bật **AI Voiceover** và render. | **Google Vids + Google Drive** | **60 phút** |
| **Thứ 7 (15:45 – 16:30)** | **Bước 4:** Upload cả 2 video lên **YouTube Studio**, bật AI Auto-Chapters, điền tiêu đề/thumbnail và hẹn giờ đăng. | **YouTube Studio** | **45 phút** |
| **Chủ Nhật** | Nghỉ ngơi hoàn toàn; hệ thống `nightly-feedback` và `parser-retrain` tự chạy ngầm trên server & RTX 3090. | Cron + AI Agent | **0 phút** |
