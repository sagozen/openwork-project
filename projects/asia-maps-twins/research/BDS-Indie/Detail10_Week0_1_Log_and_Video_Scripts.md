# Detail10 — Nhật Ký Làm Việc Tuần 0–1 (Small Wins Log) & Kịch Bản Chi Tiết 2 Video Đầu Tiên

> Tài liệu này bao gồm:
> 1. **Nhật ký làm việc mẫu Tuần 0 & Tuần 1** (theo chuẩn Bước 1 của SOP — gạch đầu dòng các "chiến thắng nhỏ" kèm vị trí dán ảnh chụp màn hình).
> 2. **Kịch bản chi tiết 2 Video đầu tiên** (theo chuẩn Bước 2 & Bước 3 của SOP — 1 video Founder Brand quay One-Take và 1 video Product Marketing dựng trên Google Vids).

---

## PHẦN 1: NHẬT KÝ LÀM VIỆC TUẦN 0 & TUẦN 1 (SMALL WINS LOG)

### A. Nhật ký Tuần 0: Chẩn đoán Bài toán, Chốt 3 Quyết định Kiến trúc (ADR) & Chuẩn bị Hạ tầng
*(Mục tiêu tuần 0: Chốt 3 ADR nền tảng trước khi viết code, xin quyền đọc log quét phát GPS & đơn hàng, chuẩn bị máy chủ 8 vCPU/32GB RAM + PC Workstation RTX 3090 24GB, chốt KPI vận hành mới)*

#### [Thứ 2 – Module: Chẩn đoán & Định nghĩa lại bài toán (`Detail02_diagnosis.md`)]
- **Vấn đề gặp phải:** Đội cũ đặt mục tiêu "chính xác 90% so với Google Maps", đề xuất ngân sách 12 tỷ đồng để mua/làm giàu 5 triệu địa chỉ/tháng và tuyển thêm 4 nhân sự GIS, kèm scope phình to (Lidar, camera, thời tiết, địa hình). Tuy nhiên Google Maps cũng sai ở ngõ/hẻm/tổ/thôn Việt Nam và điều khoản Google (ToS) cấm cache quá 30 ngày hoặc dùng để xây CSDL cạnh tranh.
- **Cách giải quyết (Tư duy kiến trúc):** Tái định nghĩa bài toán: Logistics không cần vẽ bản đồ nền đẹp mà cần **Hệ thống phân giải địa chỉ** trả lời 3 câu hỏi cho 100% đơn hàng: *(1) Địa chỉ ở đâu (lat, lng, confidence, zone, bưu cục)? (2) Khách đang gõ gì (Autocomplete top-3 ≥ 85%)? (3) Từ A đến B bao xa/bao lâu (Route Matrix)?*
- **Chiến thắng nhỏ (Small Win):** Phát hiện "mỏ vàng" dữ liệu nội bộ 0 đồng: hàng vạn bưu tá quét mã "phát thành công" kèm toạ độ GPS điện thoại mỗi ngày — tương đương cách GrabMaps dùng GPS tài xế làm cảm biến.
- **[Chỗ dán Screenshot]:** *Dán bảng so sánh "7 việc dữ liệu nặng nhất của đề án cũ (12 tỷ + 4 GIS) vs Cách mới (0đ dữ liệu, tự học mỗi đêm)" trong `Proposal01.md §2.4`.*

