import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Toast } from '../ui';

interface ToastCtx {
  /** Hiện thông báo nổi tối giữa đáy cửa sổ; tự tắt sau vài giây hoặc khi bấm "Đóng". */
  show: (message: ReactNode, icon?: ReactNode) => void;
}

const Ctx = createContext<ToastCtx | null>(null);
const SHOW_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<{ id: number; message: ReactNode; icon?: ReactNode } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setItem(null);
  }, []);
  const show = useCallback((message: ReactNode, icon?: ReactNode) => {
    clearTimeout(timer.current);
    setItem({ id: Date.now(), message, icon });
    timer.current = setTimeout(() => setItem(null), SHOW_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {item && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[24px] z-[60] flex justify-center">
          <Toast
            key={item.id}
            icon={item.icon}
            className="pointer-events-auto"
            action={
              <button type="button" onClick={close} className="shrink-0 text-[12.5px]/[16px] font-semibold text-chrome-icon hover:text-white">
                Đóng
              </button>
            }
          >
            {item.message}
          </Toast>
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast ngoài ToastProvider');
  return c;
}
