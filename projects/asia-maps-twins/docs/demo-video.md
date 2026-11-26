# Kịch bản quay video thuyết minh sản phẩm

Dài khoảng 12 phút, 10 cảnh. Mọi con số trong kịch bản đều đo được trên máy MacBook M1 Pro với dữ liệu mở toàn quốc (2026-11-06). Ảnh tham khảo của từng cảnh nằm trong [docs/demo/](demo/).

## 1. Chuẩn bị trước khi quay

```bash
make bootstrap
```

Lần đầu mất khoảng 20 phút (tải dữ liệu OSM, dựng OSRM và Valhalla, nạp dữ liệu); các lần sau khoảng 10 giây. Lệnh kết thúc bằng danh sách địa chỉ cần mở.

Checklist:

- [ ] `make bootstrap` chạy xong, dòng kiểm tra nhanh in ra "59 Nguyễn Huệ, Phường Sài Gòn, ...".
- [ ] Mở `http://127.0.0.1:8800/demo` trên Chrome, cửa sổ 1440×900 trở lên. Máy cần Internet để tải bản đồ nền và phông chữ.
- [ ] Bấm thử một lượt mọi nút để bản đồ nền tải sẵn vào cache (Hà Nội, TP.HCM, tuyến Hà Nội – Hải Phòng).
- [ ] Terminal phông chữ to (khoảng 18–20 pt), nền tối, đứng ở thư mục gốc của repo.
- [ ] Tắt thông báo hệ thống.

## 2. Kịch bản từng cảnh

### Cảnh 0 — Mở đầu (30 giây)

**Hình:** trang demo ở chế độ toàn quốc.

**Lời gợi ý:** "Mỗi đơn hàng logistics cần trả lời ba câu: khách đang gõ địa chỉ gì, địa chỉ đó ở đâu, và từ A đến B bao xa theo đường thật. Hôm nay dùng Google thì vừa tốn tiền, vừa hay sai ở ngõ, hẻm, thôn, xóm, lại không hiểu địa chỉ sau sáp nhập. Đây là base tự host, chạy trên dữ liệu mở của cả nước, trả lời cả ba câu."

### Cảnh 1 — Dựng một lệnh (30 giây)

**Hình:** terminal chạy `make bootstrap` (máy đã có dữ liệu nên xong trong khoảng 10 giây).

**Lời gợi ý:** "Toàn bộ hệ thống, gồm API, PostGIS, engine tìm đường Valhalla và OSRM, dựng bằng một lệnh. Không phí bản quyền, không gọi dịch vụ bên ngoài."

### Cảnh 2 — Gợi ý địa chỉ khi gõ (1 phút)

**Hình:** tab "Địa chỉ", gõ chậm từng chữ vào ô nhập.

| Gõ | Điều cần chỉ ra |
|---|---|
| `pho hue ha n` | Gõ không dấu, gõ dở vẫn ra "Phố Huế, Phường Hai Bà Trưng, Hà Nội"; dòng cuối danh sách hiện số mili-giây |
| `nguyen trsi` | Gõ sai một chữ vẫn ra "Nguyễn Trãi" |
| `kcn que vo` | Viết tắt "KCN" được hiểu là khu công nghiệp |

**Con số:** khoảng 340 nghìn mục gợi ý toàn quốc; p50 5 ms, p95 32 ms.

**Lời gợi ý:** "Gợi ý chạy trên toàn quốc, mỗi lần gõ chỉ mất vài mili-giây; không dấu, viết tắt hay gõ sai đều được."

### Cảnh 3 — Phân giải địa chỉ và độ tin cậy (2 phút)

**Hình:** bấm lần lượt các địa chỉ mẫu ở đầu tab.

| Địa chỉ mẫu | Kết quả | Điều cần chỉ ra |
|---|---|---|
| `59 nguyen hue p ben nghe q1 tphcm` | Nội suy số nhà, Nguyễn Huệ, **Phường Sài Gòn**, độ tin cậy 0,68 | Địa chỉ cũ 3 cấp (P. Bến Nghé, Q.1), gõ không dấu, không dấu phẩy, vẫn được chuyển sang phường mới sau sáp nhập |
| `Thôn Đông, xã Tân Lập, huyện Đan Phượng, Hà Nội` | Tâm xã, **Xã Ô Diên**, 0,27 | Bẫy kinh điển: chữ "Đan Phượng" trùng tên một xã mới. Base nhận ra đây là địa chỉ cũ nên không khớp nhầm; không tìm được thôn thì trả tâm xã với độ tin cậy thấp, không bịa vị trí |
| `KCN Quế Võ, Bắc Ninh` | Địa danh: Khu công nghiệp Quế Võ, 0,55 | Hiểu tên khu công nghiệp |
| `Chợ Bến Thành, Phường Bến Thành, TP.HCM` | Địa danh: Chợ Bến Thành, 0,55 | Hiểu địa danh |

