# ADR-0003 — Ontology định nghĩa bằng code, một nguồn duy nhất

- **Trạng thái:** Chấp nhận (PoC đạt 2026-11-06, xem mục "Kiểm chứng")
- **Ngày:** 2026-11-06
- **Người quyết định:** [Người duy trì dự án]
- **Liên quan:** ADR-0001, ADR-0002

## Bối cảnh

Hướng kiến trúc ghi trong `research/Ontology.md`: phân cấp dữ liệu thành các lớp, dựng đồ thị quan hệ giữa các thông tin, gom nhiều nguồn vào một ontology, rồi để AI tổng hợp báo cáo.

Những vấn đề ontology phải giải quyết:

- **Nhiều nguồn mô tả cùng một thực thể.** Một bưu cục có thể xuất hiện trong danh sách của hãng, trong OSM, trong Overture và trong đóng góp của cộng đồng, với toạ độ và tên khác nhau.
- **Thực thể thay đổi theo thời gian.** Sáp nhập hành chính 63→34 tỉnh, 3→2 cấp làm xã đổi tên, bưu cục đổi địa bàn, vùng phục vụ đổi ranh giới. Báo cáo lịch sử phải dùng đúng trạng thái tại thời điểm đó.
- **Nhiều hệ thống nguồn trong công ty** (và sau khi mở mã, nhiều hãng) cùng đẩy sự kiện đơn, nên cần một mô hình sự kiện trung lập.
- **Cùng một con số phải giống nhau ở mọi nơi.** Nếu dashboard, API, màn 3D và AI report mỗi nơi tự tính "đơn tồn" thì sẽ có nhiều con số khác nhau.
- **Định nghĩa trùng lặp ở nhiều nơi** (bảng DB, model API, JSON Schema, tài liệu) sẽ lệch nhau theo thời gian.

## Quyết định

### 1. Ontology viết bằng LinkML, là nguồn định nghĩa duy nhất

- Các kiểu đối tượng, thuộc tính, kiểu liên kết và danh mục giá trị được định nghĩa trong các file YAML **LinkML** đặt tại `ontology/`.
- Từ đó sinh tự động: DDL Postgres, model Pydantic cho API, JSON Schema cho data contract khi nạp dữ liệu, JSON-LD context cho liên thông, và tài liệu tra cứu.
- Không ai viết tay bảng hoặc model trùng với ontology. CI kiểm tra mã sinh ra khớp với file định nghĩa.
- Phác thảo (chưa kiểm chứng, sẽ chốt sau PoC):

```yaml
classes:
  Record:                      # lớp gốc: mọi đối tượng đều kế thừa
    abstract: true
    attributes:
      source:      {range: SourceSystem, required: true}
      confidence:  {range: float, minimum_value: 0, maximum_value: 1}
      valid_from:  {range: date, required: true}
      valid_to:    {range: date}
      tenant_id:   {range: string, required: true}
      data_class:  {range: DataClass, required: true}   # public / internal / personal (ADR-0001)
      license:     {range: DataLicense}                 # giấy phép của nguồn: OSM, Overture, nội bộ
  Facility:
    is_a: Record
    attributes:
      code:          {identifier: true}
      name:          {required: true}
      facility_type: {range: FacilityType, required: true}
      operated_by:   {range: Organization, required: true}
      in_admin_unit: {range: AdminUnit, required: true}
      location:      {range: PointWKT} # kiểu có annotation postgis: geometry(Point,4326)
enums:
  FacilityType:
    permissible_values: [post_office, agent, hub, warehouse, pickup_point, locker]
```

### 2. Ontology v0 chỉ gồm các kiểu đối tượng cần cho ứng dụng logistics đầu tiên

| Nhóm | Kiểu đối tượng |
|---|---|
| Hành chính | `AdminUnit` (2 cấp, có `valid_from/to`), `AdminUnitAlias` (tên cũ, viết tắt, ánh xạ 3 cấp → 2 cấp) |
| Tổ chức | `Organization` (hãng, địa phương, cộng đồng) |
| Mạng lưới | `Facility` (bưu cục, đại lý, hub, kho, điểm gửi nhận, tủ khoá), `ServiceZone` (vùng phục vụ) |
| Vận hành | `ShipmentEvent` (append-only) |
| Liên kết | `Facility —thuộc→ AdminUnit`, `Facility —vận hành bởi→ Organization`, `Facility —phục vụ→ ServiceZone`, `Facility —trung chuyển tới→ Facility` |