#### [Thứ 3 – Module: Chốt ADR-001 — Kiến trúc 4 tầng `Rule → Cache → AI Quyết định → AI Sinh` (`ADR_week0.md`)]
- **Vấn đề gặp phải:** Ngân sách độ trễ yêu cầu `/autocomplete` p95 < 80ms, `/geocode` hit < 10ms và miss < 150ms. Nếu đặt LLM trực tiếp vào đường xử lý nóng (request path) thì độ trễ vọt lên >500ms, tốn chi phí API và không trả về xác suất hiệu chỉnh (calibrated probability).
- **Cách giải quyết (1 dòng kiến trúc):** Thiết kế phễu 4 tầng: `Tầng 1: Rule chuẩn hoá ổn định (~50 rule)` → `Tầng 2: Redis L1 Cache` → `Tầng 3: AI Quyết định (System One / Jev-compatible: Plumb-4B hoặc decider-2B tự host)` → `Tầng 4: AI Sinh (LLM Qwen2.5-7B chạy batch ngoại tuyến lúc 02:00 sáng)`.
- **Kết quả đo được (Before → After):** Toàn bộ 3 model AI (PhoBERT/BiLSTM tagger + System One decider-2B + Qwen2.5-7B-Instruct) chạy gọn trên **1 card RTX 3090 24GB** sẵn có, chi phí API ngoài trong request path = **0 đồng**.
- **[Chỗ dán Screenshot]:** *Dán sơ đồ kiến trúc tổng thể (`Detail04_architecture.md §1`) và bảng so sánh các model System One tự host (`Proposal01.md §7.5`).*

#### [Thứ 4 – Module: Chốt ADR-002 — Nguồn Dữ liệu Mở 0đ & Ranh giới Pháp lý ODbL / Google ToS]
- **Vấn đề gặp phải:** Tránh rủi ro pháp lý khi dùng dữ liệu mở OpenStreetMap (giấy phép ODbL yêu cầu share-alike nếu trộn chung DB rồi phân phối) và điều khoản của Google Maps.
- **Cách giải quyết (1 dòng kiến trúc):** Tách dữ liệu OSM (`vietnam-latest.osm.pbf`) sang database riêng, kết hợp Overture Maps (giấy phép CDLA-Permissive 2.0 dùng thoải mái cho buildings/POIs) và thư viện `undertheseanlp/address` + `vietnamadminunits` (ánh xạ 63→34 tỉnh, 10.602 xã/phường mới). Đối chứng ngoài chỉ chạy shadow mẫu nhỏ (≤1.000 địa chỉ/đêm với Goong, 200 với Google) và chỉ lưu con số accuracy, tuyệt đối không lưu toạ độ Google vào DB.
- **Kết quả đo được (Before → After):** Tiết kiệm ~12 tỷ tiền mua dữ liệu ban đầu + giảm chi phí API đối chứng xuống **< 2 triệu đồng/tháng**.
- **[Chỗ dán Screenshot]:** *Dán bảng phân loại 7 lớp dữ liệu & giấy phép (`Proposal01.md §8.1`).*

#### [Thứ 5 – Module: Chốt ADR-003 — Bảo mật PII (Nghị định 13/2023) & Sequence Tagger thay Regex]
- **Vấn đề gặp phải:** Địa chỉ gắn với tên và SĐT khách hàng là dữ liệu cá nhân theo NĐ 13/2023; ngoài ra bộ grammar regex tách địa chỉ tiếng Việt nếu viết tay sẽ phình to không thể bảo trì.
- **Cách giải quyết (1 dòng code/kiến trúc):** Bảng `delivery_points` chỉ lưu `addr_norm` (đã cắt bỏ hoàn toàn tên/SĐT tại `pipeline/mask.py`), dùng `md5(addr_norm)` để dedup/index và `HMAC-SHA256` có khoá khi cần che đầu ra; dùng 1 model Sequence Tagger (PhoBERT-base / char-BiLSTM-CRF) retrain hàng đêm từ nhãn GPS thay cho hàng nghìn dòng regex.
- **Kết quả đo được (Before → After):** Rủi ro lộ lọt PII ra cloud LLM = 0%; loại bỏ hoàn toàn nợ kỹ thuật regex.
- **[Chỗ dán Screenshot]:** *Dán đoạn SQL khởi tạo bảng `delivery_points` có cột `GENERATED ALWAYS AS (md5(addr_norm)) STORED` (`Detail04_architecture.md §2`).*

