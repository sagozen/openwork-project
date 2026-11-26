import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Avatar } from '../ui';
import { useIsPhone } from '../../lib/use-phone';
import { PhoneShell, type PhoneShellProps } from './PhoneShell';
import type { ShellNavSection } from './nav';
import { WebShell } from './WebShell';
import { VersionFooter } from './VersionFooter';
import { ADMIN_PATH, useWebChrome } from './web-chrome';
import { SyncBadge } from '../SyncBadge';
import { DriveAlertBanner } from '../DriveSyncHost';
import { useDriveSync } from '../../sync/drive-sync';

export interface WebScreenProps {
  /** Sidebar sáng (khu Quản trị). Điện thoại không có sidebar: dùng menu Quản trị riêng. */
  sections?: ShellNavSection[];
  scopeNote?: { title: string; text: string };
  /** Thân không đệm, nội dung căn giữa. */
  bare?: boolean;
  /** Điện thoại: tiêu đề, nút quay lại (đường dẫn) hoặc menu, thân đệm. */
  phone?: { title?: string; back?: string; menu?: boolean } & Pick<PhoneShellProps, 'padded' | 'bodyClass'>;
  children?: ReactNode;
}

/** Màn web đã đăng nhập: WebShell từ 768px, PhoneShell dưới 768px (BR-016: Báo cáo, Quản trị, không có quyền). */
export function WebScreen({ sections, scopeNote, bare, phone = {}, children }: WebScreenProps) {
  const isPhone = useIsPhone();
  const chrome = useWebChrome();
  const navigate = useNavigate();
  const drive = useDriveSync();
  const badge = drive ? <SyncBadge surface="light" compact={isPhone} /> : undefined;
  // FR-017: cảnh báo Drive cho admin ngay khi mở app, trên mọi màn.
  const body = bare ? children : (
    <>
      <DriveAlertBanner className="" />
      {children}
    </>
  );
  if (isPhone) {
    const lead = phone.back
      ? { kind: 'back' as const, label: 'Quay lại', onClick: () => navigate(phone.back!) }
      : phone.menu
        ? { kind: 'menu' as const, label: 'Menu', onClick: () => navigate(chrome.shell.topNav?.some((n) => n.key === 'admin') ? ADMIN_PATH : '/') }
        : undefined;
    return (
      <div className="h-dvh">
        <PhoneShell
          title={phone.title}
          lead={lead}
          padded={phone.padded}
          bodyClass={phone.bodyClass}
          right={
            <>
              {badge}
              {chrome.initials ? <button type="button" aria-label="Tài khoản" onClick={chrome.toggleMenu} className="flex shrink-0"><Avatar initials={chrome.initials} tone={chrome.tone} size={30} fontSize={10} /></button> : null}
            </>
          }
        >
          {body}
        </PhoneShell>
        {chrome.portals}
      </div>
    );
  }
  return (
    <div className="h-dvh">
      <WebShell {...chrome.shell} sections={sections} scopeNote={scopeNote} bare={bare} sync={badge} footer={<VersionFooter />}>
        {body}
      </WebShell>
      {chrome.portals}
    </div>
  );
}
