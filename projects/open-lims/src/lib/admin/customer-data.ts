/* K-01 · Danh sách khách hàng & công nợ (bản minh hoạ).

   Backend chưa có route nào cho màn này: `GET /customers?query=` chỉ trả về tên/mã số thuế để
   gợi ý lúc tạo yêu cầu (xem `features/request/api`), và không có endpoint công nợ nào cả. Toàn
   bộ số liệu dưới đây là dữ liệu dựng sẵn cho bản mockup - ghi vào "Cần backend bổ sung" chứ
   không phải chỗ để suy ra hợp đồng API. */

export type CustomerStatus = "active" | "locked";

/** Một khoản phải thu. `amount` là giá trị hoá đơn, `paid` là số đã thu - phần còn lại chính là
 *  công nợ. Giữ hai con số thay vì một số dư để bảng chi tiết Excel nói được vì sao còn nợ. */
export interface CustomerInvoice {
  id: string;
  /** Mã hồ sơ kiểm nghiệm phát sinh khoản này. */
  recordCode: string;
  issuedOn: string;
  dueOn: string;
  amount: number;
  paid: number;
}

export interface CustomerRow {
  id: string;
  name: string;
  taxCode: string;
  address: string;
  representative: string;
  phone: string;
  email: string;
  /** Chi nhánh đang phục vụ - cùng cách viết với `Branch.name` ở A-02. */
  branch: string;
  segment: "Doanh nghiệp" | "Hộ kinh doanh" | "Cá nhân";
  contractCode?: string;
  /** Hạn mức công nợ được duyệt (VND). Vượt hạn mức là điều kiện khoá thường gặp nhất. */
  creditLimit: number;
  /** Số ngày được nợ kể từ ngày phát hành hoá đơn. */
  paymentTermDays: number;
  createdOn: string;
  status: CustomerStatus;
  lockReason?: string;
  lockedOn?: string;
  totalRecords: number;
  lastRecordOn: string;
  invoices: CustomerInvoice[];
}

/** Chỉ những trường lãnh đạo được sửa trực tiếp trên màn này. Mã khách hàng, mã số thuế và lịch
 *  sử hồ sơ không nằm trong đây: sửa chúng là đổi danh tính pháp nhân, phải đi đường hồ sơ
 *  khách hàng chứ không phải một ô nhập trên danh sách. */
export type CustomerEditableFields = Pick<
  CustomerRow,
  | "name"
  | "address"
  | "representative"
  | "phone"
  | "email"
  | "branch"
  | "segment"
  | "contractCode"
  | "creditLimit"
  | "paymentTermDays"
>;

export const CUSTOMER_SEGMENTS: CustomerRow["segment"][] = [
  "Doanh nghiệp",
  "Hộ kinh doanh",
  "Cá nhân",
];

export const CUSTOMER_BRANCHES = [
  "CN Bình Dương",
  "CN TP. Hồ Chí Minh",
  "CN Long An",
  "CN Đắk Lắk",
];