Các kiểu cho engine địa chỉ (`DeliveryPoint`, `Street`, `Building`, `GoldenAddress`) được thêm khi tới phase đó, qua quy trình RFC.

### 3. Mọi bản ghi có lineage và thời gian hiệu lực

- Lớp gốc `Record` mang `source`, `confidence`, `valid_from`, `valid_to`, `tenant_id`, `data_class`, `license`.
- Sửa một đối tượng là **đóng bản cũ (`valid_to`) và mở bản mới**, không ghi đè. Truy vấn "tại thời điểm t" là truy vấn chuẩn.
- Khi nhiều nguồn mô tả cùng một thực thể, mỗi nguồn giữ bản ghi riêng; một bản ghi hợp nhất (`canonical`) trỏ về các nguồn và ghi rõ quy tắc chọn. Không xoá dữ liệu nguồn.

### 4. Sự kiện đơn theo khung GS1 EPCIS 2.0

- `ShipmentEvent` mô tả *cái gì* (mã đơn đã băm có khoá), *khi nào*, *ở đâu* (`Facility`), *vì sao* (`event_type`, `reason_code`), theo khung của chuẩn mở EPCIS 2.0, rút gọn cho logistics chuyển phát.
- Không có trường nào chứa tên hay số điện thoại người nhận (ADR-0001).
- Mã trạng thái nội bộ của công ty được ánh xạ sang `event_type` chung qua bảng ánh xạ đặt trong `deployments/<org>/` (ADR-0001), không viết cứng trong lõi.

### 5. Chỉ số định nghĩa một lần, trong code

- Các chỉ số như `backlog_count`, `backlog_aging_bucket`, `daily_inbound`, `daily_outbound`, `daily_delivered`, `daily_failed` được định nghĩa một lần trong module `ops.metrics`, kèm mô tả nghiệp vụ, đơn vị, múi giờ và giờ chốt ngày.
- Dashboard, API, màn 3D và công cụ AI (qua MCP) đều gọi cùng định nghĩa này. Không nơi nào tự tính lại.
- Mỗi chỉ số có test đối chiếu với tập dữ liệu mẫu có đáp án biết trước.

### 6. Quan hệ lưu dạng bảng, truy vấn dạng đồ thị khi cần

- Đối tượng là bảng, liên kết là bảng liên kết có kiểu, đều nằm trong Postgres (ADR-0002).
- Khi có truy vấn nhiều bước mà SQL trở nên khó đọc, bật extension **Apache AGE** trên chính các bảng đó. Không dựng graph database riêng.

### 7. Thay đổi ontology có review và ghi chú tương thích

Ontology là hợp đồng giữa các module, và sau khi mở mã là hợp đồng giữa các tổ chức. Mọi thay đổi đi qua PR có review. Thay đổi phá tương thích (đổi tên, bỏ thuộc tính, đổi nghĩa giá trị danh mục) phải kèm một ADR ngắn và hướng dẫn chuyển đổi. Khi đã mở mã, bước này chuyển thành RFC công khai.

### 8. Bốn khối theo mô hình Palantir: Object · Link · Action · Function, cộng Interface

Bổ sung sau khi tham khảo Palantir Foundry, Microsoft Fabric IQ, Overture GERS và Google Data Commons (báo cáo):

