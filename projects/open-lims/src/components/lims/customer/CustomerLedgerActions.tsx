/* Hai thao tác ghi của sổ công nợ, đặt ngay dưới bảng hoá đơn trong ngăn kéo chi tiết.
 *
 * Chỉ hiện ở nhánh thật và chỉ với người có `debt.manage`: nhánh demo không có chỗ nào để ghi,
 * và bày một cái nút không lưu được gì là hứa suông.
 *
 * Phiếu thu BẮT BUỘC có chứng từ (BR-007) - biểu mẫu không cho bấm khi chưa đính kèm, và máy chủ
 * từ chối lần nữa nếu vẫn lọt qua (E-DEBT-014). Không phân bổ tay: bỏ trống thì máy chủ trừ nợ cũ
 * trước, đúng thông lệ kế toán và giữ tuổi nợ trung thực. */

import { useState } from "react";
import { Button, Field, Input, Spinner } from "@fluentui/react-components";
import { useIssueInvoice, useRecordReceipt } from "@/features/customer";
import { FileDropField } from "@/components/lims/common/FileDropField";
import { VndAmountInput } from "@/components/lims/common/VndAmountInput";
import { apiErrorMessage, uploadFile, useApiClient } from "@/lib/api";
import { formatAmount, parseVndInput } from "@/lib/format";

interface Props {
  customerId: string;
  /** Số còn nợ hiện tại - để nhắc người dùng số tiền đang chờ thu. */
  outstanding: number;
  onDone: (title: string, detail: string) => void;
}

const card: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  border: "1px solid var(--colorNeutralStroke2)",
  borderRadius: 6,
};

export function CustomerLedgerActions({ customerId, outstanding, onDone }: Props) {
  const api = useApiClient();
  const issueInvoice = useIssueInvoice();
  const recordReceipt = useRecordReceipt();

  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceNote, setInvoiceNote] = useState("");

  const [receiptAmount, setReceiptAmount] = useState("");
  const [receiptReference, setReceiptReference] = useState("");
  const [voucher, setVoucher] = useState<{ id: string; fileName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedInvoice = parseVndInput(invoiceAmount);
  const parsedReceipt = parseVndInput(receiptAmount);
  const validInvoice =
    Number.isFinite(parsedInvoice) && parsedInvoice > 0 && parsedInvoice <= Number.MAX_SAFE_INTEGER;
  const validReceipt =
    Number.isFinite(parsedReceipt) && parsedReceipt > 0 && parsedReceipt <= Number.MAX_SAFE_INTEGER;

  async function attachVoucher(file: File) {
    setUploading(true);
    setError(null);
    try {
      const attachment = await uploadFile(api, file, {
        grant: "debt.receipt.evidence",
        fileName: file.name,
      });
      setVoucher({ id: attachment.id, fileName: attachment.fileName });
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
      <div style={card}>
        <strong>Phát hành hoá đơn</strong>
        <span className="dlp-datagrid__secondary">
          Ngày đến hạn tính theo kỳ hạn nợ của khách hàng.
        </span>
        <Field label="Số tiền (VND)">
          <VndAmountInput
            value={invoiceAmount}
            onChange={setInvoiceAmount}
            placeholder="4,200,000"
          />
        </Field>
        <Field label="Diễn giải">
          <Input
            value={invoiceNote}
            onChange={(_, d) => setInvoiceNote(d.value)}
            placeholder="Phí kiểm nghiệm tháng 8"
          />
        </Field>
        <Button
          appearance="primary"
          disabled={!validInvoice || issueInvoice.isPending}
          onClick={() =>
            issueInvoice.mutate(
              { customerId, amount: parsedInvoice, note: invoiceNote || undefined },
              {
                onSuccess: (invoice) => {
                  setInvoiceAmount("");
                  setInvoiceNote("");
                  onDone(
                    `Đã phát hành hoá đơn ${invoice.code}`,
                    `${formatAmount(invoice.amount)} · đến hạn ${invoice.dueOn}`,
                  );
                },
                onError: (cause) => setError(apiErrorMessage(cause)),
              },
            )
          }
        >
          {issueInvoice.isPending ? <Spinner size="tiny" /> : "Phát hành"}
        </Button>
      </div>

      <div style={card}>
        <strong>Ghi phiếu thu</strong>
        <span className="dlp-datagrid__secondary">
          Còn nợ {formatAmount(outstanding)} · khoản thu trừ vào hoá đơn cũ trước.
        </span>
        <Field label="Số tiền (VND)">
          <VndAmountInput
            value={receiptAmount}
            onChange={setReceiptAmount}
            placeholder="1,000,000"
          />
        </Field>
        <Field label="Số chứng từ">
          <Input
            value={receiptReference}
            onChange={(_, d) => setReceiptReference(d.value)}
            placeholder="UNC-0827-04"
          />
        </Field>
        <Field label="Chứng từ thanh toán (bắt buộc)">
          <FileDropField
            accept="application/pdf,image/*"
            compact
            pending={uploading}
            pendingLabel="Đang tải chứng từ…"
            idle="Tải chứng từ thanh toán (JPEG · PNG · PDF)"
            selected={voucher ? `Đã đính kèm ${voucher.fileName}` : undefined}
            buttonLabel={voucher ? "Chọn tệp khác" : "Chọn tệp"}
            onFile={(file) => attachVoucher(file)}
          />
        </Field>
        <Button
          appearance="primary"
          disabled={!validReceipt || !voucher || recordReceipt.isPending}
          onClick={() =>
            recordReceipt.mutate(
              {
                customerId,
                amount: parsedReceipt,
                reference: receiptReference || undefined,
                evidenceDocumentId: voucher!.id,
              },
              {
                onSuccess: (receipt) => {
                  setReceiptAmount("");
                  setReceiptReference("");
                  setVoucher(null);
                  onDone(
                    `Đã ghi phiếu thu ${receipt.code}`,
                    `${formatAmount(receipt.amount)} · đã trừ vào ${receipt.allocations.length} hoá đơn`,
                  );
                },
                onError: (cause) => setError(apiErrorMessage(cause)),
              },
            )
          }
        >
          {recordReceipt.isPending ? <Spinner size="tiny" /> : "Ghi nhận"}
        </Button>
      </div>

      {error ? (
        <div style={{ gridColumn: "1 / -1", color: "var(--status-danger-foreground)" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
