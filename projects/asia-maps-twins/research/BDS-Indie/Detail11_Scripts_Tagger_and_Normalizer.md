# Detail11 — Kịch Bản Chi Tiết: (1) Tagger PhoBERT/BiLSTM trên RTX 3090 & (2) Normalizer đ/Đ + Viết tắt + 50 Rule

> Tài liệu này bổ sung kịch bản chi tiết (gồm cả bản **Founder Brand — Quay One-Take** và bản **Product Marketing — Dựng trên Google Vids + AI Voiceover**) cho 2 module cốt lõi của tầng xử lý ngôn ngữ tự nhiên tiếng Việt (`ADR_week0.md`, `Detail04_architecture.md §3`, `Detail07_agent_ops.md §3.2`, `Detail08_vietnamese_nlp.md`).

---

## CHỦ ĐỀ 1: TAGGER PHOBERT / CHAR-BILSTM-CRF THAY REGEX, TRAIN TRÊN RTX 3090 24GB

### 1A. Kịch bản Video Góc nhìn Kỹ thuật / Founder Brand (Quay One-Take)

- **Tiêu đề gợi ý (YouTube Title):** Tại sao Grammar Regex tách địa chỉ Tiếng Việt luôn trở thành "Nợ Kỹ Thuật" và cách tôi thay bằng 1 Model tự train mỗi đêm trên RTX 3090 | Build in Public #02
- **Hình thức:** Quay One-Take bằng điện thoại/webcam tại bàn làm việc (thời lượng ~4 phút 30 giây), màn hình phía sau mở file `ADR_week0.md` (`ADR-003`) hoặc sơ đồ luồng `parser-retrain` trong `Detail07_agent_ops.md`.
- **Danh sách Chapters (YouTube Studio):**
  - `00:00` Cái bẫy của Grammar Regex khi xử lý địa chỉ thực tế tại Việt Nam
  - `01:05` Bài toán đánh đổi (ADR-003): Regex thuần vs Gọi thẳng LLM vs Sequence Tagger nhỏ
  - `02:15` Kiến trúc PhoBERT-base / char-BiLSTM-CRF: Gán nhãn dưới 5ms không phát sinh nợ kỹ thuật
  - `03:15` Vòng lặp `parser-retrain` lúc 02:00 sáng trên RTX 3090: Dùng LLM ngoại tuyến nuôi Model nhỏ
  - `04:05` Bảo mật PII theo Nghị định 13/2023 & Chốt chặn `make eval` trước khi mở PR

#### Dàn ý Gạch đầu dòng để nhìn lướt khi nói (One-Take Bullet Script):

- **[00:00 – 01:05] HOOK — Cái bẫy "Viết thêm 1 cái Regex nữa thôi":**
  - Bất kỳ kỹ sư nào từng làm bài toán tách địa chỉ Việt Nam cho giao vận đều bắt đầu bằng câu nói: *"Chỉ cần viết vài chục câu Regex bắt chữ Số nhà, Ngõ, Đường, Phường, Quận là xong!"*.
  - Nhưng địa chỉ người Việt gõ trên thực tế không theo bất kỳ văn phạm cố định nào: *"SN 12/4B ngách 22/5 hẻm cụt đối diện tạp hoá cô Lan, tổ 4 thôn Bầu, KCN Bắc Thăng Long"* hoặc viết dính không dấu, đảo ngược thứ tự xã/huyện cũ sang xã/phường mới.
  - Khi đội cũ cố viết Grammar Regex tay, từ 50 rule ban đầu nó phình lên hàng nghìn rule chồng chéo: sửa được địa chỉ ở Hà Nội thì làm hỏng địa chỉ ở TP.HCM hay Huế. Đó là **"Nợ kỹ thuật" (Regex Debt)** khiến cả đội chôn chân nhiều quý.

