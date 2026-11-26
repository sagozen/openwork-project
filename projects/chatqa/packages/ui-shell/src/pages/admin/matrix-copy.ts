// Chữ hiển thị của bảng quyền (hR039). Mã quyền, nhóm và ô khoá lấy từ contracts/permissions.json; file này chỉ giữ tên ngắn + ghi chú
// theo bản thiết kế sau rà soát. Quyền mới chưa có ở đây thì dùng nhãn đầy đủ trong contract (không mất dòng nào).
import permissions from '@contracts/permissions.json';
import { PRODUCT } from '@product/product';
import { IS_HSDESK } from '../../lib/catalog';
import { shown, type Cells } from './matrix-draft';

/**
 * Sản phẩm lọc bảng quyền theo vai. ChatQASoftware chỉ bày quyền của chính nó (không còn nhóm/quyền HS Desk như
 * "Kết nối Drive"); HS Desk giữ nguyên: mọi quyền của sản phẩm công ty có bản quyền (mã cũ hiển thị như trước).
 */
export const MATRIX_PRODUCT: string | undefined = IS_HSDESK ? undefined : PRODUCT.code;

export interface PermCopy {
  label: string;
  sub?: string;
  /** Dòng nổi bật (quyền duyệt): nền cam nhạt, vạch cam bên trái, cờ. */
  highlight?: boolean;
}

export const PERM_COPY: Record<string, PermCopy> = {
  'admin.accounts': { label: 'Tài khoản, bảng quyền, máy, nhật ký', sub: 'Tạo, sửa, khoá tài khoản; đặt lại mật khẩu; chỉnh bảng quyền, quyền duyệt, app theo người' },
  'admin.drive': { label: 'Kết nối Drive công ty' },
  'admin.ai_budget': { label: 'Đặt, bổ sung ngân sách AI' },
  'tariff.load': { label: 'Nạp, gỡ biểu thuế và DS chống bán phá giá' },
  'tariff.pick_version': { label: 'Chọn bản biểu khi hai máy cùng nạp' },
  'rules.save': { label: 'Lưu, khôi phục sổ quy tắc phân loại' },
  'teach.review': { label: 'Rà soát Sổ dạy AI, sửa bài học đã rà soát' },
  'risk.load': { label: 'Nạp, gỡ Danh mục rủi ro' },
  'history.import': { label: 'Nạp, gỡ dữ liệu lịch sử', sub: 'Gồm cả xem màn Nạp dữ liệu lịch sử' },
  'export.template': { label: 'Thiết lập mẫu xuất', sub: 'Bảng ánh xạ mã biểu thuế, quy đổi ĐVT' },
  'export.rate': { label: 'Đặt tỷ giá cấp đợt cho báo giá' },
  'teach.threshold': { label: 'Chỉnh ngưỡng Cặp mã dễ nhầm' },
  'vipo.mapping': { label: 'Ánh xạ cột Sheet Vipo; xử lý dòng nhận trùng' },
  'approve.review': { label: 'Quyền duyệt hàng rủi ro Cao, Trung bình', sub: 'Duyệt, Yêu cầu sửa; chọn bản khi xung đột trạng thái · mặc định bật cho Admin và Manager', highlight: true },
  'approve.unflag_high': { label: 'Gỡ cờ rủi ro mức Cao' },
  'approve.hold_high': { label: 'Giữ mã, “Không thuộc danh mục” cho hàng mức Cao' },
  'approve.unlock_item': { label: 'Mở khoá mặt hàng đang có người sửa' },
  'lot.criteria': { label: 'Tiêu chí gộp, giữ lô, mở lại lô đã xuất', sub: 'Lưu tiêu chí gộp; nhận giữ thay, chuyển quyền giữ lô' },
  'lot.restore': { label: 'Khôi phục bản người khác tạo', sub: 'Duyệt danh sách chờ thay đổi offline vào lô đã chuyển quyền' },
  'report.view': { label: 'Xem báo cáo' },
  'work.do': {
    label: 'Báo giá, gộp lô, kiểm tra, xuất tệp; ghi bài học',
    sub: 'Gồm gỡ cờ, giữ mã, “Không thuộc danh mục” cho hàng mức Trung bình (kèm lý do); sửa, gỡ bài học của mình khi Chưa rà soát. Xuất tệp chỉ người giữ lô.',
  },
  'cqs.budget': { label: 'Trần ngân sách', sub: 'Đặt trần; chạy lệnh vượt trần mặc định' },
  'cqs.devices': { label: 'Tạo, xoá, đặt lại máy', sub: 'Mua proxy, thuê số; hỏi xác nhận 1 lần' },
  'cqs.credentials': { label: 'Quản lý credentials', sub: 'Không ai xem được giá trị' },
  'cqs.run': { label: 'Chạy task, flow, kiểm thử', sub: 'Dừng, chạy lại, chạm tay thay agent' },
  'cqs.automations': { label: 'Lịch chạy, trigger, webhook' },
  'cqs.reports': { label: 'Gửi báo cáo cho khách' },
};

/** Ghi chú cạnh tiêu đề nhóm. */
export const GROUP_NOTE: Record<string, string> = {
  'Quản trị': '2 dòng đầu chỉ admin có',
  Duyệt: 'v1 chỉ làm trên app Windows',
};

export const permCopy = (code: string): PermCopy => PERM_COPY[code] ?? { label: permissions.permissions.find((p) => p.code === code)?.label ?? code };

/** Hai thẻ cạnh nhau như khung pen: Quản trị + Dữ liệu chung bên trái; các nhóm còn lại bên phải. Thẻ thứ ba là nhóm của ChatQASoftware. */
export const MATRIX_COLUMNS: string[][] = [
  ['Quản trị', 'Dữ liệu chung'],
  ['Duyệt', 'Lô', 'Báo cáo', 'Làm việc'],
  ['Điều phối', 'Kiểm thử', 'Giám sát'],
];

/** Thẻ và nhóm còn ít nhất một quyền hiện (sản phẩm có bản quyền). `product` = chỉ lấy quyền của sản phẩm đó. */
export const matrixColumns = (cells: Cells, product?: string): string[][] =>
  MATRIX_COLUMNS.map((groups) => groups.filter((g) => permissions.permissions.some((p) => (!product || p.product === product) && p.group === g && shown(cells, p.code)))).filter((groups) => groups.length > 0);

export const MATRIX_FOOTNOTE =
  'Theo bảng BR-002. Thay đổi áp cho mọi người cùng vai từ lúc lưu: máy có mạng nhận trong tối đa 15 phút, nâng quyền có hiệu lực khi máy kết nối. Ô viền cam là ô vừa đổi, chưa lưu.';