#### [Thứ 6 – Module: Hạ tầng Server, Quyền Truy cập Log & Chốt Bảng 12 KPI Mới (`Detail06_kpi.md`)]
- **Vấn đề gặp phải:** Cần máy chủ chạy thực tế và thước đo minh bạch thay cho khẩu hiệu "90% so Google".
- **Cách giải quyết:** Nhận bàn giao quyền đọc bảng quét phát GPS (`delivery_scans`), dựng môi trường Docker trên máy chủ 8 vCPU / 32GB RAM / 500GB SSD, kết nối workstation RTX 3090 24GB và thiết lậpファイル quy tắc `CLAUDE.md` cho AI Agent.
- **Kết quả đo được (Before → After):** Chốt tỉnh pilot (Bắc Ninh / Đồng Nai) và bộ 12 KPI tự động tính từ `eval_daily` (`acc@200m ≥ 90%`, `acc@50m ≥ 70%`, `internal coverage ≥ 80%`, `cost < 5% Google`).
- **[Chỗ dán Screenshot]:** *Dán cấu trúc monorepo `vtp-maps/` và file `CLAUDE.md` (`Detail07_agent_ops.md §2`).*

---

### B. Nhật ký Tuần 1: Xây dựng Golden Set 1.000 Địa chỉ & Đo Baseline Thực tế
*(Mục tiêu tuần 1: Không viết tính năng trước khi có bộ dữ liệu chuẩn Golden Set và con số đối chứng khách quan giữa Bản đồ 1.0, Google Maps và Goong)*

#### [Thứ 2 – Module: ETL Trích xuất Log Quét Phát GPS (`delivery_scans`)]
- **Vấn đề gặp phải:** Dữ liệu GPS từ điện thoại bưu tá trong thực tế có nhiễu (bưu tá bấm hoàn thành đơn khi đã chạy ra đầu ngõ, hoặc GPS nhảy sai số >100m trong nhà cao tầng).
- **Cách giải quyết (1 dòng code/SQL):** Viết bộ lọc chất lượng nhãn trong SQL ingest: chỉ lấy trạng thái `SUCCESS`, loại bỏ các điểm quét có `accuracy_m > 100m` hoặc cách tâm xã/phường `> 2km`.
- **Kết quả đo được (Before → After):** Lọc sạch hàng trăm nghìn bản ghi quét phát thô của tỉnh pilot, giữ lại tập ứng viên có toạ độ GPS tin cậy cao.
- **[Chỗ dán Screenshot]:** *Dán câu lệnh SQL lọc `delivery_scans` và thống kê phân bố sai số `accuracy_m` trên Terminal.*

#### [Thứ 3 – Module: Thuật toán Hội tụ Không gian Tạo Bảng `golden_set`]
- **Vấn đề gặp phải:** Làm sao chắc chắn 1 địa chỉ có toạ độ "chuẩn vàng" (Ground Truth) mà không cần nhân viên GIS đi khảo sát thực địa?
- **Cách giải quyết (1 dòng code/SQL):** Gom nhóm theo `addr_norm` (địa chỉ đã chuẩn hoá), chỉ chọn những địa chỉ có **ít nhất 3 lần phát thành công (`n_success ≥ 3`)** và độ phân tán không gian giữa các lần quét **GPS spread `< 50m`**, lấy toạ độ trung vị (`ST_Centroid` / geometric median) làm toạ độ chuẩn.
- **Kết quả đo được (Before → After):** Tạo thành công bảng `golden_set` gồm đúng **1.000 địa chỉ chuẩn vàng** tại tỉnh pilot với sai số thực tế dưới 50m (tương đương chuẩn `ROOFTOP`), tốn **0 đồng** chi phí khảo sát.
- **[Chỗ dán Screenshot]:** *Dán bảng `SELECT count(*), avg(gps_spread_m) FROM golden_set;` hiển thị 1.000 dòng với `gps_spread_m` trung bình ~18–25m.*

