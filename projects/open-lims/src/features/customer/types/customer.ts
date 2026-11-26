/* Hình dạng dữ liệu của K-01 khi chạy thật, chiếu đúng phản hồi của `/api/v1/debt/*`.
 *
 * Khác `features/request/types` ở chỗ: bên đó là khách hàng dưới góc nhìn một hồ sơ (gợi ý tên,
 * tạo nhanh), còn đây là khách hàng dưới góc nhìn sổ công nợ. Cùng một bảng dưới cơ sở dữ liệu,
 * hai câu hỏi khác nhau - nên hai bộ kiểu, không phải một bộ phình ra. */

/** Mọi giá trị có mã đều kèm tên và tông màu do máy chủ trả (api-map.md) - client không tự dịch. */
export interface CodedValue {
  code: string;
  name: string;
  tone: string;
}

export interface PageInfo {
  page: number;
  size: number;
  total: number;
}

/** Công nợ của một khách hàng. `bucket` là kết luận một dòng cho cột "Tình trạng nợ";
 *  `ageing` là bảng phân tích theo tuổi nợ. Cả hai do máy chủ tính từ cùng một nguồn. */
export interface CustomerDebt {
  outstanding: number;
  overdue: number;
  maxDaysOverdue: number;
  openInvoices: number;
  overCreditLimit: boolean;
  bucket: CodedValue;
  ageing: Record<string, number>;
}

export interface CustomerLedgerRow {
  id: string;
  code?: string;
  name: string;
  taxCode?: string;
  representative?: string;
  phone?: string;
  email?: string;
  address?: string;
  branchId?: string;
  branchName?: string;
  segment: CodedValue;
  contractCode?: string;
  creditLimit: number;
  paymentTermDays: number;
  status: CodedValue;
  lockReason?: string;
  lockedAt?: string;
  createdAt?: string;
  /** Số hồ sơ khách này đã gửi và ngày gần nhất - máy chủ đếm từ bảng hồ sơ khi đọc, không lưu
   *  sẵn một cột đếm (một cột đếm là thêm một thứ có thể sai). */
  totalRequests?: number;
  lastRequestOn?: string;
  debt?: CustomerDebt;
}

export interface CustomerInvoice {
  id: string;
  code: string;
  customerId: string;
  customerName?: string;
  testRequestId?: string;
  testRequestCode?: string;
  issuedOn: string;
  dueOn: string;
  amount: number;
  settledAmount: number;
  outstanding: number;
  daysOverdue: number;
  status: CodedValue;
  note?: string;
  cancelReason?: string;
  createdAt?: string;
}

export interface ReceiptAllocation {
  invoiceId: string;
  invoiceCode?: string;
  amount: number;
}

export interface CustomerReceipt {
  id: string;
  code: string;
  customerId: string;
  customerName?: string;
  receivedOn: string;
  amount: number;
  method: CodedValue;
  reference?: string;
  evidenceDocumentId?: string;
  note?: string;
  allocatedAmount: number;
  unallocatedAmount: number;
  allocations: ReceiptAllocation[];
  createdAt?: string;
}

export interface CustomerListResponse {
  data: CustomerLedgerRow[];
  page: PageInfo;
}

/** Sao kê: khách hàng, số dư, và toàn bộ hai vế của sổ. */
export interface CustomerStatement {
  customer: CustomerLedgerRow;
  debt: CustomerDebt;
  invoices: CustomerInvoice[];
  receipts: CustomerReceipt[];
}

export interface DebtSummary {
  outstanding: number;
  overdue: number;
  openInvoices: number;
  overdueInvoices: number;
  customersInDebt: number;
}

export interface CustomerListFilters {
  q?: string;
  branchId?: string;
  status?: "ACTIVE" | "LOCKED";
  /** `none` | `debt` | `current` | `overdue` - máy chủ lọc theo số dư / quá hạn. */
  bucket?: string;
  page?: number;
  size?: number;
}

export interface PatchCustomerInput {
  name?: string;
  representative?: string;
  phone?: string;
  email?: string;
  address?: string;
  branchId?: string;
  segment?: string;
  contractCode?: string;
  creditLimit?: number;
  paymentTermDays?: number;
}

export interface IssueInvoiceInput {
  customerId: string;
  testRequestId?: string;
  amount: number;
  issuedOn?: string;
  note?: string;
}

export interface RecordReceiptInput {
  customerId: string;
  amount: number;
  receivedOn?: string;
  method?: "CASH" | "TRANSFER" | "OTHER";
  reference?: string;
  /** Bắt buộc - BR-007: không có chứng từ thì không ghi nhận được tiền về. */
  evidenceDocumentId: string;
  note?: string;
  /** Bỏ trống để máy chủ trừ nợ cũ trước. */
  allocations?: Array<{ invoiceId: string; amount: number }>;
}
