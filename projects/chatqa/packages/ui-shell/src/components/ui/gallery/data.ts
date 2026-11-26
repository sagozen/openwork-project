// Dữ liệu mẫu CHỈ cho thư viện thành phần dev (/#/__ui). Văn bản giữ nguyên như khung pen D7XS6, hR039, wcyQW.
// File này chỉ được import từ main.tsx trong nhánh import.meta.env.DEV nên không vào bản build.
import type { AvatarTone } from '../chips';

export interface DemoUser {
  id: string;
  name: string;
  initials: string;
  tone: AvatarTone;
  tag?: 'deployer' | 'locked';
  username: string;
  role: string;
  /** Cờ cấp app 01-04; bỏ trống = vai Vipo chỉ có "Gửi yêu cầu". */
  apps?: [boolean, boolean, boolean, boolean];
  status: { tone: 'green' | 'amber' | 'red'; label: string };
  machine: string;
  lastLogin: string;
}

export const DEMO_USERS: DemoUser[] = [
  { id: 'anhtung', name: 'Hoàng Anh Tùng', initials: 'AT', tone: 'admin', username: 'anhtung', role: 'admin', apps: [true, true, true, true], status: { tone: 'green', label: 'Hoạt động' }, machine: 'PC-VP-01', lastLogin: '10:42 hôm nay' },
  { id: 'hsdesk.bao', name: 'Nguyễn Quốc Bảo', initials: 'QB', tone: 'ai', tag: 'deployer', username: 'hsdesk.bao', role: 'admin', apps: [true, true, true, true], status: { tone: 'green', label: 'Hoạt động' }, machine: 'LAP-HSD', lastLogin: 'Hôm qua 16:20' },
  { id: 'tranlan', name: 'Trần Lan', initials: 'TL', tone: 'manager', username: 'tranlan', role: 'manager', apps: [true, true, true, true], status: { tone: 'green', label: 'Hoạt động' }, machine: 'PC-BG-02', lastLogin: '09:15 hôm nay' },
  { id: 'leha', name: 'Lê Hà', initials: 'LH', tone: 'leader', username: 'leha', role: 'leader', apps: [true, true, true, false], status: { tone: 'amber', label: 'Khoá tạm' }, machine: 'PC-KHO-01', lastLogin: '08:03 hôm nay' },
  { id: 'phamminh', name: 'Phạm Minh', initials: 'PM', tone: 'staff', username: 'phamminh', role: 'staff', apps: [true, false, true, false], status: { tone: 'green', label: 'Hoạt động' }, machine: 'PC-KB-03', lastLogin: '07/11 14:30' },
  { id: 'dothuha', name: 'Đỗ Thu Hà', initials: 'TH', tone: 'locked', tag: 'locked', username: 'dothuha', role: 'staff', apps: [false, true, false, false], status: { tone: 'red', label: 'Đã khoá' }, machine: 'PC-KHO-02', lastLogin: '28/10 11:05' },
  { id: 'vipo.lienhe', name: 'Vipo Logistics', initials: 'VP', tone: 'vipo', username: 'vipo.lienhe', role: 'vipo', status: { tone: 'green', label: 'Hoạt động' }, machine: 'PC-VIPO', lastLogin: '05/11 09:40' },
];

/** Ô bảng quyền: on/off, locked (ổ khoá), cell không khoá nhưng off. */
export type MatrixCell = { on: boolean; locked?: boolean; noSlot?: boolean };
export type MatrixRow = { label: string; sub?: string; cells: [MatrixCell, MatrixCell, MatrixCell, MatrixCell] };
export type MatrixItem = { group: string; note?: string } | MatrixRow;

const A: MatrixCell = { on: true, locked: true }; // admin: bật + khoá
const L0: MatrixCell = { on: false, locked: true };
const N0: MatrixCell = { on: false };
const N1: MatrixCell = { on: true };
const NS: MatrixCell = { on: false, noSlot: true }; // không chừa chỗ ổ khoá (hàng ngân sách AI)

// Thẻ trái của khung hR039 (QUẢN TRỊ + DỮ LIỆU CHUNG)
export const MATRIX_LEFT: MatrixItem[] = [
  { group: 'QUẢN TRỊ', note: '2 dòng đầu chỉ admin có' },
  { label: 'Tài khoản, bảng quyền, máy, nhật ký', sub: 'Tạo, sửa, khoá tài khoản; đặt lại mật khẩu; chỉnh bảng quyền, quyền duyệt, app theo người', cells: [A, L0, L0, L0] },
  { label: 'Kết nối Drive công ty', cells: [A, L0, L0, L0] },
  { label: 'Đặt, bổ sung ngân sách AI', cells: [A, NS, NS, NS] },
  { group: 'DỮ LIỆU CHUNG' },
  { label: 'Nạp, gỡ biểu thuế và DS chống bán phá giá', cells: [A, N1, N0, N0] },
  { label: 'Chọn bản biểu khi hai máy cùng nạp', cells: [A, N0, N0, N0] },
  { label: 'Lưu, khôi phục sổ quy tắc phân loại', cells: [A, N1, N0, N0] },
  { label: 'Rà soát Sổ dạy AI, sửa bài học đã rà soát', cells: [A, N1, N0, N0] },
  { label: 'Nạp, gỡ Danh mục rủi ro', cells: [A, N1, N0, N0] },
  { label: 'Nạp, gỡ dữ liệu lịch sử', sub: 'Gồm cả xem màn Nạp dữ liệu lịch sử', cells: [A, N1, N0, N0] },
  { label: 'Thiết lập mẫu xuất', sub: 'Bảng ánh xạ mã biểu thuế, quy đổi ĐVT', cells: [A, N1, N0, N0] },
  { label: 'Đặt tỷ giá cấp đợt cho báo giá', cells: [A, N1, N0, N0] },
  { label: 'Chỉnh ngưỡng Cặp mã dễ nhầm', cells: [A, N1, N0, N0] },
  { label: 'Ánh xạ cột Sheet Vipo; xử lý dòng nhận trùng', cells: [A, N1, N0, N0] },
];