#### [Thứ 4 – Module: Xây dựng Eval Harness (`make eval`) & Đo Baseline Bản đồ 1.0]
- **Vấn đề gặp phải:** Trước đây mỗi lần sửa code phân giải địa chỉ không ai biết độ chính xác tổng thể tăng hay giảm bao nhiêu phần trăm.
- **Cách giải quyết (1 dòng code/SQL):** Viết script đánh giá tự động dùng hàm khoảng cách cầu `ST_DistanceSphere(g.result_geom, s.gps_geom)` tính tỷ lệ phần trăm địa chỉ nằm trong bán kính `≤ 200m` (`acc200`) và `≤ 50m` (`acc50`), đóng gói thành lệnh `make eval`.
- **Kết quả đo được (Before → After):** Chạy `make eval` lần đầu tiên cho hệ thống Bản đồ 1.0 trên 1.000 địa chỉ Golden Set → Có ngay con số Baseline chính xác (`acc@200m` và `acc@50m`) chỉ sau **3 giây** chạy lệnh.
- **[Chỗ dán Screenshot]:** *Dán đoạn code SQL `ST_DistanceSphere` (`Detail06_kpi.md §4`) và bảng kết quả chạy `make eval` trên Terminal.*

#### [Thứ 5 – Module: Chạy Shadow Benchmark Mẫu Nhỏ (200 Địa chỉ Google Maps & 1.000 Địa chỉ Goong)]
- **Vấn đề gặp phải:** Cần chứng minh bằng số liệu thực tế luận điểm: *"Google Maps cũng sai ở ngõ/hẻm/thôn/xóm Việt Nam"* mà không vi phạm điều khoản lưu trữ của Google.
- **Cách giải quyết (1 dòng code):** Viết script `shadow-benchmark` lấy ngẫu nhiên 200 địa chỉ từ `golden_set` gọi qua Google Geocoding API và 1.000 địa chỉ gọi qua Goong API trong bộ nhớ (in-memory), so sánh khoảng cách với GPS bưu tá rồi **chỉ ghi duy nhất con số % accuracy** ra bảng báo cáo, xoá ngay toạ độ trả về.
- **Kết quả đo được (Before → After):** Phát hiện hàng loạt trường hợp địa chỉ thôn/xóm/KCN hoặc ngõ/ngách mới sáp nhập khiến Google chỉ trả về `APPROXIMATE` (tâm xã/phường, lệch 800m – 3km), trong khi GPS bưu tá trong `delivery_points` ghim trúng cửa nhà (`< 25m`).
- **[Chỗ dán Screenshot]:** *Dán bảng đối chiếu Baseline 3 cột: `Bản đồ 1.0 vs Goong (mẫu 1.000) vs Google Maps (mẫu 200)` theo 2 chỉ số `acc@200m` và `acc@50m`.*

#### [Thứ 6 – Module: Đóng gói CI Gate & Chốt Báo cáo Tuần 1]
- **Vấn đề gặp phải:** Ngăn chặn việc AI Agent hoặc lập trình viên merge code làm tụt độ chính xác trong các tuần tiếp theo.
- **Cách giải quyết:** Đưa `make eval` vào GitHub/GitLab CI: bất kỳ Pull Request nào làm giảm `acc@200m` trên tập `golden_set` đều bị chặn merge tự động.
- **Kết quả đo được (Before → After):** Hoàn thành 100% mục tiêu Tuần 0 – Tuần 1: Có hạ tầng, có 3 ADR, có 1.000 địa chỉ Golden Set và bảng điểm đối chứng để bắt đầu nạp PostGIS ở Tuần 2.
- **[Chỗ dán Screenshot]:** *Dán màn hình CI Pipeline báo xanh (`Golden-set eval passed`) và biểu đồ so sánh Baseline.*

---

## PHẦN 2: KỊCH BẢN CHI TIẾT 2 VIDEO ĐẦU TIÊN (TUẦN 0 – TUẦN 1)

### VIDEO 1 — GÓC NHÌN KỸ THUẬT / FOUNDER BRAND (QUAY ONE-TAKE)

