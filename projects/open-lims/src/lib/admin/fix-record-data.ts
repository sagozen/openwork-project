/* Dữ liệu mock cho S-20 - sửa hồ sơ trước phát hành (UC-37/38, D26). */
import type { Tone } from "./records-data";

export interface FixField {
  key: string;
  label: string;
  old: string;
}

export interface FixGroup {
  key: "A" | "B" | "C";
  title: string;
  badge: string;
  tone: Tone;
  note: string;
  fields: FixField[];
}

export const FIX_RECORD = {
  code: "26100012",
  cert: "KQ26000045",
  version: 2,
  state: "Chờ phê duyệt",
};

export const FIX_GROUPS: FixGroup[] = [
  {
    key: "A",
    title: "A · Hành chính / khách hàng",
    badge: "Sửa được - không duyệt lại",
    tone: "success",
    note: "Áp giá trị mới ngay, không quay lại lab. Bắt buộc lý do + ít nhất một file bằng chứng; audit ghi giá trị cũ → mới.",
    fields: [
      { key: "kh", label: "Tên khách hàng", old: "Cty TNHH XNK Nông sản An Phát" },
      { key: "dc", label: "Địa chỉ", old: "12 Trần Phú, Q.5, TP.HCM" },
      { key: "lh", label: "Người đại diện · điện thoại", old: "Vũ Kim Chi · 0903 xxx 218" },
      { key: "em", label: "Email nhận kết quả", old: "kimchi@anphat-agri.vn" },
      { key: "ht", label: "Hình thức nhận kết quả", old: "Email + bản giấy tại PTN" },
      { key: "lo", label: "Ghi chú / mã lô", old: "LOT-0825" },
    ],
  },
  {
    key: "B",
    title: "B · Liên quan mẫu",
    badge: "Chỉ tạo yêu cầu sửa",
    tone: "warning",
    note: "Sau khi duyệt, hệ thống tạo phiên bản kết quả mới cho chỉ tiêu bị ảnh hưởng và đưa hồ sơ qua lại quy trình kiểm tra, phê duyệt và ký. Phiên bản cũ được giữ nguyên.",
    fields: [
      { key: "sp", label: "Tên sản phẩm", old: "Sầu riêng tươi" },
      { key: "vt", label: "Mã vùng trồng", old: "VN-DL-0192" },
      { key: "cont", label: "Số container · seal", old: "TCLU 123456-7 · SL-889" },
      { key: "ct", label: "Danh mục chỉ tiêu", old: "Vàng O + Cadimi" },
      { key: "sl", label: "Số lượng mẫu", old: "5 quả" },
    ],
  },
  {
    key: "C",
    title: "C · Bất biến",
    badge: "Chỉ đọc",
    tone: "info",
    note: "Không thể sửa qua giao diện ở bất kỳ trạng thái nào.",
    fields: [
      {
        key: "ma",
        label: "Mã lượt · mã cha · mã con · mã task",
        old: "26100012 · 2610001201 … 2610001205",
      },
      { key: "phieu", label: "Mã phiếu · phiên bản đã phát hành", old: "KQ26000045 · v2" },
      { key: "cn", label: "Chi nhánh tiếp nhận", old: "CN1 · Chính" },
    ],
  },
];

export const FIX_GROUP_B_KEYS = ["sp", "vt", "cont", "ct", "sl"];

export const FIX_GUARD =
  "Cần cung cấp lý do và file bằng chứng trước khi lưu. Phiếu đã phát hành phải được thu hồi hoặc thay thế.";

export const FIX_MODE_A = {
  tone: "info" as const,
  title: "Chế độ sửa trực tiếp - nhóm A:",
  body: "Chỉ chạm nhóm A: hệ thống áp giá trị mới ngay, không phê duyệt lại, không quay lại lab. Nếu phiếu đang «Chờ ký», phiếu được render lại và bản scan ký cũ bị vô hiệu - phải in và ký lại trước khi phát hành.",
};

export const FIX_MODE_B = {
  tone: "warning" as const,
  title: "Chế độ «Yêu cầu sửa» - nhóm B:",
  body: "Yêu cầu có thay đổi dữ liệu mẫu nên toàn bộ lần sửa áp dụng quy trình nhóm B. Sau khi duyệt, hồ sơ quay lại quy trình phòng thử nghiệm và phê duyệt như hồ sơ mới.",
};

export const FIX_DONE_A = {
  tone: "success" as const,
  title: "Đã lưu thay đổi nhóm A:",
  body: "Giá trị mới có hiệu lực ngay, không phê duyệt lại. Lần sửa hiện trên timeline hồ sơ kèm người sửa, thời điểm, giá trị cũ → mới, lý do và bằng chứng.",
};

export const FIX_DONE_B = {
  tone: "warning" as const,
  title: "Đã gửi yêu cầu sửa nhóm B:",
  body: "Chờ người có quyền duyệt. Được duyệt thì hệ thống sinh phiên bản kết quả mới cho chỉ tiêu bị ảnh hưởng, thông báo NV lab phụ trách và trưởng nhóm, hồ sơ đi lại lab như hồ sơ mới.",
};

export interface FixHistory {
  what: string;
  who: string;
  at: string;
  tone: Tone;
  state: string;
}

export const FIX_TIMELINE: FixHistory[] = [
  {
    what: "Sửa email nhận kết quả",
    who: "Phạm Bảo Ngọc · nhóm A · kèm bằng chứng",
    at: "03/08 15:10",
    tone: "success",
    state: "Không duyệt lại",
  },
  {
    what: "Yêu cầu sửa mã vùng trồng",
    who: "Trần Thị Vân · nhóm B · đã duyệt",
    at: "02/08 16:40",
    tone: "warning",
    state: "Đi lại quy trình",
  },
];

export function touchesGroupB(vals: Record<string, string>): boolean {
  return FIX_GROUP_B_KEYS.some((k) => (vals[k] ?? "").trim().length > 0);
}

export function hasAnyChange(vals: Record<string, string>): boolean {
  return Object.keys(vals).some((k) => (vals[k] ?? "").trim().length > 0);
}
