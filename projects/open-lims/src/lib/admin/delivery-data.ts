/* Dữ liệu fixture cho S-16 - trả kết quả và thay thế trong chế độ demo. */
import type { Tone } from "./records-data";
import type { StatItem } from "@/components/lims/common";

export type CertStatus = "valid" | "replaced";

export interface DeliveryLogItem {
  what: string;
  who: string;
  state: string;
  tone: Tone;
  at: string;
}

export const DELIVERY_CERT = {
  no: "KQ26000045",
  record: "26100012",
  replacementNo: "KQ26000048",
  defaultMail: "ketoan@anphat-agri.vn",
};

export const DRAFT_TITLE = "Bản nháp gửi khách xem trước";

export const DRAFT_INFO =
  "Bản nháp có watermark «BẢN NHÁP – CHƯA PHÁT HÀNH», không có mã tra cứu/QR và không tạo phiên bản phát hành. Mỗi lần gửi ghi audit người gửi, người nhận và thời điểm.";

export const REPLACE_NOTE =
  "Thay thế tạo phiên bản nháp mới cùng mã phiếu. Bản cũ chỉ chuyển sang đã bị thay thế khi bản mới được phát hành; PDF cũ vẫn được giữ để truy vết.";

export const LOOKUP_NOTE =
  "Tra cứu công khai bằng mã phiếu hoặc mã mẫu; chỉ có PDF sau khi phát hành.";

export function attachmentName(status: CertStatus) {
  return status === "replaced"
    ? `${DELIVERY_CERT.replacementNo}-v1-daky.pdf`
    : `${DELIVERY_CERT.no}-v2-daky.pdf`;
}

export function attachmentNote(status: CertStatus) {
  if (status === "valid") return "Đúng phiên bản phát hành · checksum khớp";
  return `Phiếu thay thế · cùng chuỗi phiên bản của ${DELIVERY_CERT.no}`;
}

export function sendCta(status: CertStatus, sentTimes: number) {
  if (status === "replaced") return `Gửi phiếu thay thế ${DELIVERY_CERT.replacementNo}`;
  return sentTimes > 0 ? `Gửi lại email (lần ${sentTimes + 1})` : "Gửi email cho khách";
}

export function printCta(status: CertStatus) {
  return status === "valid" ? "In bản giấy trả tại PTN" : "Không in được phiếu đã khoá";
}

export function mailHint(bounced: boolean) {
  return bounced
    ? "Địa chỉ bị trả về (hard bounce) - xác nhận lại với khách rồi gửi lại"
    : "Lấy từ BM01 · sửa được nếu khách đổi người nhận";
}

export function certState(status: CertStatus) {
  if (status === "valid") return "Hợp lệ · đang hiệu lực";
  return `Đã thay thế bởi ${DELIVERY_CERT.replacementNo}`;
}

export function certTone(status: CertStatus): Tone {
  if (status === "valid") return "success";
  return "warning";
}

export function deliveryMessage(
  status: CertStatus,
  bounced: boolean,
  sent: boolean,
  mailTo: string,
): { tone: Tone; title: string; body: string } | null {
  if (bounced)
    return {
      tone: "danger",
      title: "Email bị trả về:",
      body: "Địa chỉ không tồn tại. Xác nhận lại địa chỉ với khách rồi gửi lại - gửi lại cùng phiên bản không tạo bản phát hành mới.",
    };
  if (status === "replaced")
    return {
      tone: "warning",
      title: "Phiếu đã được thay thế:",
      body: `Bản gửi đi là phiếu thay thế ${DELIVERY_CERT.replacementNo}. Phiếu ${DELIVERY_CERT.no} giữ lại để truy vết; QR bản cũ trỏ tới phiên bản hiện hành.`,
    };
  if (sent)
    return {
      tone: "success",
      title: "Đã gửi email:",
      body: `Gửi tới ${mailTo} kèm đúng PDF phiên bản phát hành. Gửi lại cùng phiên bản không tạo bản phát hành mới.`,
    };
  return null;
}

export function deliveryLog(
  status: CertStatus,
  sentTimes: number,
  sent: boolean,
  sentKind: CertStatus,
  mailTo: string,
): DeliveryLogItem[] {
  const rows: DeliveryLogItem[] = [];
  if (status === "replaced")
    rows.push({
      what: `Phát hành phiếu thay thế ${DELIVERY_CERT.replacementNo}`,
      who: `Lê Anh Tuấn · thay cho ${DELIVERY_CERT.no}`,
      tone: "warning",
      state: "Đã thay thế",
      at: "vừa xong",
    });
  if (sentTimes > 1)
    rows.push({
      what: `Gửi lại email lần ${sentTimes} tới ${mailTo}`,
      who: "Phạm Bảo Ngọc · theo yêu cầu khách",
      tone: "warning",
      state: "Gửi lại",
      at: "vừa xong",
    });
  if (sent)
    rows.push({
      what:
        sentKind === "replaced"
          ? `Gửi email kèm ${DELIVERY_CERT.replacementNo}-v1-daky.pdf`
          : `Gửi email kèm ${DELIVERY_CERT.no}-v2-daky.pdf`,
      who: `Phạm Bảo Ngọc · ${mailTo}`,
      tone: "success",
      state: "Đã gửi",
      at: "vừa xong",
    });
  rows.push(
    {
      what: `Phát hành phiếu, mở tra cứu theo mã ${DELIVERY_CERT.no}`,
      who: "Lê Anh Tuấn",
      tone: "success",
      state: "Đã phát hành",
      at: "04/08 08:41",
    },
    {
      what: "Phê duyệt và ký tay bản in A4",
      who: "Lê Anh Tuấn",
      tone: "success",
      state: "Đã ký",
      at: "04/08 08:30",
    },
  );
  return rows;
}

export function deliveryStats(status: CertStatus, sentTimes: number, printed: boolean): StatItem[] {
  return [
    {
      label: "Phiếu chờ trả khách",
      value: status === "valid" && sentTimes === 0 ? 1 : 0,
      hint: "Đã phát hành, chưa gửi email",
      tone: "warning",
    },
    { label: "Lượt gửi email", value: sentTimes, hint: "Gửi lại không tạo bản mới", tone: "info" },
    {
      label: "Trả tại PTN",
      value: printed ? 1 : 0,
      hint: "Khách ký nhận bản giấy",
      tone: "success",
    },
    {
      label: "Trạng thái phiếu",
      value: status === "valid" ? "Hợp lệ" : "Thay thế",
      hint: LOOKUP_NOTE,
      tone: certTone(status),
    },
  ];
}
