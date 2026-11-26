# ADR-0001 — Làm nội bộ cho công ty trước, thiết kế sẵn để mở mã sau

- **Trạng thái:** Chấp nhận
- **Ngày:** 2026-11-06
- **Người quyết định:** [Người duy trì dự án]
- **Liên quan:** ADR-0002, ADR-0003, ADR-0004

## Bối cảnh

Giai đoạn đầu, dự án được làm cho công ty và chạy nội bộ. Case đầu tiên là ứng dụng logistics: danh bạ bưu cục và đại lý, đơn tồn, sản lượng theo ngày, màn điều hành 3D cho HO. Khi case này chạy tốt, phần lõi sẽ được mở mã để làm nền chung cho cộng đồng và cho các đối tác.

Nếu viết thẳng cho hệ thống của công ty (tên bảng nội bộ, mã trạng thái nội bộ, kết nối DB nội bộ nằm rải trong mã lõi), thì đến lúc mở mã sẽ phải viết lại gần như toàn bộ. Ngược lại, nếu tách lõi khỏi phần riêng của công ty ngay từ đầu, việc mở mã sau này chỉ là tách một thư mục sang repo mới.

## Quyết định

### 1. Repo nội bộ, nhưng chia hai phần ngay từ đầu

```
core/                      # phần sẽ mở mã sau này: không biết gì về công ty
  ontology/  registry/  events/  metrics/  twin/  ai_report/  geo/
connectors/<org>/          # đọc dữ liệu từ hệ thống của công ty (DB, CDC, file)
deployments/<org>/         # cấu hình, ánh xạ mã trạng thái, ngưỡng cảnh báo, giao diện riêng
```

- `core/` không được import từ `connectors/` hoặc `deployments/`. CI kiểm tra quy tắc này.
- `core/` không chứa tên bảng, tên hệ thống, mã trạng thái hay URL nội bộ của công ty. Những thứ đó đi qua connector và bảng ánh xạ trong `deployments/<org>/`.

### 2. Dùng dữ liệu thật cho case đầu

- Pilot chạy trên dữ liệu thật của công ty qua connector.
- `core/` có bộ test riêng chạy trên tập dữ liệu mẫu nhỏ, không phụ thuộc dữ liệu công ty. Nhờ vậy khi tách `core/` ra, bộ test vẫn chạy được ngay.

### 3. Đặt sẵn các trường giúp mở mã về sau, dù hiện chỉ có một tổ chức

Mọi bản ghi trong ontology (ADR-0003) mang:

- `tenant_id`: hiện chỉ có một giá trị là công ty. Thêm cột bây giờ gần như không tốn gì; thêm sau khi đã có hàng chục bảng và hàng tỉ dòng thì là một migration lớn.
- `data_class`: `public` (đơn vị hành chính, danh bạ điểm công khai), `internal` (đơn tồn, sản lượng, năng lực kho), `personal` (đơn hàng, địa chỉ người nhận, GPS bưu tá). Trường này dùng cho phân quyền, cho việc giới hạn dữ liệu mà công cụ AI được đọc, và sau này để xuất bản phần `public` bằng một bộ lọc.

Tên và số điện thoại khách không đi vào ontology; mã đơn được băm có khoá khi nạp. Đây là lựa chọn kỹ thuật để ontology gọn và để phần lõi không bao giờ phải "làm sạch" trước khi mở.

### 4. Chọn thành phần có giấy phép mở

Mọi thành phần phụ thuộc chọn loại có giấy phép mã mở phổ biến (xem bảng trong ADR-0002), để lúc mở mã không phải thay công nghệ.

### 5. Tiêu chí "case đầu đã tốt" để chuyển sang mở mã

Đề xuất (người duy trì chốt lại con số cụ thể):

- HO dùng màn điều hành hằng ngày liên tục ít nhất 8 tuần.
- Số đơn tồn và sản lượng ngày khớp hệ thống nguồn của công ty trong ngưỡng sai lệch đã thống nhất.
- Có ít nhất một quyết định vận hành được ghi nhận là nhờ màn điều hành (ví dụ điều chuyển nhân lực khi một bưu cục ùn tắc).
- `core/` chạy được toàn bộ test mà không cần `connectors/` và `deployments/`.

### 6. Cách mở mã khi tới lúc

- Tạo repo mới từ bản chụp của `core/` (không mang lịch sử commit của repo nội bộ).
- Chọn giấy phép và quy trình đóng góp tại thời điểm đó, trong một ADR riêng.
- Repo nội bộ của công ty chuyển sang dùng `core/` mở như một phụ thuộc, chỉ giữ lại `connectors/` và `deployments/`.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Vì sao bỏ |
|---|---|---|---|
| Mở mã ngay từ đầu | Cộng đồng tham gia sớm | Chưa có case chứng minh; làm chậm case đầu | Không hợp với giai đoạn làm cho công ty |
| Viết thẳng cho hệ thống công ty, không tách | Nhanh nhất trong vài tuần đầu | Đến lúc mở mã phải viết lại; mã lõi dính chặt vào hệ thống nội bộ | Mất gần hết giá trị khi chuyển sang mở |
| Viết cho công ty rồi fork và dọn khi mở | Không cần kỷ luật lúc đầu | Việc dọn không bao giờ xong; hai nhánh lệch nhau | Chi phí cao hơn tách từ đầu |

## Hệ quả

**Tích cực**
- Case đầu dùng dữ liệu thật, không bị ràng buộc bởi yêu cầu mở mã.
- Mở mã sau này là tách thư mục, không phải viết lại.
- Kiến trúc đa tổ chức có sẵn khi đối tác thứ hai tham gia.

**Đánh đổi**
- Thêm một lớp connector và bảng ánh xạ thay vì đọc thẳng bảng nội bộ.
- Phải duy trì tập dữ liệu mẫu cho test của `core/`.
- Mọi bảng thêm hai cột `tenant_id` và `data_class`.

## Khi nào xem lại

- Công ty quyết định không mở mã: có thể bỏ quy tắc tách `core/`, giữ lại `tenant_id` và `data_class` vì vẫn hữu ích cho phân quyền.
- Có đối tác muốn tham gia trước khi đạt tiêu chí ở mục 5: cân nhắc mở sớm một phần (ví dụ ontology và danh bạ mạng lưới).