**Điểm nhấn của cảnh:** thanh độ tin cậy có hai vạch 0,5 và 0,7, kèm dòng hành động bên dưới:

- ≥ 0,7: tự động gán bưu cục;
- 0,5–0,69: gán, và bưu tá xác nhận khi phát;
- < 0,5: hỏi lại khách.

**Lời gợi ý:** "Mỗi kết quả đều có độ tin cậy, và độ tin cậy không để trang trí: nó là cầu dao quyết định đơn được tự gán bưu cục hay phải hỏi lại khách. Hệ thống không bao giờ giả vờ chắc chắn."

**Con số:** đo trên 1.000 địa chỉ OSM mà hệ thống chưa từng thấy (luật + ML): 74% nằm trong 200 m, 86% trong 500 m, sai số trung vị 41 m, p95 khoảng 37 ms. Gõ không dấu hay viết tắt cho kết quả y hệt có dấu.

### Cảnh 3b — AI hiểu địa chỉ: luật, học máy, mô hình quyết định (2 phút)

**Hình:** tab "Hiểu địa chỉ AI" ([ảnh](demo/6-hieu-dia-chi.png)), bấm mẫu `so 8 to hieu phuong nghia do ha noi`.

**Điều cần chỉ ra:**

- Tầng 1, luật: chuẩn hoá chữ, nhận ra Phường Nghĩa Đô.
- Tầng 3, tagger: từng từ được tô màu theo nhãn; "to hieu" được hiểu là **đường** (phố Tô Hiệu) với 99%.
- Tầng 4, quyết định: luật hiểu "to hieu" là **tổ** Hiệu, chỉ tìm được mức tên đường (0,69); tagger nội suy được số nhà (0,95). Mô hình chọn tagger.
- Cuộn xuống "Trạng thái học máy": bảng hiệu chỉnh cho thấy độ tin cậy dự đoán khớp tỉ lệ đúng thật.

**Con số:**

- Tagger đúng phần dưới cấp xã ở 93% trên tập địa chỉ lộn xộn do người gán nhãn; 0,2 ms mỗi địa chỉ.
- Trên 1.000 địa chỉ đánh giá: trong 200 m từ 72,0% (chỉ luật) lên 74,2% (luật + ML); sai số trung vị từ 48,5 m xuống 40,6 m.
- Sai số hiệu chỉnh (ECE) giảm từ 0,14 xuống 0,04: báo 0,9 thì khoảng 90% đúng thật.

**Lời gợi ý:** "Luật làm phần chắc chắn, học máy làm phần mơ hồ, một mô hình quyết định chọn cách hiểu tốt nhất và nói thật mình chắc bao nhiêu. LLM không bao giờ nằm trong đường xử lý: nó chỉ chạy ban đêm, gán nhãn những ca khó để hôm sau mô hình giỏi hơn. Mô hình mới chỉ được dùng khi điểm không kém bản cũ."

### Cảnh 4 — Khoảng cách thực tế: xe máy khác ô tô (1 phút 30 giây)

**Hình:** tab "Khoảng cách", bấm "Hà Nội → Hải Phòng".

**Điều cần chỉ ra:**

- Ô tô (xanh) đi cao tốc Hà Nội – Hải Phòng: 123,6 km, 1 giờ 43 phút.
- Xe máy (cam) không được đi cao tốc nên đi quốc lộ: 109,5 km nhưng mất 2 giờ 48 phút.

Sau đó kéo bản đồ về nội thành TP.HCM (zoom khoảng 12) và bấm "Tính ma trận 100 × 100": 10.000 cặp điểm theo đường thật trong khoảng 0,4 giây, không ô nào phải ước lượng.

**Lời gợi ý:** "Logistics Việt Nam chạy bằng xe máy. Base tính tuyến riêng cho xe máy, ô tô và xe tải. Ma trận 10.000 cặp cho bài toán phân tuyến chỉ mất chưa tới nửa giây."

