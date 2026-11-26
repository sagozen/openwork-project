import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const root = createRoot(document.getElementById('root')!);

// Chỉ có ở dev (nhánh bị loại khỏi bản build vì import.meta.env.DEV là hằng false): /#/__shell vẽ màn 4 ô trống,
// không cần phiên hay Go (xem bố cục, chụp ảnh so sánh); thêm ?web để xem bản chỉ xem.
// Thư viện thành phần (/#/__ui) chỉ mở ở HS Desk: các khung mẫu trong đó dùng mã app của HS Desk.
if (import.meta.env.DEV && location.hash.startsWith('#/__shell')) {
  void import('./workspace/Workspace').then(({ Workspace }) =>
    root.render(
      <div className="flex h-dvh flex-col bg-bg p-[12px] font-sans text-text">
        <Workspace devices={0} readOnly={location.hash.includes('web')} />
      </div>,
    ),
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