- **[01:05 – 02:15] TƯ DUY ĐÁNH ĐỔI (ADR-003) — Tại sao không đẩy thẳng vào LLM mà chọn Sequence Tagger?**
  - Trước khi viết code, mình ghi rõ 3 phương án trong `ADR-003`:
    1. **Phương án 1 (Grammar Regex thuần):** Không cần GPU nhưng phình to, không bảo trì nổi, bó tay trước địa chỉ lạ.
    2. **Phương án 2 (Đẩy thẳng vào LLM trong request path):** Độ chính xác cao nhưng độ trễ vọt lên `>500ms` (phá vỡ ngân sách `p95 < 150ms`), tốn tiền API theo từng đơn và nguy hiểm nhất là rò rỉ dữ liệu cá nhân (tên, SĐT, địa chỉ) ra ngoài công ty.
    3. **Phương án 3 (Sequence Tagger tự lưu trữ):** Dùng **1 model duy nhất** (`PhoBERT-base` ~135M tham số nhận diện thực thể NER hoặc `char-level BiLSTM-CRF` siêu nhẹ chạy `< 5ms`) để gán nhãn trực tiếp lên từng âm tiết/token: `house_no`, `alley`, `street`, `hamlet`, `ward`, `province`.

- **[02:15 – 03:15] CÁCH BOOTSTRAP TỪ CON SỐ 0 — Không chờ dữ liệu hoàn hảo mới chạy:**
  - Câu hỏi thực tế: Lấy nhãn ở đâu để huấn luyện PhoBERT / char-BiLSTM khi mới bắt đầu ở Tuần 4?
  - Mình áp dụng chiến thuật **Bootstrap**: Ở Tuần 4, dùng đúng 50 rule chuẩn hoá cốt lõi kết hợp với bộ dữ liệu nội bộ (`213k` địa chỉ cấp 4, `863k` địa danh cấp 5 và `golden_set` 1.000 điểm) để sinh tập nhãn khởi tạo đầu tiên.
  - Từ Tuần 5–6 trở đi, Sequence Tagger chính thức trở thành bộ phân tích chính trong đường xử lý nóng, trả kèm điểm tự tin `parse_conf` cho từng địa chỉ.

- **[03:15 – 04:05] VÒNG LẶP `parser-retrain` 02:00 SÁNG TRÊN RTX 3090 — Để hệ thống tự học khi mình đang ngủ:**
  - Điểm ăn tiền nhất nằm ở khoảng 5–10% **"đuôi khó"** (những địa chỉ có `parse_conf < 0.5` hoặc bị geocode lệch `> 500m` so với GPS bưu tá).
  - Đúng **02:00 sáng mỗi đêm**, cron job `parser-retrain` tự động chạy trên chiếc PC Workstation gắn card **RTX 3090 24GB**:
    1. Chạy qua `pipeline/mask.py` cắt bỏ hoàn toàn tên và SĐT khách hàng (tuân thủ Nghị định 13/2023).
    2. Đẩy lô địa chỉ khó vào LLM `Qwen2.5-7B-Instruct` chạy qua `vLLM` (tốc độ **1.000 địa chỉ/phút** trên 1 GPU 24GB) để bóc tách JSON chuẩn.
    3. Gom nhãn mới này trộn vào tập `delivery_points + golden_set` rồi tự động **retrain lại PhoBERT / char-BiLSTM tagger** ngay trên RTX 3090.
    4. Gọi Claude Code chạy 300 unit test và `make eval`: nếu điểm chính xác tăng và độ trễ `p95` không vượt ngưỡng, Agent tự động **mở Pull Request kèm bảng điểm Before/After** chờ mình duyệt lúc 8h30 sáng.

- **[04:05 – 04:30] BÀI HỌC KẾT — Thay hàng nghìn dòng code bằng 1 vòng lặp dữ liệu:**
  - Thay vì thuê 4 nhân sự GIS ngồi sửa rule tay tốn 1,2 tỷ mỗi năm, chúng ta chỉ cần 1 kiến trúc đúng: **LLM làm thầy giáo chấm bài ban đêm, còn Tagger nhỏ làm học trò chạy tốc độ cao ban ngày**.

---

### 1B. Kịch bản Video Demo Sản phẩm / Product Marketing (Dựng trên Google Vids + AI Voiceover)