### Cảnh 5 — Chuẩn Google: đổi host là chạy (1 phút)

**Hình:** tab "Chuẩn Google", bấm "Gọi" cho Geocoding, rồi Autocomplete, rồi Distance Matrix. Chỉ vào dòng URL `maps.googleapis.com/... → 127.0.0.1:8800/...`.

Sau đó chuyển sang terminal:

```bash
uv run pytest tests/integration/test_google_compat.py -v
```

17/17 trường hợp đạt, dùng chính thư viện `googlemaps` chính thức của Google, chỉ đổi `base_url`.

**Lời gợi ý:** "App và web đang gọi Google không phải viết lại. Cùng đường dẫn, cùng tham số, cùng cấu trúc JSON. Bằng chứng là thư viện chính thức của Google chạy được nguyên vẹn."

### Cảnh 6 — Sẵn sàng chạy shadow (1 phút)

**Hình:** terminal.

```bash
make shadow-report DAYS=1
```

Rồi mở `http://127.0.0.1:8800/metrics`.

**Điều cần chỉ ra:** mỗi lời gọi được ghi kèm hệ thống gọi và mã đơn; báo cáo có tỉ lệ tự gán được, khoảng cách tới Google, tỉ lệ chọn gợi ý trong top-3. Số điện thoại lẫn trong địa chỉ được tự che.

**Lời gợi ý:** "Trước khi chuyển hẳn, base chạy song song với Google, ghi lại mọi kết quả kèm mã đơn. Khi bưu tá quét phát thành công, mỗi đơn trở thành một điểm dữ liệu đúng, và hệ thống tốt lên mỗi ngày mà không phải mua dữ liệu."

### Cảnh 7 — Ontology: nền cho các tầng sau (2 phút)

**Hình:** terminal chạy từng cảnh, bấm Enter để sang cảnh tiếp.

```bash
make ontology-demo STEP=1
```

| Cảnh trong demo | Điều cần chỉ ra |
|---|---|
| 1. Một nguồn định nghĩa | 2 file YAML (khoảng 310 dòng) sinh ra bảng PostGIS, model API, JSON Schema và công cụ AI (khoảng 1.700 dòng), không ai viết tay |
| 2. Mọi thay đổi đi qua action | Nhật ký ghi rõ ai làm gì, lúc nào |
| 3. Chặn dữ liệu sai | Đăng ký bưu cục vào cấp tỉnh, trùng mã, sai loại điểm: cả ba bị chặn, kèm lý do bằng tiếng Việt |
| 4. Du hành thời gian | Cùng bưu cục BC01: 31/12/2025 thuộc "Xã Mẫu Một", 01/02/2026 thuộc "Phường Mẫu Một" (đổi tên), 15/03/2026 thuộc "Xã Mẫu Hai" (chuyển địa bàn). Không ghi đè, giữ đủ lịch sử |
| 5. Chỉ số định nghĩa một lần | `backlog_count` trả 2 → 2 → 3 đơn tồn theo giờ; dashboard, màn 3D và AI dùng chung con số này |
| 6. Công cụ cho AI | 12 công cụ sinh tự động; công cụ thay đổi dữ liệu phải có người duyệt |

**Lời gợi ý:** "Phía sau ba API là một ontology theo mô hình của Palantir Foundry: đối tượng, liên kết, hành động và hàm. Sáp nhập hành chính, đổi tên, chuyển địa bàn đều được lưu theo thời gian. AI agent làm việc qua công cụ có kiểu, không tự viết SQL, không bịa số."

Ghi chú: dữ liệu trong demo ontology là dữ liệu mẫu.

### Cảnh 8 — Kết (30 giây)

**Hình:** trang demo, hoặc slide tổng kết.

**Lời gợi ý:** "Một lệnh để dựng, ba năng lực lõi chạy trên toàn quốc, tương thích Google, sẵn sàng chạy song song, và một ontology làm nền cho các tầng điều hành, AI và digital twin phía sau. Toàn bộ là mã nguồn mở, dữ liệu mở, tự host."

## 3. Điểm nhấn và bằng chứng

