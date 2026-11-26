/* Xuất file Excel chi tiết khách hàng & công nợ (K-01).

   Khác với `records-export.ts` (CSV một bảng phẳng), màn công nợ cần hai mức: một dòng tóm tắt
   cho mỗi khách hàng và bên dưới là từng khoản phải thu. CSV không diễn đạt được hai mức đó nếu
   không lặp lại toàn bộ cột khách hàng trên mỗi dòng hoá đơn, nên file xuất ra là workbook HTML
   (`application/vnd.ms-excel`) - Excel mở trực tiếp, giữ được tiêu đề đậm, cột số căn phải và
   hai sheet riêng. Đổi lại phải tự thoát HTML: giá trị người dùng nhập (tên, địa chỉ, lý do
   khoá) đi thẳng vào markup. */

import {
  customerDebt,
  debtBucket,
  invoiceBalance,
  invoiceOverdueDays,
  type CustomerRow,
} from "./customer-data";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type Cell = { text: string; num?: boolean };

const text = (value: unknown): Cell => ({ text: esc(value) });
/** Excel đọc `mso-number-format` để hiểu ô là số thật, không phải chuỗi - nếu thiếu, người dùng
 *  không SUM được cột công nợ, tức là mất đúng thứ họ tải file về để làm. */
const num = (value: number): Cell => ({ text: String(value), num: true });

function sheet(name: string, headers: string[], rows: Cell[][]): string {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((c) => `<td${c.num ? ' class="n"' : ""}>${c.text}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table><caption>${esc(name)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const CUSTOMER_HEADERS = [
  "Mã KH",
  "Tên khách hàng",
  "Mã số thuế",
  "Phân loại",
  "Người đại diện",
  "Điện thoại",
  "Email",
  "Địa chỉ",
  "Chi nhánh phục vụ",
  "Số hợp đồng",
  "Hạn mức công nợ (VND)",
  "Hạn thanh toán (ngày)",
  "Tổng hồ sơ",
  "Hồ sơ gần nhất",
  "Khách hàng từ",
  "Còn nợ (VND)",
  "Quá hạn (VND)",
  "Số ngày quá hạn",
  "Hoá đơn còn nợ",
  "Tình trạng nợ",
  "Vượt hạn mức",
  "Trạng thái",
  "Lý do khoá",
  "Ngày khoá",
];

const INVOICE_HEADERS = [
  "Mã KH",
  "Tên khách hàng",
  "Số hoá đơn",
  "Mã hồ sơ",
  "Ngày phát hành",
  "Hạn thanh toán",
  "Giá trị (VND)",
  "Đã thu (VND)",
  "Còn nợ (VND)",
  "Số ngày quá hạn",
];

/**
 * Tải xuống các khách hàng đang lọc dưới dạng workbook Excel hai sheet:
 * "Khách hàng" (mỗi dòng một khách, kèm số liệu công nợ tổng hợp) và "Chi tiết công nợ"
 * (mỗi dòng một khoản phải thu). `today` nhận từ ngoài để bảng trên màn hình và file tải về
 * cùng một mốc tính quá hạn.
 */
export function exportCustomersWorkbook(rows: CustomerRow[], today = new Date()): void {
  const customerRows = rows.map((c) => {
    const debt = customerDebt(c, today);
    return [
      text(c.id),
      text(c.name),
      text(c.taxCode),
      text(c.segment),
      text(c.representative),
      text(c.phone),
      text(c.email),
      text(c.address),
      text(c.branch),
      text(c.contractCode ?? ""),
      num(c.creditLimit),
      num(c.paymentTermDays),
      num(c.totalRecords),
      text(c.lastRecordOn),
      text(c.createdOn),
      num(debt.outstanding),
      num(debt.overdue),
      num(debt.overdueDays),
      num(debt.openInvoices),
      text(debtBucket(debt).label),
      text(debt.overLimit ? "Có" : "Không"),
      text(c.status === "locked" ? "Đã khoá" : "Đang hoạt động"),
      text(c.lockReason ?? ""),
      text(c.lockedOn ?? ""),
    ];
  });

  const invoiceRows = rows.flatMap((c) =>
    c.invoices.map((invoice) => [
      text(c.id),
      text(c.name),
      text(invoice.id),
      text(invoice.recordCode),
      text(invoice.issuedOn),
      text(invoice.dueOn),
      num(invoice.amount),
      num(invoice.paid),
      num(invoiceBalance(invoice)),
      num(invoiceOverdueDays(invoice, today)),
    ]),
  );

  const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets>
<x:ExcelWorksheet><x:Name>Khách hàng</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet>
<x:ExcelWorksheet><x:Name>Chi tiết công nợ</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet>
</x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
table { border-collapse: collapse; font-family: Calibri, Arial, sans-serif; font-size: 11pt; }
caption { font-weight: 700; font-size: 13pt; text-align: left; padding: 6px 0; }
th { background: #EDEBE9; border: 1px solid #A19F9D; font-weight: 700; text-align: left; padding: 4px 6px; }
td { border: 1px solid #D2D0CE; padding: 4px 6px; mso-number-format: "\\@"; vertical-align: top; }
td.n { mso-number-format: "\\#\\,\\#\\#0"; text-align: right; }
</style></head><body>
${sheet("Khách hàng", CUSTOMER_HEADERS, customerRows)}
${sheet("Chi tiết công nợ", INVOICE_HEADERS, invoiceRows)}
</body></html>`;

  const blob = new Blob([`\uFEFF${html}`], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `khach-hang-cong-no-${today.toISOString().slice(0, 10)}.xls`;
  a.click();
  URL.revokeObjectURL(url);
}