- **Tiêu đề gợi ý (YouTube Title):** Cận cảnh Pipeline Tự Huấn Luyện PhoBERT/BiLSTM Tagger lúc 2h Sáng trên RTX 3090 & Bóc tách Địa chỉ Khó <5ms | System Proof #02
- **Hình thức:** Google Vids (16:9), gồm 6 Scenes kéo thả trực tiếp kèm lời bình AI Voiceover (thời lượng ~3 phút 50 giây).
- **Danh sách Chapters (YouTube Studio):**
  - `00:00` Sự sụp đổ của Grammar Regex trước địa chỉ thực tế Việt Nam
  - `00:40` Kiến trúc Sequence Tagger (PhoBERT / char-BiLSTM-CRF) dưới 5ms
  - `01:25` Bảo mật PII với `mask.py` & Xử lý "Đuôi khó" bằng Qwen2.5-7B trên vLLM
  - `02:10` Cron 02:00 AM: Tự động Retrain Tagger trên RTX 3090 24GB
  - `02:55` AI Agent tự chạy `make eval` và mở Pull Request kèm bảng Before/After
  - `03:30` Kết quả thực tế: Tỷ lệ `parse_conf ≥ 0.5` vượt mốc 85% không nợ Regex

#### Bảng Phân Cảnh Chi Tiết (4 cột cho Google Vids):