export const MOCK_CUSTOMERS: CustomerRow[] = [
  {
    id: "KH-0142",
    name: "Cty TNHH XNK Nông sản An Phát",
    taxCode: "0312445671",
    address: "12 Nguyễn Văn Cừ, Q.5, TP.HCM",
    representative: "Ngô Thị Kim Chi",
    phone: "0918 442 117",
    email: "an.nguyen@example.com",
    branch: "CN TP. Hồ Chí Minh",
    segment: "Doanh nghiệp",
    contractCode: "HĐ-2026/041",
    creditLimit: 200_000_000,
    paymentTermDays: 30,
    createdOn: "2023-04-18",
    status: "active",
    totalRecords: 148,
    lastRecordOn: "2026-08-27",
    invoices: [
      {
        id: "HD-26-0881",
        recordCode: "HS-26-04412",
        issuedOn: "2026-08-20",
        dueOn: "2026-09-19",
        amount: 42_000_000,
        paid: 0,
      },
      {
        id: "HD-26-0742",
        recordCode: "HS-26-04180",
        issuedOn: "2026-07-08",
        dueOn: "2026-08-07",
        amount: 68_500_000,
        paid: 30_000_000,
      },
      {
        id: "HD-26-0517",
        recordCode: "HS-26-03755",
        issuedOn: "2026-05-12",
        dueOn: "2026-06-11",
        amount: 25_000_000,
        paid: 25_000_000,
      },
    ],
  },
  {
    id: "KH-0208",
    name: "Cty CP Nông sản Bình Minh",
    taxCode: "0311998220",
    address: "KCN Tân Bình, TP.HCM",
    representative: "Trần Quốc Bảo",
    phone: "0903 118 240",
    email: "bao.tran@binhminh.vn",
    branch: "CN TP. Hồ Chí Minh",
    segment: "Doanh nghiệp",
    contractCode: "HĐ-2025/117",
    creditLimit: 150_000_000,
    paymentTermDays: 45,
    createdOn: "2022-11-03",
    status: "active",
    totalRecords: 226,
    lastRecordOn: "2026-08-28",
    invoices: [
      {
        id: "HD-26-0902",
        recordCode: "HS-26-04455",
        issuedOn: "2026-08-24",
        dueOn: "2026-10-08",
        amount: 18_700_000,
        paid: 0,
      },
      {
        id: "HD-26-0655",
        recordCode: "HS-26-04021",
        issuedOn: "2026-06-19",
        dueOn: "2026-08-03",
        amount: 31_200_000,
        paid: 31_200_000,
      },
    ],
  },
  {
    id: "KH-0317",
    name: "Cty TNHH Thực phẩm Tân Việt",
    taxCode: "0316774102",
    address: "Lô B7, KCN Long Hậu, Long An",
    representative: "Lý Thu Hà",
    phone: "0977 205 663",
    email: "ha.ly@tanviet.com.vn",
    branch: "CN Long An",
    segment: "Doanh nghiệp",
    contractCode: "HĐ-2026/008",
    creditLimit: 120_000_000,
    paymentTermDays: 30,
    createdOn: "2024-02-27",
    status: "locked",
    lockReason: "Quá hạn công nợ trên 90 ngày, đã nhắc 3 lần qua email và điện thoại.",
    lockedOn: "2026-08-14",
    totalRecords: 94,
    lastRecordOn: "2026-07-30",
    invoices: [
      {
        id: "HD-26-0388",
        recordCode: "HS-26-03501",
        issuedOn: "2026-03-30",
        dueOn: "2026-04-29",
        amount: 88_400_000,
        paid: 12_000_000,
      },
      {
        id: "HD-26-0470",
        recordCode: "HS-26-03668",
        issuedOn: "2026-04-25",
        dueOn: "2026-05-25",
        amount: 45_000_000,
        paid: 0,
      },
    ],
  },
  {
    id: "KH-0355",
    name: "HTX Sầu riêng Krông Pắc",
    taxCode: "6001445120",
    address: "Thôn 4, xã Ea Yông, Krông Pắc, Đắk Lắk",
    representative: "Nguyễn Văn Sáu",
    phone: "0905 771 908",
    email: "htxkrongpac@gmail.com",
    branch: "CN Đắk Lắk",
    segment: "Hộ kinh doanh",
    creditLimit: 40_000_000,
    paymentTermDays: 15,
    createdOn: "2025-06-11",
    status: "active",
    totalRecords: 37,
    lastRecordOn: "2026-08-26",
    invoices: [
      {
        id: "HD-26-0871",
        recordCode: "HS-26-04398",
        issuedOn: "2026-08-18",
        dueOn: "2026-09-02",
        amount: 9_800_000,
        paid: 0,
      },
      {
        id: "HD-26-0790",
        recordCode: "HS-26-04255",
        issuedOn: "2026-07-21",
        dueOn: "2026-08-05",
        amount: 12_400_000,
        paid: 4_000_000,
      },
    ],
  },
  {
    id: "KH-0402",
    name: "Cty TNHH Chế biến Thuỷ sản Đại Dương",
    taxCode: "3702118845",
    address: "KCN Sóng Thần 2, Dĩ An, Bình Dương",
    representative: "Hoàng Minh Trí",
    phone: "0938 664 210",
    email: "tri.hoang@daiduongfood.vn",
    branch: "CN Bình Dương",
    segment: "Doanh nghiệp",
    contractCode: "HĐ-2026/052",
    creditLimit: 300_000_000,
    paymentTermDays: 60,
    createdOn: "2021-09-14",
    status: "active",
    totalRecords: 412,
    lastRecordOn: "2026-08-28",
    invoices: [
      {
        id: "HD-26-0915",
        recordCode: "HS-26-04471",
        issuedOn: "2026-08-26",
        dueOn: "2026-10-25",
        amount: 124_000_000,
        paid: 0,
      },
      {
        id: "HD-26-0688",
        recordCode: "HS-26-04098",
        issuedOn: "2026-06-30",
        dueOn: "2026-08-29",
        amount: 96_000_000,
        paid: 96_000_000,
      },
    ],
  },
  {
    id: "KH-0448",
    name: "Cty CP Xuất khẩu Trái cây Miền Tây",
    taxCode: "1801229004",
    address: "Số 5 Trần Hưng Đạo, TP. Cần Thơ",
    representative: "Đặng Thị Mỹ Duyên",
    phone: "0912 447 300",
    email: "duyen.dang@mientayfruit.vn",
    branch: "CN TP. Hồ Chí Minh",
    segment: "Doanh nghiệp",
    contractCode: "HĐ-2025/203",
    creditLimit: 180_000_000,
    paymentTermDays: 30,
    createdOn: "2023-08-02",
    status: "active",
    totalRecords: 165,
    lastRecordOn: "2026-08-19",
    invoices: [
      {
        id: "HD-26-0733",
        recordCode: "HS-26-04162",
        issuedOn: "2026-07-05",
        dueOn: "2026-08-04",
        amount: 57_300_000,
        paid: 20_000_000,
      },
      {
        id: "HD-26-0602",
        recordCode: "HS-26-03940",
        issuedOn: "2026-06-02",
        dueOn: "2026-07-02",
        amount: 41_000_000,
        paid: 0,
      },
    ],
  },
  {
    id: "KH-0511",
    name: "Hộ kinh doanh Vườn xoài Cát Chu",
    taxCode: "8201009117",
    address: "Ấp Tân Thuận, Cao Lãnh, Đồng Tháp",
    representative: "Phan Văn Lộc",
    phone: "0947 118 552",
    email: "loc.phan.vuonxoai@gmail.com",
    branch: "CN Long An",
    segment: "Hộ kinh doanh",
    creditLimit: 25_000_000,
    paymentTermDays: 15,
    createdOn: "2025-12-08",
    status: "locked",
    lockReason: "Sai lệch thông tin mã số thuế trên hợp đồng, chờ khách hàng cập nhật giấy phép.",
    lockedOn: "2026-06-05",
    totalRecords: 12,
    lastRecordOn: "2026-05-28",
    invoices: [
      {
        id: "HD-26-0455",
        recordCode: "HS-26-03612",
        issuedOn: "2026-04-18",
        dueOn: "2026-05-03",
        amount: 6_500_000,
        paid: 0,
      },
    ],
  },
  {
    id: "KH-0566",
    name: "Cty TNHH Cà phê Buôn Hồ",
    taxCode: "6001772340",
    address: "45 Hùng Vương, TX. Buôn Hồ, Đắk Lắk",
    representative: "Y Thanh Niê",
    phone: "0906 220 741",
    email: "ythanh@caphebuonho.vn",
    branch: "CN Đắk Lắk",
    segment: "Doanh nghiệp",
    contractCode: "HĐ-2026/077",
    creditLimit: 90_000_000,
    paymentTermDays: 30,
    createdOn: "2024-10-19",
    status: "active",
    totalRecords: 58,
    lastRecordOn: "2026-08-25",
    invoices: [
      {
        id: "HD-26-0899",
        recordCode: "HS-26-04440",
        issuedOn: "2026-08-22",
        dueOn: "2026-09-21",
        amount: 21_500_000,
        paid: 0,
      },
    ],
  },
  {
    id: "KH-0603",
    name: "Cty CP Dược liệu Hoà Bình",
    taxCode: "5400398112",
    address: "Km 8, QL6, TP. Hoà Bình",
    representative: "Bùi Thị Lan",
    phone: "0989 004 172",
    email: "lan.bui@duoclieuhoabinh.vn",
    branch: "CN Bình Dương",
    segment: "Doanh nghiệp",
    creditLimit: 60_000_000,
    paymentTermDays: 30,
    createdOn: "2026-01-22",
    status: "active",
    totalRecords: 21,
    lastRecordOn: "2026-08-11",
    invoices: [
      {
        id: "HD-26-0812",
        recordCode: "HS-26-04302",
        issuedOn: "2026-07-30",
        dueOn: "2026-08-29",
        amount: 14_200_000,
        paid: 14_200_000,
      },
    ],
  },
  {
    id: "KH-0674",
    name: "Nguyễn Hoàng Anh (cá nhân)",
    taxCode: "8712004551",
    address: "27/4 Lê Lợi, TP. Thủ Dầu Một, Bình Dương",
    representative: "Nguyễn Hoàng Anh",
    phone: "0972 553 118",
    email: "hoanganh.nguyen@outlook.com",
    branch: "CN Bình Dương",
    segment: "Cá nhân",
    creditLimit: 10_000_000,
    paymentTermDays: 7,
    createdOn: "2026-05-30",
    status: "active",
    totalRecords: 4,
    lastRecordOn: "2026-08-09",
    invoices: [
      {
        id: "HD-26-0838",
        recordCode: "HS-26-04340",
        issuedOn: "2026-08-06",
        dueOn: "2026-08-13",
        amount: 3_600_000,
        paid: 0,
      },
    ],
  },
];