1. **Interface** khai báo bằng `mixin` của LinkML. Ví dụ `NetworkNode` được `Facility` hiện thực; `Place` dùng chung cho `AdminUnit` và `ServiceZone`.
2. **Action type** khai báo trong `ontology/kinetic.yaml`: tham số, điều kiện hợp lệ, thay đổi trên object, và một bản ghi vào `action_log`. Mọi thay đổi dữ liệu nghiệp vụ đều đi qua action, dù người làm là người dùng, job hay AI agent.
3. **Function và chỉ số** khai báo cùng file, kèm SQL, đơn vị và test có đáp án.
4. **ID thực thể ổn định**: `entity_id` giữ nguyên qua mọi phiên bản, mỗi phiên bản có `version_id` riêng. Bảng `source_ref` ánh xạ mã của từng nguồn về `entity_id`, theo cách bridge files của GERS làm.
5. **Song thời gian**: `valid_from/valid_to` là thời gian ngoài đời, `recorded_at` là thời điểm hệ thống ghi nhận. Ràng buộc trong DB chặn các khoảng hiệu lực chồng nhau.
6. **Công cụ AI sinh từ ontology**: mỗi object type, function và action sinh ra một định nghĩa công cụ có JSON Schema, sẵn cho MCP server. Action do AI đề xuất cần người xác nhận.
7. **Observation** (thực thể, biến, ngày, giá trị, nguồn) theo kiểu Data Commons, dùng chung cho sản lượng ngày và dữ liệu thống kê địa phương.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Vì sao bỏ |
|---|---|---|---|
| Viết tay bảng SQL, model Pydantic và JSON Schema riêng | Không cần học công cụ mới | Định nghĩa lặp ở 3–4 nơi, lệch nhau theo thời gian | Trái DRY |
| Pydantic làm nguồn định nghĩa, sinh DDL bằng SQLAlchemy/Alembic | Quen thuộc với dev Python | Không có JSON-LD, không có danh mục và quan hệ ngữ nghĩa cho liên thông | Giữ làm **phương án dự phòng** nếu LinkML không qua PoC |
| OWL/RDF và triple store | Chuẩn ngữ nghĩa đầy đủ, suy luận được | Nặng, ít dev biết, hiệu năng truy vấn vận hành kém | Quá mức cần thiết; LinkML vẫn xuất được OWL khi cần |
| Graph database (Neo4j) làm lõi ontology | Truy vấn quan hệ tự nhiên | Thêm một nguồn sự thật, dữ liệu không gian yếu hơn PostGIS, giấy phép GPLv3/thương mại | Trái ADR-0002 |
| Mô hình sự kiện riêng của dự án | Tự do thiết kế | Các hãng phải học thêm một định dạng | EPCIS là chuẩn trung lập, dễ thuyết phục nhiều bên |

## Hệ quả

**Tích cực**
- Một chỗ định nghĩa, mọi lớp đổi theo; người đóng góp đọc ontology là hiểu hệ thống.
- Báo cáo lịch sử đúng qua các đợt sáp nhập hành chính.
- AI report đọc đúng con số của dashboard, nên báo cáo kiểm chứng được.
- Liên thông với bên ngoài qua JSON-LD và EPCIS mà không phải viết thêm.

**Đánh đổi**
- Người đóng góp phải học thêm LinkML ở mức cơ bản.
- Hình học PostGIS không phải kiểu có sẵn của LinkML; cần một bước ánh xạ khi sinh DDL.
- Lưu theo thời gian hiệu lực làm dữ liệu lớn hơn và truy vấn phức tạp hơn; cần view "hiện tại" cho các truy vấn thường ngày.

## Kiểm chứng

Trước khi chuyển trạng thái sang "Chấp nhận", làm PoC với 5 kiểu `AdminUnit`, `Organization`, `Facility`, `ServiceZone`, `ShipmentEvent`:

1. Sinh được DDL Postgres có cột hình học PostGIS và index không gian.
2. Sinh được model Pydantic dùng trực tiếp trong FastAPI.
3. Sinh được JSON Schema dùng để kiểm tra một file CSV/JSON nạp từ đối tác.
4. Truy vấn "danh sách bưu cục thuộc xã X tại ngày D" trả đúng kết quả qua một đợt đổi tên xã.

Nếu bước 1 hoặc 2 không đạt mà không sửa được trong khoảng hai ngày công, chuyển sang phương án dự phòng (Pydantic làm nguồn định nghĩa).

**Kết quả (2026-11-06):** cả bốn bước đều đạt, cùng sáu bổ sung ở mục 8; 25/25 test chạy trên PostGIS thật. Có một điều chỉnh: `gen-sqltables` của LinkML không hỗ trợ PostGIS và phiên bản theo thời gian, nên DDL Postgres được sinh bằng generator riêng của dự án (đọc cùng file schema). Pydantic và JSON Schema dùng generator của LinkML. Chi tiết trong báo cáo PoC, mã trong [poc/ontology](../../poc/ontology/).

## Khi nào xem lại

- Có từ ba tổ chức trở lên dùng chung ontology và cần quản trị phiên bản chặt hơn.
- Truy vấn đồ thị trở thành phần lớn tải, vượt khả năng của Apache AGE.
- Nhà nước ban hành mô hình dữ liệu chuẩn cho địa chỉ hoặc logistics; khi đó ontology phải ánh xạ theo.
