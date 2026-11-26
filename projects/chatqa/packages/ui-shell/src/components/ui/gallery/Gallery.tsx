import { useEffect, useState } from 'react';
import { Lock, UserPlus } from 'lucide-react';
import { Banner, Button, Checkbox, Dialog, Segmented, Stepper, Tabs, Toast, Toggle, Input } from '..';
import { LoginBoard } from './LoginBoard';
import { MatrixBoard } from './MatrixBoard';
import { ShellBoard } from './ShellBoard';
import { TableBoard } from './TableBoard';
import { AUTH_BOARDS } from '../../../pages/auth/boards';
import { ADMIN_BOARDS } from '../../../pages/admin/dev/AdminBoards';

/** Bảng để harness chụp: mỗi bảng vẽ đúng 1 vùng khung pen ở toạ độ (0,0). Thêm bảng = thêm 1 dòng + 1 mục checks trong visual/frames.json. */
const BOARDS: Record<string, { title: string; el: () => React.ReactNode }> = {
  'table-d7xs6': { title: 'Bảng người dùng (D7XS6)', el: () => <TableBoard /> },
  'table-ulxup': { title: 'Bảng người dùng bản web (ULXup)', el: () => <TableBoard width={1148} menu={false} /> },
  'matrix-hr039': { title: 'Bảng quyền, thẻ trái (hR039)', el: () => <MatrixBoard /> },
  'shell-d7xs6': { title: 'Shell Windows (D7XS6)', el: () => <ShellBoard /> },
  'login-wcyqw': { title: 'Thẻ đăng nhập (wcyQW)', el: () => <LoginBoard /> },
  ...AUTH_BOARDS,
  ...ADMIN_BOARDS,
};

function useHashBoard() {
  const read = () => location.hash.replace(/^#\/__ui\/?/, '');
  const [board, setBoard] = useState(read);
  useEffect(() => {
    const on = () => setBoard(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return board;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[11px]/[14px] font-bold tracking-[1.2px] text-text-3 uppercase">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

function Index() {
  const [tab, setTab] = useState('users');
  const [seg, setSeg] = useState('staff');
  const [on, setOn] = useState(true);
  const [chk, setChk] = useState(true);
  return (
    <div className="flex flex-col gap-8 p-8 font-sans leading-[normal] text-text">
      <h1 className="text-2xl font-bold tracking-[-0.4px]">Thành phần giao diện (dev)</h1>
      <p className="text-[13px]/[16px] text-text-2">
        Bảng so ảnh: {Object.entries(BOARDS).map(([k, b]) => (
          <a key={k} href={`#/__ui/${k}`} className="mr-3 text-ai underline">{b.title}</a>
        ))}
      </p>
      <Section title="Button">
        <Button>Thêm người dùng</Button>
        <Button variant="secondary">Về mặc định</Button>
        <Button variant="danger">Khoá tài khoản</Button>
        <Button disabled>Vô hiệu</Button>
        <Button size="dialog">Đăng nhập lại</Button>
        <Button size="sm">Công nhận</Button>
        <Button size="xs" variant="secondary">Từ chối</Button>
        <div className="w-[356px]"><Button size="auth" block>Kích hoạt</Button></div>
      </Section>
      <Section title="Input">
        <div className="w-[300px]"><Input label="Tên đăng nhập" size="login" defaultValue="phamminh" /></div>
        <div className="w-[300px]"><Input label="Mật khẩu" size="login" password defaultValue="mat-khau-12" /></div>
        <div className="w-[300px]"><Input label="Mã bản quyền" size="license" mono defaultValue="HSD-7K2Q-ANTU-9F4M" invalid /></div>
        <div className="w-[300px]"><Input label="Tên hiển thị" size="dialog" hint="Ít nhất 8 ký tự" /></div>
        <div className="w-[300px]"><Input label="Tên đăng nhập" size="phone" defaultValue="tranlan" /></div>
      </Section>
      <Section title="Tabs, Segmented, Toggle, Checkbox, Stepper">
        <Tabs value={tab} onChange={setTab} items={[{ key: 'users', label: 'Người dùng & quyền' }, { key: 'matrix', label: 'Bảng quyền theo vai' }, { key: 'pending', label: 'Chờ công nhận', count: 3 }]} className="w-[460px]" />
        <Segmented value={seg} onChange={setSeg} className="w-[420px]" options={[{ key: 'admin', label: 'Admin' }, { key: 'manager', label: 'Manager' }, { key: 'leader', label: 'Leader' }, { key: 'staff', label: 'Nhân viên' }, { key: 'vipo', label: 'Vipo' }]} />
        <Toggle checked={on} onChange={setOn} />
        <Toggle checked locked />
        <Toggle checked={false} locked />
        <Toggle checked dirty />
        <Toggle size="setting" checked={on} onChange={setOn} />
        <Checkbox checked={chk} onChange={setChk}>App 01 · Báo giá</Checkbox>
        <Stepper steps={['Kích hoạt máy', 'Đăng nhập']} current={0} />
      </Section>
      <Section title="Banner, Toast">
        <div className="w-[356px]"><Banner tone="red">Mã bản quyền không đúng. Kiểm tra lại hoặc liên hệ bên triển khai HS Desk.</Banner></div>
        <div className="w-[356px]"><Banner tone="amber">Cần kết nối mạng để kích hoạt bản quyền trên máy này.</Banner></div>
        <Toast>Bạn không có quyền mở lại lô đã xuất. Liên hệ admin.</Toast>
      </Section>
      <Section title="Dialog">
        <Dialog
          overlay={false}
          icon={<UserPlus size={18} />}
          title="Thêm người dùng"
          subtitle="Một tài khoản dùng cho mọi app công ty đã kích hoạt"
          onClose={() => undefined}
          note="Người dùng phải đổi mật khẩu ở lần đăng nhập đầu."
          actions={
            <>
              <Button variant="secondary">Hủy</Button>
              <Button>Thêm người dùng</Button>
            </>
          }
        >
          <Input label="Tên đăng nhập" defaultValue="phamminh" mono />
          <Segmented value="staff" options={[{ key: 'admin', label: 'Admin' }, { key: 'staff', label: 'Nhân viên' }]} />
        </Dialog>
        <Dialog overlay={false} variant="compact" tone="red" icon={<Lock size={18} />} title="Tài khoản đã bị khoá" actions={<Button size="dialog">Đăng xuất</Button>}>
          Tài khoản của bạn đã bị khoá lúc 11/11 14:05. Liên hệ admin.
        </Dialog>
      </Section>
    </div>
  );
}

/** Trang /#/__ui (chỉ dev). /#/__ui/<bảng> vẽ riêng một bảng để so ảnh với khung pen. */
export function Gallery() {
  const board = useHashBoard();
  // ?demo=... (trạng thái minh hoạ của màn quản trị) nằm sau dấu ? của hash, không thuộc tên bảng
  const b = BOARDS[board.split('?')[0]];
  if (!b) return <Index />;
  return <div className="bg-bg">{b.el()}</div>;
}
