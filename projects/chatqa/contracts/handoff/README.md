# Tệp chuyển giao giữa các app (handoff)

Theo hsapp.pen: "4 app chạy độc lập. Dữ liệu chuyển giữa các app bằng tệp trên Google Drive chung".

| Tệp | Ai tạo | Ai đọc | Mẫu |
|---|---|---|---|
| `<LÔ>_da_chot.xlsx` (sheet `Lô <số>-HG`) | App 01 / nhân sự (tệp hiện hành) | App 02 Khởi tạo lô | `lot-chot.v1.json` |
| `<LÔ>_da_gop.xlsx` (sheet `Gộp lô <số>` + `Truy vết`) | App 02 (bản thủ công cũ; giữ để mở tệp lô cũ) | App 03 | `lot-gop.v1.json` |
| `<mã lô>_gop[_vN].xlsx` (sheet `Gộp lô <mã lô>`, ECUS 25 cột A-Y + Z "Dòng gốc"), `<mã lô>_doi-soat[_vN].xlsx` / `.pdf`, trong `lo/<mã lô>/` của Drive công ty | App 02 Xuất lô | App 03 Kiểm tra trước khai báo (chỉ đọc; mã HS, tên khai, thuế suất sửa ở bước kiểm tra nằm trong thao tác `checkFix` của lô, không sửa tệp) | `lot-gop.v2.json` |
| Mẫu tệp gộp đã lưu (mục `export_setting` vùng `tpl.merged`, nạp `.xlsx` hoặc `.xls` ở Thiết lập mẫu; cột nhận theo tiêu đề) | Quản lý (`export.template`) | App 02 Xuất lô dùng mẫu hiện hành (bản xuất ghi `itemId` + `sha256`); App 02 và App 03 đọc lại tệp gộp bằng đúng mẫu đã ghi; chưa có mẫu đã lưu thì dùng `lot-gop.v2.json` | `lot-gop.v2.json` (trường), mẫu lưu là phiên bản 3 |
| `<mã lô>_ecus[_vN].xls` (Excel 97-2003 BIFF8, `Sheet1`, 25 cột A-Y) trong `khai-bao/<YYYY-MM>/` của Drive công ty | App 03 Xuất ECUS và C/O | Nhân sự nạp vào ECUS Thái Sơn | `ecus-thaison.v1.json`, hoặc mẫu ECUS đã lưu ở Thiết lập mẫu (`.xls` một sheet) |
| `<mã lô>_ten-tieng-anh[_vN].xls` (Excel 97-2003 BIFF8, `Sheet1`) trong `khai-bao/<YYYY-MM>/` | App 03 Xuất ECUS và C/O | Nhân sự làm C/O và Invoice | `ten-tieng-anh.v1.json`, hoặc khung đã lưu ở Thiết lập mẫu (`.xls` một sheet) |
| Sheet Lô (Google Sheet, mỗi xe hàng một Sheet; cột nhận theo tiêu đề) | Vipo / nhân sự | App 02 Khởi tạo lô, Nạp thêm / Nạp lại (chỉ đọc) | `lot-sheet.v1.json` |
| Biểu thuế XNK tổng hợp `.xlsx` (sheet `BT<năm>` + `HT`, tuỳ chọn `MT`, `DB`, `6QT`) | Anh Tùng / bên triển khai | HS Desk, tab Biểu thuế (nạp biểu) | `bieu-thue.v1.json` |
| Biểu thuế XNK tổng hợp `.xlsx` như trên, thêm cột "Chính sách mặt hàng" theo mã HS | Anh Tùng / bên triển khai | HS Desk, tab Biểu thuế (nạp biểu); App 03 hiện chính sách ở bước kiểm | `bieu-thue.v2.json` |
| Danh mục rủi ro `.xlsx` (sheet `Danh muc tong hop`, tiêu đề ở dòng 3; mức Cao / Trung bình / Thấp) | Bộ phận quản lý rủi ro | HS Desk, tab Danh mục rủi ro (nạp danh mục); App 03 và hs-suggest | `danh-muc-rui-ro.v1.json` |
| Dữ liệu lịch sử `.xlsx`, `.xls` hoặc `.csv` (tệp ECUS xuất, báo giá cũ, tờ khai; cột nhận theo tiêu đề, bắt buộc Mã HS và một cột tên) | Nhân sự có quyền `history.import` | HS Desk, màn Nạp dữ liệu lịch sử (App 4); hs-suggest dùng làm tham khảo ưu tiên thấp nhất | `lich-su.v1.json` |
| Danh sách chống bán phá giá `.xlsx` (một sheet) | Anh Tùng | HS Desk, tab Chống bán phá giá | `chong-ban-pha-gia.v1.json` |

Quy tắc:

- App đọc theo **tiêu đề cột** ở `headerRow`, đối chiếu với `col` + `header` trong mẫu. Lệch → lỗi `bad_template` nêu rõ cột nào, không đọc tiếp.
- Riêng biểu thuế và danh sách chống bán phá giá: không cố định dòng hay cột; app tìm dòng tiêu đề trong `headerScanRows` dòng đầu và nhận cột theo `headers` (mọi tên đồng nghĩa), nên dời hoặc thêm cột vẫn đọc được.
- Chỉ đọc giá trị đã tính của ô (tệp hiện hành dùng công thức cho trị giá, thuế, đơn giá).
- Số đọc vào `num.Dec` (6 số lẻ), không dùng float.
- Khách đổi mẫu → thêm `*.v2.json`, giữ bản cũ để mở được tệp lô cũ.

Phát hiện từ lô mẫu 157 (574 → 198 dòng): xem `docs/REVIEW-2026-11-06.md` mục 7.