- **Tiêu đề gợi ý (YouTube Title):** Tại sao tôi từ bỏ kế hoạch "Bản đồ 12 Tỷ" để xây hệ thống phân giải địa chỉ 0 đồng bằng Local AI? | Build in Public #01
- **Hình thức:** Ngồi trước bàn làm việc, mở sẵn sơ đồ kiến trúc `Detail04_architecture.md` hoặc Terminal trên màn hình phụ phía sau; quay **1 mạch (one-take)** bằng điện thoại/webcam (thời lượng ~4 phút 30 giây).
- **Danh sách Chapters (dán vào phần Mô tả YouTube hoặc bật Auto Chapters):**
  - `00:00` Nghịch lý 12 tỷ đồng và cái bẫy "Chính xác 90% so với Google Maps"
  - `01:05` Logistics thực sự cần gì? 3 câu hỏi sống còn thay vì vẽ bản đồ nền
  - `02:15` Mỏ vàng 0 đồng: Biến hàng vạn bưu tá thành cảm biến GPS giống GrabMaps
  - `03:20` Kiến trúc 4 tầng trên 1 card RTX 3090: Tại sao cấm LLM nằm trong Request Path?
  - `04:10` Cam kết 90 ngày Build-in-Public & Bài học Data-First cho Indie Maker

#### Dàn ý Gạch đầu dòng để nhìn lướt khi nói (One-Take Bullet Script):

- **[00:00 – 01:05] HOOK — Nghịch lý 12 tỷ & Cái bẫy mang tên Google Maps:**
  - Chào anh em! Hôm nay mình bắt đầu chuỗi *Build in Public* 90 ngày tự tay xây dựng hệ thống **Bản đồ số 2.0** phục vụ giao vận Logistics chỉ với 1 máy chủ 32GB RAM và 1 chiếc PC gắn card RTX 3090 sẵn có.
  - Trước khi bắt tay vào code, mình đọc lại đề án cũ: dự kiến tiêu **12 tỷ đồng** để mua 5 triệu địa chỉ mỗi tháng, tuyển thêm 4 kỹ sư GIS ngồi chuẩn hoá tay, ôm cả Lidar, camera, thời tiết, và đặt KPI là *"đạt 90% độ chính xác so với Google Maps"*.
  - Nghe rất hoành tráng, nhưng có **2 lỗ hổng chết người**:
    1. Thứ nhất: Ở ngõ ngách, thôn xóm, khu công nghiệp Việt Nam hoặc các xã phường vừa sáp nhập, **chính Google Maps cũng đoán mò** (chỉ trả về tâm xã, lệch cả cây số). Lấy một thước đo sai làm chuẩn thì hệ thống không bao giờ giao hàng tốt hơn được.
    2. Thứ hai: Mua dữ liệu 1 lần rồi để đó thì 6 tháng sau dữ liệu lại lỗi thời, lại phải xin thêm 12 tỷ nữa. Chưa kể lấy dữ liệu Google để kiểm chứng chéo hàng triệu địa chỉ là vi phạm trực tiếp điều khoản dịch vụ (ToS) của Google.

- **[01:05 – 02:15] CHẨN ĐOÁN — Chúng ta không xây bản đồ, chúng ta giải 3 câu hỏi:**
  - Tư duy đầu tiên của một Indie Maker hay System Architect khi nguồn lực có hạn là **cắt bỏ mọi thứ phù phiếm**.
  - Một đơn hàng Logistics không cần bản đồ 3D hay Lidar. Nó chỉ cần trả lời đúng **3 câu hỏi** trong dưới 150 mili-giây:
    1. *Địa chỉ khách ghi nằm ở toạ độ nào, thuộc vùng (zone) của bưu cục nào, và độ tin cậy là bao nhiêu phần trăm?*
    2. *Khách mới gõ 3–4 chữ không dấu thì gợi ý (Autocomplete) dòng nào để trúng ngay trong Top 3?*
    3. *Từ bưu cục A đến điểm giao B đi xe máy trong hẻm mất bao xa, bao lâu?*
  - Mọi thứ không phục vụ trực tiếp 3 câu hỏi này — mình cắt toàn bộ khỏi scope 90 ngày.