/** Công nợ tính từ chính danh sách hoá đơn, không lưu sẵn một số dư rời: một số dư chép tay sẽ
 *  lệch khỏi bảng chi tiết ngay lần đầu ai đó sửa một dòng hoá đơn. */
export interface CustomerDebt {
  /** Tổng còn phải thu. */
  outstanding: number;
  /** Phần đã quá hạn thanh toán tính đến hôm nay. */
  overdue: number;
  /** Số ngày quá hạn của khoản trễ nhất; 0 khi không có khoản nào trễ. */
  overdueDays: number;
  openInvoices: number;
  /** Còn nợ vượt hạn mức được duyệt. */
  overLimit: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysLate(dueOn: string, today: Date): number {
  const due = new Date(`${dueOn}T00:00:00`).getTime();
  if (Number.isNaN(due)) return 0;
  return Math.max(0, Math.floor((today.getTime() - due) / DAY_MS));
}

export function invoiceBalance(invoice: CustomerInvoice): number {
  return Math.max(0, invoice.amount - invoice.paid);
}

export function invoiceOverdueDays(invoice: CustomerInvoice, today = new Date()): number {
  return invoiceBalance(invoice) > 0 ? daysLate(invoice.dueOn, today) : 0;
}

export function customerDebt(customer: CustomerRow, today = new Date()): CustomerDebt {
  let outstanding = 0;
  let overdue = 0;
  let overdueDays = 0;
  let openInvoices = 0;
  for (const invoice of customer.invoices) {
    const balance = invoiceBalance(invoice);
    if (balance <= 0) continue;
    openInvoices += 1;
    outstanding += balance;
    const late = daysLate(invoice.dueOn, today);
    if (late > 0) {
      overdue += balance;
      overdueDays = Math.max(overdueDays, late);
    }
  }
  return {
    outstanding,
    overdue,
    overdueDays,
    openInvoices,
    overLimit: outstanding > customer.creditLimit,
  };
}

/** Nhóm tuổi nợ dùng chung cho badge trên bảng và cột trong file Excel. */
export function debtBucket(debt: CustomerDebt): {
  label: string;
  tone: "success" | "warning" | "danger";
} {
  if (debt.outstanding === 0) return { label: "Không nợ", tone: "success" };
  if (debt.overdueDays === 0) return { label: "Trong hạn", tone: "success" };
  if (debt.overdueDays <= 30) return { label: `Quá hạn ${debt.overdueDays} ngày`, tone: "warning" };
  return { label: `Quá hạn ${debt.overdueDays} ngày`, tone: "danger" };
}