| Scene & Timecode | Visual / Screenshot cần chèn vào Google Vids | Text hiển thị trên Slide (Ngắn gọn) | Lời bình (Voiceover Script cho AI đọc) |
|---|---|---|---|
| **Scene 1**<br>`00:00 – 00:40`<br>*(40 giây)* | Chèn hình phễu **Hình 5.2 (Parser: luật trước, AI sau trong `Proposal01.md`)** đối chiếu với 5 chuỗi địa chỉ thực tế viết tắt, đảo trật tự, thiếu dấu. | **TẠM BIỆT NỢ KỸ THUẬT REGEX**<br>Thay hàng nghìn rule chồng chéo bằng **1 Sequence Tagger duy nhất** | "Trong thực tế vận hành Logistics tại Việt Nam, khách hàng có thể viết địa chỉ theo hàng trăm biến thể khác nhau: viết tắt, bỏ dấu, đảo lộn thứ tự thôn xóm, ngõ ngách hoặc ghi kèm điểm mốc tự phát. Việc dùng biểu thức chính quy truyền thống khiến bộ luật phình to và dễ gãy vỡ khi bảo trì. Bản đồ số 2.0 giải quyết triệt để vấn đề này bằng cách thay thế tầng văn phạm phức tạp bằng một mô hình gán nhãn chuỗi duy nhất." |
| **Scene 2**<br>`00:40 – 01:25`<br>*(45 giây)* | Chèn ảnh chụp màn hình **`Detail08_vietnamese_nlp.md §6–7`** và cửa sổ Terminal/JSON minh hoạ đầu ra của Tagger: `{house_no, alley, street, hamlet, ward_id, province_id, residual, parse_conf: 0.94}` với thời gian thực thi `< 5ms`. | **SEQUENCE TAGGER SIÊU TỐC (`< 5ms`)**<br>PhoBERT-base / char-BiLSTM-CRF<br>Trả kèm điểm tin cậy `parse_conf` | "Sau khi đi qua tầng chuẩn hoá ký tự cơ bản, chuỗi địa chỉ được đưa vào mô hình PhoBERT hoặc char-BiLSTM-CRF tự lưu trữ. Chỉ trong chưa đầy năm mili-giây, mô hình gán nhãn chính xác từng thành phần từ số nhà, ngõ hẻm, tên đường, thôn ấp cho đến xã phường, đồng thời trả về chỉ số độ tin cậy để quyết định luồng xử lý tiếp theo mà không cần gọi bất kỳ dịch vụ đám mây bên ngoài nào." |
| **Scene 3**<br>`01:25 – 02:10`<br>*(45 giây)* | Chèn ảnh chụp màn hình **Hình 8.3 (Bảo vệ dữ liệu cá nhân theo NĐ 13/2023)** và **Prompt Batch Parse Qwen2.5-7B trong `Detail07_agent_ops.md §4`** (chạy vLLM 1.000 địa chỉ/phút). | **XỬ LÝ 5–10% ĐUÔI KHÓ BẰNG LOCAL LLM**<br>`mask.py` (NĐ 13/2023) → `Qwen2.5-7B` (`vLLM`) → **1.000 địa chỉ/phút** | "Với khoảng năm đến mười phần trăm địa chỉ quá phức tạp có độ tin cậy thấp hoặc bị phân giải lệch quá năm trăm mét so với GPS bưu tá, hệ thống sẽ đưa vào hàng đợi xử lý ban đêm. Trước tiên, mô-đun mask tự động loại bỏ toàn bộ tên và số điện thoại khách hàng để bảo vệ dữ liệu cá nhân theo Nghị định 13. Tiếp đó, mô hình Qwen hai chấm năm bảy tỷ tham số chạy trên vLLM sẽ bóc tách cấu trúc JSON với tốc độ một nghìn địa chỉ mỗi phút." |
| **Scene 4**<br>`02:10 – 02:55`<br>*(45 giây)* | Chèn ảnh chụp màn hình **Hình 7.2 (Retrain tagger từ nhãn mỗi đêm)** và log chạy tiến trình huấn luyện lại trên card GPU **NVIDIA RTX 3090 24GB** lúc 02:00 sáng. | **CRON 02:00 AM TRÊN RTX 3090 24GB**<br>LLM gán nhãn → Bổ sung vào `delivery_points` → Tự động Retrain Tagger | "Thay vì dừng lại ở kết quả của mô hình ngôn ngữ lớn, các nhãn mới vừa bóc tách được trộn thẳng vào tập điểm giao thành công để huấn luyện lại mô hình Sequence Tagger ngay trên card đồ hoạ RTX 3090 hai mươi tư gigabyte. Nhờ vậy, những địa chỉ từng làm khó hệ thống hôm qua sẽ được mô hình nhỏ xử lý tức thì trong vài mili-giây vào ngày hôm sau." |
| **Scene 5**<br>`02:55 – 03:30`<br>*(35 giây)* | Chèn ảnh chụp màn hình quy trình **`parser-retrain` trong `Detail07_agent_ops.md §3.2`** và giao diện Pull Request do AI Agent mở kèm bảng điểm `Eval Before/After` + 300 unit tests xanh. | **AI AGENT TỰ ĐỘNG MỞ PULL REQUEST**<br>Chạy 300 Unit Tests + `make eval` → Chặn tự động nếu giảm điểm | "Ngay sau khi huấn luyện xong, AI Agent tự động kiểm tra với ba trăm bài test đơn vị và bộ đánh giá Golden Set. Chỉ khi độ chính xác tăng lên và độ trễ p95 giữ nguyên trong ngưỡng an toàn, Agent mới tạo nhánh mới và mở Pull Request kèm bảng đối chiếu trước và sau. Kỹ sư chỉ mất mười lăm phút mỗi sáng để kiểm tra và phê duyệt." |
| **Scene 6**<br>`03:30 – 03:50`<br>*(20 giây)* | Chèn bảng tổng hợp **KPI Tuần 4 & Tuần 10 (`Detail05_roadmap.md` & `Detail06_kpi.md`)**: `parse_conf ≥ 0.5` đạt `≥ 85%` ở tỉnh pilot, tiến tới `≥ 5 PR` tự động/tuần. | **KẾT QUẢ ĐO LƯỜNG THỰC TẾ**<br>`≥ 85%` địa chỉ đạt `parse_conf ≥ 0.5`<br>**0 dòng nợ kỹ thuật Regex** | "Với vòng lặp khép kín này, bộ phân tích địa chỉ đạt tỷ lệ tin cậy trên tám mươi lăm phần trăm ngay từ phiên bản đầu tiên và liên tục tự hoàn thiện hàng tuần mà không phát sinh bất kỳ nợ kỹ thuật nào." |