- **[02:15 – 03:20] ĐỘT PHÁ DỮ LIỆU — Bưu tá chính là cảm biến (Bài học từ GrabMaps):**
  - Không có 12 tỷ mua dữ liệu thì lấy Ground Truth (dữ liệu chuẩn) ở đâu?
  - Câu trả lời nằm ngay trước mắt mà trước đây bị bỏ quên: Mỗi ngày có **hàng vạn bưu tá** đứng ngay trước cửa nhà khách hàng trong ngõ sâu và bấm quét mã *"Phát thành công"* kèm theo toạ độ GPS từ điện thoại.
  - Đó chính xác là cách GrabMaps đã thắng ở Đông Nam Á: biến đội xe thành cảm biến.
  - Ngay trong Tuần 1, mình viết một đoạn SQL gom các địa chỉ có từ **3 lần phát thành công trở lên** mà toạ độ GPS hội tụ trong bán kính **dưới 50 mét**. Không tốn 1 xu mua ngoài, mình có ngay **1.000 địa chỉ Golden Set (Chuẩn vàng)** để chấm điểm tự động mọi dòng code viết ra.

- **[03:20 – 04:10] KIẾN TRÚC 4 TẦNG — Tại sao cấm tiệt LLM trong Request Path nóng?**
  - Nhiều anh em làm AI hiện nay hễ thấy bài toán xử lý ngôn ngữ là đẩy thẳng vào GPT hay Claude API. Nhưng với hệ thống phải chịu tải hàng triệu đơn, độ trễ yêu cầu dưới 80ms đến 150ms và bảo mật dữ liệu cá nhân theo Nghị định 13, gọi LLM trực tiếp là tự sát về cả tốc độ lẫn chi phí.
  - Mình chốt kiến trúc 4 tầng trong `ADR-001`:
    1. **Rule ổn định** (chuẩn hoá tiếng Việt `NFKD`, từ viết tắt) chạy trong vài micro-giây.
    2. **Redis L1 Cache** trả kết quả dưới 10ms cho địa chỉ quen.
    3. **Model nhỏ tự host** (PhoBERT/BiLSTM tagger + System One model `decider-2B`) chấm xác suất khớp mờ.
    4. **LLM Qwen2.5-7B** chỉ chạy **batch ngoại tuyến lúc 2 giờ sáng** trên chiếc RTX 3090 để gán nhãn những ca khó nhất, rồi dạy lại cho model nhỏ.

- **[04:10 – 04:30] KẾT & CALL TO ACTION:**
  - Kết quả là hệ thống **tự khôn lên sau mỗi đêm** từ chính đơn hàng giao thành công mà chi phí biên gần như bằng 0.
  - Mình đã đóng gói xong bộ `golden_set` 1.000 điểm và chạy thử benchmark đầu tiên đọ sức trực tiếp với Google Maps. Anh em xem tiếp video Demo kỹ thuật trên kênh để thấy số liệu thực tế nhé. Đừng quên Subscribe để theo dõi hành trình 12 tuần xây hệ thống này!

---

### VIDEO 2 — DEMO TÍNH NĂNG & CHỨNG MINH KẾT QUẢ (DỰNG TRÊN GOOGLE VIDS + AI VOICEOVER)

- **Tiêu đề gợi ý (YouTube Title):** Kiến trúc Bản đồ số 2.0 & Benchmark Golden Set: Khi GPS Bưu tá đánh bại Google Maps trong ngõ hẻm | System Proof #01
- **Hình thức:** Tạo trên **Google Vids** (16:9), chọn template *Modern Tech / Data Report*, kéo thả 6 Scenes theo bảng dưới đây, chèn Screenshots từ file Google Docs Tuần 0–1 và dùng **AI Voiceover** đọc cột Lời bình (thời lượng ~3 phút 45 giây).
- **Danh sách Chapters (dán vào phần Mô tả YouTube):**
  - `00:00` Bài toán Phân giải Địa chỉ Logistics & Mục tiêu 90 ngày
  - `00:35` So sánh Chi phí & Công sức: Cách cũ (12 Tỷ) vs Kiến trúc Tự học (0đ dữ liệu)
  - `01:15` Sơ đồ Kiến trúc 4 Tầng: Rule → Cache → System One AI → Nightly LLM
  - `02:00` Cách tạo Golden Set 1.000 điểm chuẩn vàng từ GPS Bưu tá bằng PostGIS
  - `02:45` Kết quả Benchmark thực tế: Nội bộ vs Goong vs Google Maps tại ngõ hẻm
  - `03:20` Quy trình CI Gate tự động chặn PR giảm điểm & Kế hoạch Tuần 2

