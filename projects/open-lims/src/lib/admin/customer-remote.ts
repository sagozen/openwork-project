/* Quy phản hồi của `/api/v1/debt/*` về đúng hình dạng mà K-01 đã dựng sẵn.

   Cùng cách làm với `_app.admin.nhat-ky.tsx` ở pha trước: màn hình đã có một hình dạng dữ liệu
   hoàn chỉnh (`CustomerRow`), và nhánh thật quy về hình dạng đó thay vì mỗi nhánh render một kiểu.
   Đổi lại chỉ có một cây render, một file Excel, một ngăn kéo chi tiết - và nhánh demo vẫn chạy
   nguyên vẹn cho người xem thử.

   Hai thứ KHÔNG quy về được và phải mang theo riêng:
   * `remoteId` - `CustomerRow.id` là mã khách hàng (KH-0142) để hiển thị, còn API cần khoá thật.
   * `remoteDebt` / `remoteBucket` - số dư do máy chủ tính từ toàn bộ hoá đơn của khách; danh sách
     chỉ tải hoá đơn khi mở ngăn kéo, nên `customerDebt()` cục bộ sẽ ra 0 nếu tính lại tại đây. */

import type {
  CustomerInvoice as ApiInvoice,
  CustomerLedgerRow,
  CustomerStatement,
} from "@/features/customer/types";
import type { CustomerInvoice, CustomerRow } from "./customer-data";

/** Kết quả của `customerDebt()` - nhánh thật nhận thẳng từ máy chủ thay vì tính lại. */
export interface DebtView {
  outstanding: number;
  overdue: number;
  overdueDays: number;
  openInvoices: number;
  overLimit: boolean;
}

export interface LedgerRow extends CustomerRow {
  /** Khoá thật để gọi API. Vắng mặt ở nhánh demo. */
  remoteId?: string;
  remoteDebt?: DebtView;
  remoteBucket?: { label: string; tone: string };
}

const SEGMENTS: Record<string, CustomerRow["segment"]> = {
  ENTERPRISE: "Doanh nghiệp",
  HOUSEHOLD: "Hộ kinh doanh",
  INDIVIDUAL: "Cá nhân",
};

/** Ngày ISO đầy đủ về `YYYY-MM-DD` - màn hình chỉ dùng phần ngày. */
function day(value?: string): string {
  return value ? value.slice(0, 10) : "";
}

export function toLedgerRow(row: CustomerLedgerRow): LedgerRow {
  const debt = row.debt;
  return {
    // Mã khách hàng là thứ nhân viên đọc và tìm; khoá số chỉ để gọi API.
    id: row.code ?? row.id,
    remoteId: row.id,
    name: row.name,
    taxCode: row.taxCode ?? "",
    address: row.address ?? "",
    representative: row.representative ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
    branch: row.branchName ?? "",
    segment: SEGMENTS[row.segment?.code ?? "ENTERPRISE"] ?? "Doanh nghiệp",
    contractCode: row.contractCode,
    creditLimit: row.creditLimit ?? 0,
    paymentTermDays: row.paymentTermDays ?? 30,
    createdOn: day(row.createdAt),
    status: row.status?.code === "LOCKED" ? "locked" : "active",
    lockReason: row.lockReason,
    lockedOn: day(row.lockedAt) || undefined,
    totalRecords: row.totalRequests ?? 0,
    lastRecordOn: day(row.lastRequestOn),
    // Danh sách không tải hoá đơn - ngăn kéo mới tải, qua `mergeStatement`.
    invoices: [],
    remoteDebt: debt
      ? {
          outstanding: debt.outstanding ?? 0,
          overdue: debt.overdue ?? 0,
          overdueDays: debt.maxDaysOverdue ?? 0,
          openInvoices: debt.openInvoices ?? 0,
          overLimit: debt.overCreditLimit ?? false,
        }
      : undefined,
    remoteBucket: debt?.bucket ? { label: debt.bucket.name, tone: debt.bucket.tone } : undefined,
  };
}

/** Hoá đơn của máy chủ về hình dạng bảng chi tiết trong ngăn kéo và sheet Excel.
 *
 *  `paid` dựng lại từ `amount - outstanding` chứ không đọc `settledAmount`: hoá đơn đã huỷ có
 *  `outstanding = 0` nhưng chưa thu đồng nào, và bảng phải nói nó không còn nợ chứ không phải
 *  đã thu đủ. */
export function toLedgerInvoice(invoice: ApiInvoice): CustomerInvoice {
  return {
    id: invoice.code,
    recordCode: invoice.testRequestCode ?? "—",
    issuedOn: invoice.issuedOn,
    dueOn: invoice.dueOn,
    amount: invoice.amount ?? 0,
    paid: (invoice.amount ?? 0) - (invoice.outstanding ?? 0),
  };
}

/** Gộp sao kê vừa tải vào dòng đang mở, để ngăn kéo dùng đúng một hình dạng ở cả hai nhánh. */
export function mergeStatement(row: LedgerRow, statement: CustomerStatement): LedgerRow {
  return {
    ...row,
    invoices: statement.invoices.map(toLedgerInvoice),
    remoteDebt: {
      outstanding: statement.debt.outstanding ?? 0,
      overdue: statement.debt.overdue ?? 0,
      overdueDays: statement.debt.maxDaysOverdue ?? 0,
      openInvoices: statement.debt.openInvoices ?? 0,
      overLimit: statement.debt.overCreditLimit ?? false,
    },
    remoteBucket: statement.debt.bucket
      ? { label: statement.debt.bucket.name, tone: statement.debt.bucket.tone }
      : row.remoteBucket,
  };
}

/** Chip lọc của màn hình sang tham số máy chủ.
 *
 *  `bucket` máy chủ nhận: `none` | `debt` | `current` | `overdue` (PgCustomerProfileRepository).
 *  Chip «Đang còn nợ» → `debt` (mọi số dư), không phải `current` (chỉ còn nợ trong hạn). */
export function toListFilters(statusFilter: string): { bucket?: string; status?: "LOCKED" } {
  switch (statusFilter) {
    case "debt":
      return { bucket: "debt" };
    case "overdue":
      return { bucket: "overdue" };
    case "locked":
      return { status: "LOCKED" };
    default:
      return {};
  }
}
