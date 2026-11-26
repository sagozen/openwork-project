import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Spinner } from "@fluentui/react-components";
import { downloadDocument, fetchDocument, useApiClient } from "@/lib/api";
import { saveBlob } from "@/features/report";
import type { PaymentStatus } from "../types/request";
import { formatAmount, formatDate, formatFileSize } from "./format";
import { RequestError } from "./request-ui";

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <small>{label}</small>
      <div>{value}</div>
    </div>
  );
}

/**
 * Chứng từ thanh toán đã nộp, đọc ngược lại từ hồ sơ (FR-PAY-003).
 *
 * Trước đây form xác nhận là đường một chiều: nộp số tiền, ghi chú và file chứng từ xong thì
 * không màn nào đọc lại được - không đối soát, không tra ngược khi khách khiếu nại. Khối này là
 * đường đọc đó. Nó chỉ hiển thị, không sửa: `ops.payment_record` không có đường ghi đè, và một
 * chứng từ tài chính đã ghi nhận thì không phải thứ để chỉnh tại chỗ.
 */
export function PaymentRecordPanel({ payment }: { payment: PaymentStatus }) {
  const api = useApiClient();
  const evidenceId = payment.evidenceDocumentId;
  // Tên tệp là thứ biến nút "Tải chứng từ" thành thông tin đọc được ("UNC-0827.pdf · 240 KB")
  // thay vì một nút trống. Không có chứng từ thì không gọi.
  const evidence = useQuery({
    queryKey: ["document", evidenceId],
    queryFn: () => fetchDocument(api, evidenceId!),
    enabled: !!evidenceId,
  });
  // FR-DOC-014: «Xem» là TẢI VỀ. Lưu xuống máy, không mở iframe/trình xem PDF nhúng - server
  // cũng đã trả `Content-Disposition: attachment` + `nosniff` để chặn cửa còn lại.
  const download = useMutation({
    mutationFn: async () =>
      saveBlob(
        await downloadDocument(api, evidenceId!),
        evidence.data?.fileName ?? `chung-tu-${evidenceId}`,
      ),
  });

  const facts: [string, string][] = [
    ["Tình trạng", payment.name],
    ...(payment.amount !== undefined
      ? ([["Số tiền", formatAmount(payment.amount)]] as [string, string][])
      : []),
    ...(payment.confirmedByFullName
      ? ([["Người xác nhận", payment.confirmedByFullName]] as [string, string][])
      : []),
    ...(payment.confirmedAt
      ? ([["Xác nhận lúc", formatDate(payment.confirmedAt)]] as [string, string][])
      : []),
    ...(payment.exceptionGrantedByFullName
      ? ([["Người cấp ngoại lệ", payment.exceptionGrantedByFullName]] as [string, string][])
      : []),
    ...(payment.exceptionGrantedAt
      ? ([["Cấp ngoại lệ lúc", formatDate(payment.exceptionGrantedAt)]] as [string, string][])
      : []),
  ];

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
          gap: 12,
        }}
      >
        {facts.map(([label, value]) => (
          <Fact key={label} label={label} value={value} />
        ))}
      </div>
      {payment.note ? <Fact label="Ghi chú" value={payment.note} /> : null}
      {payment.exceptionReason ? (
        <Fact label="Lý do ngoại lệ" value={payment.exceptionReason} />
      ) : null}
      {evidenceId ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span>
            Chứng từ:{" "}
            {evidence.data
              ? `${evidence.data.fileName} · ${formatFileSize(evidence.data.sizeBytes)}`
              : `#${evidenceId}`}
          </span>
          <Button
            size="small"
            disabled={download.isPending}
            icon={download.isPending ? <Spinner size="tiny" /> : undefined}
            onClick={() => download.mutate()}
          >
            {download.isPending ? "Đang tải…" : "Tải chứng từ"}
          </Button>
        </div>
      ) : (
        <div>Chưa có chứng từ thanh toán nào được nộp.</div>
      )}
      <RequestError error={evidence.error} fallback="Không đọc được thông tin chứng từ." />
      <RequestError error={download.error} fallback="Không tải được chứng từ." />
    </>
  );
}