---

## CHỦ ĐỀ 2: NORMALIZER Đ/Đ + VIẾT TẮT + TỪ VÙNG MIỀN + 50 RULE & SÁP NHẬP HÀNH CHÍNH (DETAIL08)

### 2A. Kịch bản Video Góc nhìn Kỹ thuật / Founder Brand (Quay One-Take)

- **Tiêu đề gợi ý (YouTube Title):** Đừng dùng hàm `unidecode()` cho Tiếng Việt nữa! Cách tôi chuẩn hoá địa chỉ và giải bài toán sáp nhập 10.602 xã/phường | Build in Public #03
- **Hình thức:** Quay One-Take bằng điện thoại/webcam (thời lượng ~4 phút 15 giây), màn hình phụ phía sau mở file `Detail08_vietnamese_nlp.md` và `rules/abbrev.yaml`.
- **Danh sách Chapters (YouTube Studio):**
  - `00:00` Sai lầm kinh điển: Tại sao hàm `unidecode()` phá hỏng dữ liệu địa chỉ Việt Nam?
  - `01:00` Giải pháp chuẩn: Phân rã `NFKD` kết hợp bảng ánh xạ riêng cho chữ `đ/Đ`
  - `01:55` Quy hoạch "Ma trận viết tắt" & Từ vựng vùng miền (Ngõ, Ngách, Hẻm, Kiệt, Thôn, Ấp)
  - `02:50` Đừng tự code lại bánh xe: Giải bài toán sáp nhập 63→34 tỉnh và 10.602 xã/phường trong 1 giờ
  - `03:45` Triết lý 50 Rule ổn định: Đâu là ranh giới giữa Rule và AI?

#### Dàn ý Gạch đầu dòng để nhìn lướt khi nói (One-Take Bullet Script):

- **[00:00 – 01:00] HOOK — Thảm hoạ mang tên `naive unidecode()`:**
  - Hôm nay mình chia sẻ một chi tiết kỹ thuật cực nhỏ nhưng từng làm sai lệch hàng vạn kết quả tìm kiếm địa chỉ tiếng Việt: **cách chúng ta bỏ dấu tiếng Việt**.
  - Thói quen của 90% lập trình viên khi làm search không dấu là cài thư viện `unidecode` của Python rồi gọi một hàm duy nhất. Nhưng `unidecode` xử lý tiếng Việt rất thô bạo: nó biến chữ `đ/Đ` thành `d` không nhất quán hoặc gập các nguyên âm có mũ/móc (`ă, â, ê, ô, ơ, ư`) sai ngữ cảnh khi chuỗi đầu vào bị trộn lẫn bộ gõ Telex hay Unicode tổ hợp/dựng sẵn.
  - Hậu quả là *"Đinh Tiên Hoàng"* và *"Dinh Tiên Hoàng"*, hay các tên đường/xã có chữ `Đ` bị lệch hash khi tạo khoá `addr_hash = md5(addr_norm)` trong PostGIS.

- **[01:00 – 01:55] CHUẨN HOÁ ĐÚNG CÁCH — `NFKD` + Bảng kiểm soát riêng cho `đ/Đ`:**
  - Trong playbook `Detail08_vietnamese_nlp.md`, nguyên tắc bất di bất dịch của mình là: **Luôn giữ nguyên chuỗi có dấu (`addr` gốc) để hiển thị cho người dùng**, và chỉ gập dấu vào trường `addr_norm` để lập chỉ mục và so khớp.
  - Thay vì dùng `unidecode` mù quáng, mình dùng chuẩn **phân rã Unicode `NFKD` kết hợp bảng chuyển đổi riêng cho chữ `đ/Đ`** (`đ→d, ă/â→a, ê→e, ô/ơ→o, ư→u`) cùng thư viện mã nguồn mở `underthesea` (`text_norm`) và `visen` (xử lý lỗi gõ Telex sang Unicode chuẩn).

