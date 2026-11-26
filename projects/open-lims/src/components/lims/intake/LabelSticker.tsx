import { QRCodeSVG } from "qrcode.react";

/* Tem 50x40mm dùng chung cho mọi loại mã (cha, mẫu con, task): QR + mã + dòng phụ. */
export function LabelSticker({
  code,
  caption,
  qrSize = 104,
}: {
  code: string;
  caption?: string;
  qrSize?: number;
}) {
  return (
    <div className="dlp-label">
      <QRCodeSVG value={code} size={qrSize} level="M" fgColor="#000000" bgColor="#ffffff" />
      <div className="dlp-label__code">{code}</div>
      {caption ? <div className="dlp-label__name">{caption}</div> : null}
    </div>
  );
}
