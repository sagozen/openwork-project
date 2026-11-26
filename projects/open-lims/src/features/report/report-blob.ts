/** Tiện ích dùng chung cho PDF phiếu: mở xem trước và tải xuống từ Blob mà API trả về.
 * Cả màn Trả kết quả (S-16) và tab «Phiếu» ở chi tiết hồ sơ (S-03) đều dùng chung một bản này
 * để hai chỗ không lệch hành vi. */

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The browser starts consuming the download asynchronously after click().
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function openBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  // noopener returns null even when the tab opens. Keep the URL alive so the PDF
  // viewer can download it later; the browser releases it when this document unloads.
  window.open(url, "_blank", "noopener,noreferrer");
}

/** A version has ever released once it carries a checksum - the same condition the server
 * itself gates `preview?kind=RELEASED` and `GET .../pdf` on (`PreviewReportService`,
 * `DownloadReportPdfService`). `SUPERSEDED` versions were released before being superseded, so
 * they qualify too. */
export const everReleasedStatuses = new Set(["RELEASED", "SUPERSEDED"]);