| Điểm ưu việt | Bằng chứng để nói |
|---|---|
| Hiểu địa chỉ Việt Nam thật | Không dấu, viết tắt (P., Q., TP., KCN, KĐT), ngõ/ngách/hẻm/kiệt, gõ sai, cho kết quả gần như bằng có dấu |
| Hiểu địa chỉ sau sáp nhập 2025 | Địa chỉ cũ 3 cấp tự chuyển sang đơn vị 2 cấp mới; tránh được bẫy trùng tên (Đan Phượng) |
| Không giả vờ chắc chắn | Mỗi kết quả có mức và độ tin cậy; độ tin cậy quyết định tự gán hay hỏi lại |
| Độ tin cậy là xác suất thật | Mô hình quyết định hiệu chỉnh: ECE 0,04 (báo 0,9 thì khoảng 90% đúng trong 200 m) |
| Tự tốt lên, ít công vận hành | `make learn` mỗi đêm: LLM gán nhãn ca khó, chặn bịa, cổng chất lượng; người chỉ duyệt ca bất đồng |
| Nhanh | Gợi ý p95 32 ms; phân giải p95 khoảng 37 ms (gồm cả học máy); ma trận 10.000 cặp khoảng 0,35 giây |
| Đúng cho xe máy | Tuyến xe máy tránh cao tốc; Hà Nội – Hải Phòng: 2 giờ 48 phút so với 1 giờ 43 phút của ô tô |
| Không phải viết lại app | Thư viện `googlemaps` chính thức chạy 17/17 khi chỉ đổi host |
| Không phụ thuộc, không phí | Dữ liệu mở (OSM, danh mục hành chính), mã nguồn mở, tự host; không gửi dữ liệu khách ra ngoài |
| Tự tốt lên theo vận hành | Log kèm mã đơn, sẵn sàng đối chiếu GPS phát thành công; công cụ phát lại có cột toạ độ thật để chạy golden set |
| Kiểm chứng được | 169 test cho base, 25 test cho ontology; bộ đo độ chính xác chạy lại bằng `make eval` |
| Nền cho tầng sau | Ontology có đối tượng, hành động, hàm, lịch sử theo thời gian, công cụ AI sinh tự động |

## 4. Nói đúng giới hạn (đừng hứa quá)

| Nếu được hỏi | Trả lời trung thực |
|---|---|
| Độ chính xác 74% trong 200 m đo trên gì? | Trên địa chỉ có số nhà của OpenStreetMap mà hệ thống chưa thấy, chưa phải địa chỉ khách thật. Con số thật đo được ngay khi có GPS phát thành công của công ty |
| Sao nhiều kết quả chỉ ở mức "trên đường"? | OSM thiếu số nhà ở Việt Nam. Tầng điểm giao thành công từ dữ liệu công ty là phần nâng mạnh nhất, đã có sẵn chỗ trong cascade |
| Thời gian xe máy trong ma trận có chính xác không? | Tuyến từng chuyến dùng engine xe máy thật. Ma trận dùng profile ô tô bỏ cao tốc, nên thời gian xe máy là ước lượng; sẽ học lại từ GPS bưu tá |
| App dùng Google SDK trên điện thoại đổi được không? | Không, đổi host chỉ áp dụng cho lời gọi HTTP. SDK và widget JavaScript tự gọi máy chủ Google |
| Có chỉ đường rẽ trái/phải không? | Chưa, mới có tuyến để vẽ lên bản đồ |
| Số đo hiệu năng chạy trên máy nào? | MacBook M1 Pro, toàn quốc. Máy chủ thật cần đo lại |
| LLM có chạy trong demo không? | Máy demo chưa cài LLM nên bước LLM được bỏ qua; luật, tagger và mô hình quyết định vẫn chạy đầy đủ. Bật bằng `BDS_LLM_URL`, `BDS_LLM_MODEL` (Ollama/vLLM tự host) |
| Mô hình học từ đâu khi chưa có dữ liệu công ty? | Từ dữ liệu sinh ghép từ tên thật trong OSM và danh mục hành chính, chấm trên tập người gán nhãn; mô hình quyết định học trên địa chỉ OSM để dành. Khi có GPS phát thành công thì học trên nhãn thật |
| Ontology đã nối với ba API chưa? | Chưa. Ontology đang ở dạng PoC đã kiểm chứng; sẽ nối khi có đối tượng nghiệp vụ như bưu cục, điểm giao |

## 5. Sau khi quay

```bash
make down
```

Dữ liệu vẫn giữ trong `data/`; lần sau `make bootstrap` khoảng 10 giây là chạy lại được.
