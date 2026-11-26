import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { Button, Dialog } from '../../components/ui';
import { isPlainClick, routeOfHref } from './unsaved-guard';

/** Điều hướng đang chờ người dùng xác nhận: đường dẫn (tab của màn) hoặc phần tử vừa bấm (thanh bên, liên kết) để bấm lại sau khi xác nhận. */
type Pending = { to: string } | { replay: HTMLElement } | null;

/**
 * Chặn rời trang khi `dirty`: bấm tab của màn, mục thanh bên (`aside`/`nav`), liên kết trong app hoặc đóng cửa sổ đều hỏi trước.
 * Router của app (BrowserRouter / HashRouter) không có useBlocker nên chặn ở cú bấm, rồi bấm lại đúng phần tử đó khi người dùng chọn "Bỏ thay đổi".
 * Chưa chặn nút Back của trình duyệt (chỉ có hộp thoại đóng cửa sổ).
 */
export function useUnsavedGuard(dirty: boolean, count: number): { leave: (to: string) => void; dialog: ReactNode } {
  const navigate = useNavigate();
  const here = useLocation();
  const [pending, setPending] = useState<Pending>(null);
  const bypass = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (bypass.current || e.defaultPrevented || !isPlainClick(e)) return;
      const hit = (e.target as Element | null)?.closest?.('a[href], aside button, aside a, nav button, nav a') as HTMLElement | null;
      if (!hit || hit.getAttribute('aria-current') === 'page') return;
      if (hit instanceof HTMLAnchorElement) {
        const to = routeOfHref(hit.href, location.origin, hit.getAttribute('target'));
        if (!to || to === here.pathname + here.search) return;
      }
      e.preventDefault();
      e.stopPropagation();
      setPending({ replay: hit });
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty, here.pathname, here.search]);

  const leave = useCallback((to: string) => (dirty ? setPending({ to }) : navigate(to)), [dirty, navigate]);

  const confirm = () => {
    const p = pending;
    setPending(null);
    if (!p) return;
    if ('to' in p) return navigate(p.to);
    bypass.current = true;
    try {
      p.replay.click();
    } finally {
      bypass.current = false;
    }
  };

  const dialog = pending ? (
    <Dialog
      variant="compact"
      tone="amber"
      icon={<TriangleAlert size={18} />}
      title="Có thay đổi chưa lưu"
      actions={
        <>
          <Button variant="secondary" size="dialog" onClick={() => setPending(null)}>
            Ở lại
          </Button>
          <Button size="dialog" onClick={confirm}>
            Bỏ thay đổi
          </Button>
        </>
      }
    >
      Bảng quyền có {count} thay đổi chưa lưu. Rời trang bây giờ sẽ mất các thay đổi này.
    </Dialog>
  ) : null;

  return { leave, dialog };
}
