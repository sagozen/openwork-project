import { createContext, Suspense, useContext } from 'react';
import { Lock } from 'lucide-react';
import { useSession, type AppAccess } from '../../lib/session';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { appNo, type ModuleDef, type ModulePage } from '@product/modules/registry';

interface Current {
  module: ModuleDef;
  page: ModulePage;
}

const Ctx = createContext<Current | null>(null);

/** App + trang con đang mở (dùng trong trang: tiêu đề, mô tả, phase...). */
export function useCurrentModule(): ModuleDef {
  return useCurrent().module;
}

export function useCurrent(): Current {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCurrent ngoài ModuleRoute');
  return c;
}

const LOCK_TEXT: Record<Exclude<AppAccess, 'ok'>, string> = {
  license: 'chưa có trong bản quyền của máy này',
  user: 'chưa được cấp cho tài khoản của bạn',
};

function Locked({ m, why }: { m: ModuleDef; why: Exclude<AppAccess, 'ok'> }) {
  return (
    <div className="mx-auto mt-24 max-w-md text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
        <Lock className="text-slate-500" />
      </div>
      <h2 className="mt-4 font-semibold text-slate-900">
        {appNo(m)} - {m.name} {LOCK_TEXT[why]}
      </h2>
      <p className="mt-1 text-sm text-slate-500">{m.summary}</p>
      <p className="mt-3 text-sm text-slate-500">Liên hệ Quản lý để được cấp.</p>
    </div>
  );
}

/**
 * Khung chung cho MỌI trang của MỌI app: kiểm tra quyền (bản quyền máy ∩ quyền người dùng;
 * Go chặn lần nữa), tải lazy, cô lập lỗi - 1 trang lỗi không làm sập cả app.
 */
export function ModuleRoute({ m, p }: { m: ModuleDef; p: ModulePage }) {
  const { appAccess } = useSession();
  const access = appAccess(m.code);
  if (access !== 'ok') return <Locked m={m} why={access} />;
  const Page = p.page;
  return (
    <Ctx.Provider value={{ module: m, page: p }}>
      <ErrorBoundary key={`${m.code}/${p.path}`} scope={`${appNo(m)} - ${p.label}`}>
        <Suspense fallback={<p className="py-16 text-center text-sm text-slate-400">Đang tải {p.label}...</p>}>
          <Page />
        </Suspense>
      </ErrorBoundary>
    </Ctx.Provider>
  );
}