- **[01:55 – 02:50] TỪ ĐIỂN VIẾT TẮT & ĐỒNG NGHĨA VÙNG MIỀN — Phần "Rule ổn định" không bao giờ phình:**
  - Nhiều người hỏi mình: *"Đã dùng AI Tagger rồi thì cần Rule làm gì nữa?"*. Câu trả lời là: Những quy ước bất biến của ngôn ngữ thì dùng Rule sẽ nhanh gấp 1.000 lần AI và đúng 100%.
  - Mình đóng gói đúng 1 file cấu hình `rules/abbrev.yaml` và bộ **~50 rule đầu tay** cho 3 việc:
    1. **Mở toàn bộ từ viết tắt hành chính & đô thị:** `P. → phuong`, `Q. → quan`, `TT. → thi tran`, `KĐT → khu do thi`, `KCN → khu cong nghiep`, `CC/CHCC → chung cu`.
    2. **Chuẩn hoá từ vựng vùng miền về chung 1 nhãn ngữ nghĩa:** `Ngõ (miền Bắc) = Hẻm (miền Nam) = Kiệt (miền Trung/Huế) = Ngách` → quy hết về token `alley`; `Thôn = Ấp = Xóm = Tổ dân phố = Khu phố` → quy hết về token `hamlet`.
    3. **So khớp theo âm tiết (`Syllable n-gram`):** Tiếng Việt là ngôn ngữ đơn lập theo âm tiết (*"Hai Bà Trưng"* là 1 thực thể 3 âm tiết), nên phải tách âm tiết bằng `underthesea word_tokenize` kết hợp `rapidfuzz` trên chuỗi `addr_norm` thay vì tách theo khoảng trắng kiểu tiếng Anh.

- **[02:50 – 03:45] BÀI TOÁN SÁP NHẬP HÀNH CHÍNH 2025 (63→34 TỈNH, 3→2 CẤP) — Đừng phát minh lại bánh xe!**
  - Một trong những việc ngốn nhiều nhân lực nhất của các đội làm bản đồ truyền thống là ngồi nhập tay bảng ánh xạ các xã, phường, tỉnh thành sau đợt sáp nhập hành chính lớn (mô hình 2 cấp: Tỉnh → Xã/Phường).
  - Tư duy của Indie Maker: **Kiểm tra cộng đồng Open Source trước khi tự làm!** Hiện tại bộ dữ liệu `undertheseanlp/address` (giấy phép Apache-2.0) đã có sẵn **10.602 bản ghi ánh xạ xã/phường** (sáp nhập, đổi tên, chia tách) cùng thư viện `vietnamadminunits` (MIT).
  - Mình chỉ mất đúng một buổi chiều để viết script nạp toàn bộ 10.602 bản ghi này làm hạt giống (`seed`) cho bảng `admin_units` và `admin_alias` (cấu trúc cây Trie) trong PostGIS. Khách gõ tên quận/phường cũ từ 5 năm trước, hệ thống tự động ánh xạ sang đơn vị hành chính 2 cấp mới trong chưa tới 1 mili-giây!

- **[03:45 – 04:15] KẾT & CALL TO ACTION:**
  - Chỉ với tầng Normalizer chuẩn chỉnh + 50 rule đầu tay + bộ ánh xạ hành chính mở, ngay trong Tuần 4 bộ Parser đã vượt mốc **85% địa chỉ đạt độ tin cậy cao** trên tập Golden Set của tỉnh pilot.
  - Anh em xem tiếp video Demo bên cạnh để thấy tốc độ biến một chuỗi địa chỉ viết tắt hỗn độn thành JSON chuẩn chỉ trong vài mili-giây nhé!

---

### 2B. Kịch bản Video Demo Sản phẩm / Product Marketing (Dựng trên Google Vids + AI Voiceover)