#### Bảng Phân Cảnh Chi Tiết (Kéo thả trực tiếp vào Google Vids):

| Scene & Timecode | Visual / Screenshot cần chèn vào Google Vids | Text hiển thị trên Slide (Ngắn gọn) | Lời bình (Voiceover Script cho AI đọc) |
|---|---|---|---|
| **Scene 1**<br>`00:00 – 00:35`<br>*(35 giây)* | Chèn hình minh hoạ tổng quan (hoặc slide mở đầu từ `slide_ban_do_so_2.0.html` / `bds_03.png` trong thư mục `BDS-Indie`) thể hiện 3 mũi nhọn: **Where? (Geocode) — Suggest? (Autocomplete) — How far? (Route Matrix)**. | **BẢN ĐỒ SỐ 2.0**<br>Hệ thống Phân giải Địa chỉ Tự học<br>`p95 < 80ms` · `Acc@200m ≥ 90%` · `< 5% Google Cost` | "Chào mừng bạn đến với bản chứng minh kỹ thuật đầu tiên của dự án Bản đồ số 2.0. Thay vì xây dựng một bản đồ hiển thị dàn trải, hệ thống tập trung giải quyết triệt để ba bài toán cốt lõi cho một trăm phần trăm đơn hàng Logistics: Xác định toạ độ và bưu cục phục vụ kèm độ tin cậy; Gợi ý địa chỉ siêu tốc trong tám mươi mili-giây; Và tính toán ma trận khoảng cách chuẩn xác cho xe máy và xe tải." |
| **Scene 2**<br>`00:35 – 01:15`<br>*(40 giây)* | Chèn ảnh chụp màn hình **Bảng 2.4 trong `Proposal01.md`** (*7 việc dữ liệu nặng nhất của đề án cũ vs Cách mới thay thế*) với dòng tổng kết tiết kiệm ~13 tỷ đồng và 7.700 giờ công/năm. | **CẮT GIẢM 95% CHI PHÍ**<br>Từ "Mua dữ liệu 1 lần" sang "Tự học từ mỗi đơn giao"<br>Chi phí dữ liệu: **0 đồng** | "Ở phương án truyền thống, việc mua năm triệu địa chỉ mỗi tháng và thuê đội ngũ nhập liệu thủ công tiêu tốn hàng chục tỷ đồng nhưng dữ liệu nhanh chóng lỗi thời và tiềm ẩn rủi ro pháp lý với điều khoản của Google. Kiến trúc mới đảo ngược hoàn toàn quy trình này: tận dụng dữ liệu mở từ OpenStreetMap, Overture Maps kết hợp cùng toạ độ GPS quét phát thành công mỗi ngày của bưu tá để tạo ra vòng lặp tự học khép kín với chi phí mua dữ liệu bằng không." |
| **Scene 3**<br>`01:15 – 02:00`<br>*(45 giây)* | Chèn ảnh chụp màn hình **Sơ đồ Kiến trúc Tổng thể (`Detail04_architecture.md §1`)** và **Bảng ADR-001 (`ADR_week0.md`)** làm nổi bật luồng: `FastAPI → OpenSearch / Parser-Resolver / OSRM → Redis L1 → PostGIS ← Nightly Pipeline (RTX 3090)`. | **KIẾN TRÚC 4 TẦNG TINH GỌN**<br>1. Rule (`NFKD + đ/Đ`)<br>2. Redis Cache (`<10ms`)<br>3. System One AI & Tagger<br>4. Nightly LLM (`Qwen2.5-7B` @ 02:00 AM) | "Để đảm bảo độ trễ dưới một trăm năm mươi mili-giây khi cache miss và dưới mười mili-giây khi cache hit, mô hình ngôn ngữ lớn tuyệt đối không nằm trong đường xử lý trực tiếp. Yêu cầu đi qua tầng chuẩn hoá luật tiếng Việt, kiểm tra bộ nhớ đệm Redis, sau đó phân giải bằng mô hình Sequence Tagger và System One siêu nhẹ. Những địa chỉ phức tạp nhất sẽ được gom lại để mô hình Qwen hai chấm năm bảy tỷ tham số xử lý ngoại tuyến lúc hai giờ sáng trên card RTX 3090, giúp hệ thống thông minh hơn mỗi ngày mà không tốn phí API." |
| **Scene 4**<br>`02:00 – 02:45`<br>*(45 giây)* | Chèn ảnh chụp màn hình **Đoạn code SQL tạo bảng `delivery_points` và `golden_set` (`Detail04_architecture.md §2`)** kèm cửa sổ Terminal chạy truy vấn lọc 1.000 địa chỉ có `n_success >= 3` và `gps_spread_m < 50`. | **GOLDEN SET 1.000 ĐỊA CHỈ**<br>Chuẩn vàng từ thực địa:<br>≥ 3 lần giao thành công<br>Độ lệch GPS hội tụ `< 50m`<br>Bảo mật PII (Nghị định 13/2023) | "Nguyên tắc số một của dự án là Data-First: không viết bất kỳ tính năng nào trước khi có bộ dữ liệu chuẩn Golden Set. Bằng cách lọc tự động các địa chỉ đã giao thành công tối thiểu ba lần với độ phân tán GPS dưới năm mươi mét trên PostGIS, chúng ta thu được ngay một nghìn điểm chuẩn vàng đạt độ chính xác cấp độ mái nhà. Toàn bộ tên và số điện thoại khách hàng đều được tách bỏ hoàn toàn để tuân thủ nghiêm ngặt Nghị định 13 về bảo vệ dữ liệu cá nhân." |
| **Scene 5**<br>`02:45 – 03:20`<br>*(35 giây)* | Chèn ảnh chụp màn hình **Câu lệnh SQL `ST_DistanceSphere` (`Detail06_kpi.md §4`)** và **Bảng kết quả chạy `make eval` / `shadow-benchmark`** so sánh `acc@200m` và `acc@50m` giữa Hệ thống 1.0, Goong và Google Maps (mẫu 200). | **BENCHMARK ĐỐI CHỨNG THỰC TẾ**<br>Đo bằng khoảng cách thực tế tới điểm bưu tá đứng giao (`ST_DistanceSphere ≤ 200m & ≤ 50m`) | "Khi chạy bộ công cụ đánh giá tự động trên một nghìn điểm chuẩn vàng và đối chứng mẫu nhỏ với các dịch vụ bản đồ bên ngoài, số liệu cho thấy rõ điểm yếu của các bản đồ ngoại tại khu vực ngõ ngách, thôn xóm và các đơn vị hành chính vừa sáp nhập tại Việt Nam. Nhiều địa chỉ chỉ trả về tâm xã lệch hàng trăm mét, trong khi dữ liệu điểm giao từ bưu tá định vị chính xác vị trí thực tế trong bán kính dưới năm mươi mét." |
| **Scene 6**<br>`03:20 – 03:45`<br>*(25 giây)* | Chèn ảnh chụp màn hình **Cấu trúc Monorepo `vtp-maps/`, file quy tắc `CLAUDE.md` (`Detail07_agent_ops.md`)** và trạng thái **CI Pipeline (`make eval` passed)**. | **TIẾP THEO — TUẦN 2: DATA FOUNDATION**<br>`make up` 1 lệnh Docker Compose<br>Ingest OSM + Overture + 10.602 xã/phường mới | "Hiện tại, bộ kiểm thử Golden Set đã được tích hợp thẳng vào chốt chặn CI/CD: mọi thay đổi code từ kỹ sư hay AI Agent nếu làm giảm điểm chính xác đều bị từ chối tự động. Trong tuần thứ hai tiếp theo, chúng ta sẽ khởi chạy toàn bộ cụm PostGIS, OpenSearch và Redis chỉ bằng một lệnh Docker, đồng thời nạp toàn bộ dữ liệu đường sá, toà nhà và mười nghìn sáu trăm linh hai đơn vị hành chính mới." |
