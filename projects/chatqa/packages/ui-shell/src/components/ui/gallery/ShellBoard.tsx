import { BookOpen, Cloud, Inbox, MessagesSquare, RefreshCw, Settings, ShieldAlert } from 'lucide-react';
import { WindowsShell, type ShellNavSection } from '../../shell';

const ICON = 17;
/** Sidebar của khung D7XS6 (App 01 · Báo giá, đang ở Cài đặt). */
export const SHELL_SECTIONS: ShellNavSection[] = [
  {
    label: 'APP 01 · BÁO GIÁ',
    items: [
      { key: 'req', label: 'Yêu cầu báo giá', icon: <Inbox size={ICON} />, badge: 12 },
      { key: 'vipo', label: 'Trao đổi với Vipo', icon: <MessagesSquare size={ICON} />, badge: 3, p2: true },
      { key: 'sheet', label: 'Cột Google Sheet', icon: <RefreshCw size={ICON} /> },
    ],
  },
  {
    label: 'TRI THỨC · DÙNG CHUNG',
    items: [
      { key: 'rules', label: 'Quy tắc & biểu thuế', icon: <BookOpen size={ICON} /> },
      { key: 'risk', label: 'Danh mục rủi ro', icon: <ShieldAlert size={ICON} />, p2: true },
    ],
  },
  {
    label: 'CHUNG',
    items: [
      { key: 'cloud', label: 'Lưu trữ đám mây', icon: <Cloud size={ICON} /> },
      { key: 'settings', label: 'Cài đặt', icon: <Settings size={ICON} />, active: true },
    ],
  },
];

/** Cửa sổ Windows đầy đủ 1440×920 với vùng nội dung trống. */
export function ShellBoard() {
  return (
    <div className="h-[920px] w-[1440px]">
      <WindowsShell
        appName="HS Báo giá"
        workspace="App 01 · Công ty Anh Tùng"
        search
        syncText="Đã đồng bộ Google Drive"
        account={{ initials: 'AT', role: 'admin', name: 'Hoàng Anh Tùng' }}
        sections={SHELL_SECTIONS}
        cloud={{ title: 'Google Drive', sub: 'Đồng bộ 2 phút trước', used: 'Đã dùng 3,2 GB', retention: 'Theo gói Google Drive' }}
      />
    </div>
  );
}