- **Tiêu đề gợi ý (YouTube Title):** Demo Bộ Chuẩn Hoá Địa Chỉ Tiếng Việt (`NFKD + đ/Đ`, Từ Vùng Miền & 10.602 Xã/Phường Sáp Nhập) | System Proof #03
- **Hình thức:** Google Vids (16:9), gồm 6 Scenes kéo thả trực tiếp kèm lời bình AI Voiceover (thời lượng ~3 phút 40 giây).
- **Danh sách Chapters (YouTube Studio):**
  - `00:00` Thử thách thực tế: Khi khách hàng gõ địa chỉ viết tắt, sai dấu và dùng tên hành chính cũ
  - `00:40` Tầng 1 — Chuẩn hoá `NFKD + Bảng đ/Đ` & Sửa lỗi bộ gõ Telex (`underthesea` / `visen`)
  - `01:20` Tầng 2 — Mở viết tắt (`rules/abbrev.yaml`) & Đồng nghĩa vùng miền (Ngõ/Hẻm/Kiệt, Thôn/Ấp)
  - `02:05` Tầng 3 — Ánh xạ tức thì 10.602 Xã/Phường sáp nhập (63→34 tỉnh, mô hình 2 cấp)
  - `02:50` Tầng 4 — Syllable N-gram & RapidFuzz: Bắt dính tên đường nhiều âm tiết
  - `03:20` Kết quả kiểm thử trên 300 Unit Tests & Golden Set Tỉnh Pilot

#### Bảng Phân Cảnh Chi Tiết (4 cột cho Google Vids):

| Scene & Timecode | Visual / Screenshot cần chèn vào Google Vids | Text hiển thị trên Slide (Ngắn gọn) | Lời bình (Voiceover Script cho AI đọc) |
|---|---|---|---|
| **Scene 1**<br>`00:00 – 00:40`<br>*(40 giây)* | Chèn ảnh chụp màn hình 5 câu địa chỉ "ác mộng" thực tế từ đơn hàng: viết tắt `"P. Bến Nghé, Q.1"`, `"KĐT Linh Đàm"`, `"Kiệt 45/2 Hùng Vương"`, lỗi gõ telex, kèm tên xã/huyện cũ trước sáp nhập. | **THỬ THÁCH ĐỊA CHỈ TIẾNG VIỆT**<br>Viết tắt · Lỗi dấu Telex · Phương ngữ Bắc-Trung-Nam · Đổi tên Xã/Phường | "Địa chỉ giao hàng tại Việt Nam là một bài toán xử lý ngôn ngữ tự nhiên đầy thách thức. Một chuỗi địa chỉ thực tế thường chứa hàng loạt từ viết tắt như KĐT, KCN, CHCC, pha trộn phương ngữ vùng miền như ngõ, ngách, hẻm, kiệt, và đặc biệt là việc người dân vẫn giữ thói quen ghi tên quận huyện, xã phường cũ trước khi sáp nhập hành chính." |
| **Scene 2**<br>`00:40 – 01:20`<br>*(40 giây)* | Chèn ảnh chụp màn hình đoạn code Python chuẩn hoá `NFKD + bảng đ/Đ` (**`Detail08_vietnamese_nlp.md §1`**) so sánh trực tiếp đầu ra với `unidecode` trên Terminal. | **CHUẨN HOÁ `NFKD` + BẢNG RIÊNG CHO `Đ/đ`**<br>Giữ nguyên dấu khi hiển thị · Chuẩn hoá tuyệt đối trên `addr_norm` | "Ở bước đầu tiên của đường ống xử lý, thay vì dùng hàm unidecode thông thường dễ làm mất chữ Đ hoặc sai lệch nguyên âm tiếng Việt, hệ thống áp dụng chuẩn phân rã NFKD kết hợp bảng kiểm soát riêng cho chữ Đ và thư viện chuẩn hoá mã nguồn mở. Hệ thống luôn lưu song song chuỗi gốc có dấu để hiển thị trên ứng dụng bưu tá và chuỗi chuẩn hoá không dấu để lập chỉ mục tốc độ cao." |
| **Scene 3**<br>`01:20 – 02:05`<br>*(45 giây)* | Chèn ảnh chụp màn hình file cấu hình **`rules/abbrev.yaml` (`Detail04 §3.1` & `Detail08 §2–3`)** và màn hình chạy thử biến đổi các từ viết tắt, phương ngữ về chuẩn thống nhất. | **TỪ ĐIỂN VIẾT TẮT & ĐỒNG NGHĨA VÙNG MIỀN**<br>`Ngõ = Ngách = Hẻm = Kiệt → alley`<br>`Thôn = Ấp = Xóm = TDP → hamlet` | "Tiếp theo, bộ quy tắc ổn định gồm năm mươi luật cốt lõi sẽ tự động bung toàn bộ từ viết tắt hành chính và đô thị như khu công nghiệp, khu đô thị, chung cư, tổ dân phố. Đồng thời, các phương ngữ vùng miền như ngõ, ngách ở miền Bắc, kiệt ở miền Trung và hẻm ở miền Nam đều được quy chuẩn về cùng một thực thể không gian thống nhất." |
| **Scene 4**<br>`02:05 – 02:50`<br>*(45 giây)* | Chèn ảnh chụp màn hình bảng PostGIS **`admin_units` và `admin_alias` (`Detail04 §2`)** được nạp từ bộ dữ liệu **10.602 bản ghi `undertheseanlp/address` + `vietnamadminunits`**, demo 1 câu truy vấn đổi địa chỉ 3 cấp cũ sang 2 cấp mới trong `<1ms`. | **ÁNH XẠ TỰ ĐỘNG 10.602 XÃ/PHƯỜNG SÁP NHẬP**<br>Chuyển đổi mô hình 3 cấp cũ → 2 cấp mới (63 → 34 tỉnh) trong `< 1ms` | "Để giải quyết bài toán thay đổi địa giới hành chính sang mô hình hai cấp, hệ thống tích hợp trực tiếp hơn mười nghìn sáu trăm bản ghi ánh xạ xã phường từ kho dữ liệu mở vào bảng admin alias trên PostGIS. Khi khách hàng nhập tên phường xã cũ đã sáp nhập hoặc đổi tên, cấu trúc tìm kiếm Trie sẽ tự động quy chiếu về đúng mã đơn vị hành chính mới chỉ trong chưa đầy một mili-giây." |
| **Scene 5**<br>`02:50 – 03:20`<br>*(30 giây)* | Chèn ảnh chụp màn hình minh hoạ tách âm tiết tiếng Việt (`underthesea word_tokenize` + `syllable n-gram`) kết hợp `RapidFuzz` bắt đúng tên đường *"Hai Bà Trưng"*, *"Nguyễn Thị Minh Khai"* dù khách gõ dính chữ hoặc sai 1 ký tự. | **SO KHỚP ÂM TIẾT (`SYLLABLE N-GRAM`) & RAPIDFUZZ**<br>Nhận diện chính xác tên đường tiếng Việt đa âm tiết | "Vì tiếng Việt có đặc trưng cấu tạo theo âm tiết nên tên một con đường như Hai Bà Trưng gồm ba âm tiết đi liền nhau. Hệ thống sử dụng kỹ thuật tách từ kết hợp so khớp mờ RapidFuzz theo cụm âm tiết, giúp bắt trúng tên đường và địa danh ngay cả khi người dùng gõ thiếu khoảng trắng hoặc sai chính tả." |
| **Scene 6**<br>`03:20 – 03:40`<br>*(20 giây)* | Chèn ảnh chụp màn hình Terminal chạy `pytest tests/unit/test_parser.py` (**300 unit tests từ Golden Set pass 100%**) và bảng kết quả đánh giá Tuần 4 (`parse_conf ≥ 0.5` cho `≥ 85%` địa chỉ pilot). | **VƯỢT MỐC KPI TUẦN 4**<br>300/300 Unit Tests Passed<br>`≥ 85%` địa chỉ tỉnh Pilot đạt `parse_conf ≥ 0.5` | "Kết hợp tầng chuẩn hoá ngôn ngữ, năm mươi quy tắc cốt lõi và mô hình gán nhãn chuỗi, hệ thống đã vượt qua trọn vẹn ba trăm bài kiểm thử thực tế từ tập Golden Set, đạt độ phủ phân tích tự tin trên tám mươi lăm phần trăm ngay trong tuần thứ tư." |
