import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, HashRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { GitCompareArrows, Plug, Settings } from 'lucide-react';
import { isDesktop } from '@shell/platform';
import { isAdmin } from '@shell/platform/roles';
import { SessionProvider, useSession, errorText } from '@shell/lib/session';
import { entryScreen } from '@shell/lib/auth-flow';
import { Button } from '@shell/components/ui';
import { ErrorBoundary } from '@shell/components/ErrorBoundary';
import { UpdateBanner } from '@shell/components/UpdateBanner';
import { WindowsShell, WebScreen } from '@shell/components/shell';
import { useAppPick, useShellChrome } from '@shell/components/shell/use-shell-chrome';
import { ADMIN_PATH, PASSWORD_PATH, REPORT_PATH } from '@shell/components/shell/web-chrome';
import { ToastProvider } from '@shell/components/overlays/ToastHost';
import { SessionOverlays } from '@shell/components/overlays/SessionOverlays';
import { REVIEW_PATH, ReviewBanner } from '@shell/components/overlays/ReviewBanner';
import { ActivatePage } from '@shell/pages/auth/ActivatePage';
import { AuthScreen } from '@shell/pages/auth/AuthScreen';
import { ChangePasswordPage } from '@shell/pages/auth/ChangePasswordPage';
import { LoginPage } from '@shell/pages/auth/LoginPage';
import { ReviewOpsPage } from '@shell/pages/auth/ReviewOpsPage';
import { PublicRoutes } from '@shell/pages/public/PublicRoutes';
import { isPublicPath, LOGIN_PATH, POLICY_PATH, TERM_PATH } from '@shell/pages/public/paths';
import { PolicyPage } from '@shell/pages/public/PolicyPage';
import { TermsPage } from '@shell/pages/public/TermsPage';
import type { AdminExtraTab } from '@shell/pages/admin/admin-context';
import { ModuleRoute } from '@shell/modules/_shared/ModuleRoute';
import { PRODUCT } from './product';
import { MODULES, moduleByCode, moduleOfPath, pagePath } from './modules/registry';
import { CentreEmpty, Workspace } from './workspace/Workspace';
import { MetricsPane } from './testing/MetricsPane';
import { usePageViews } from './testing/use-page-views';
import { ChatProvider, useChatActions } from './chat/ChatPane';
import { ChatBar, ChatSurface, EngineProvider } from './agentchat/engine';
import { ActivityPane } from './monitor/ActivityPane';
import { WebNotice } from './pwa/WebNotice';
import { LiveProvider, useLive } from './live/LiveProvider';
import { DeviceList } from './live/DeviceList';
import { Centre } from './live/LiveGrid';

// Khu quản trị dùng chung (người dùng, bảng quyền, máy, dịch vụ AI...) tải lười: người không phải admin không tải mã của chúng.
const AdminRoutes = lazy(() => import('@shell/pages/admin/AdminRoutes'));
const TestSettingsPage = lazy(() => import('./testing/TestSettingsPage'));
const AgentSettingsPage = lazy(() => import('./agentchat/AgentSettingsPage'));

/** Tab riêng của ChatQASoftware trong Cài đặt (ngoài các tab chung của khu quản trị). */
const ADMIN_EXTRA_TABS: AdminExtraTab[] = [
  { key: 'test', label: 'Kiểm thử', path: 'kiem-thu', element: <TestSettingsPage /> },
  { key: 'agent', label: 'Agent', path: 'agent', element: <AgentSettingsPage /> },
];
const AdminArea = lazy(() => import('@shell/pages/web/AdminArea'));

// Desktop dùng HashRouter (asset server của Wails không fallback SPA), PWA dùng BrowserRouter dưới /qa/.
const Router = isDesktop ? HashRouter : BrowserRouter;
const basename = isDesktop ? undefined : import.meta.env.BASE_URL.replace(/\/$/, '') || undefined;

const SETTINGS_PATH = '/cai-dat';
const Loading = () => <p className="py-16 text-center text-sm text-text-3">Đang tải...</p>;

function StartupError() {
  const { error, refresh } = useSession();
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="font-semibold text-slate-900">Không khởi động được {PRODUCT.name}</p>
      <p className="max-w-sm text-sm text-slate-500">{errorText(error)}</p>
      <Button onClick={() => void refresh()}>Thử lại</Button>
    </div>
  );
}

/** Cửa sổ Windows: thanh tiêu đề dùng chung (đồng bộ, tài khoản, hàng tab đổi app), không có sidebar. */
function DesktopFrame({ children }: { children: ReactNode }) {
  const { company, state } = useSession();
  const { chrome, portals } = useShellChrome();
  const { pathname } = useLocation();
  const pick = useAppPick();
  const apps = state?.apps ?? [];
  usePageViews(); // mở trang -> lịch sử sử dụng cục bộ (lỗi ghi bỏ qua)
  useEffect(() => {
    document.title = PRODUCT.name;
  }, []);
  return (
    <div className="h-dvh">
      <WindowsShell appName={PRODUCT.name} workspace={company} {...chrome} apps={apps} activeApp={moduleOfPath(pathname)?.code} onPickApp={pick} search={false}>
        {children}
      </WindowsShell>
      {portals}
    </div>
  );
}

/** Nút phụ ở chân màn làm việc: chữ xám, chỉ đổi màu khi trỏ/đi bằng bàn phím để không tranh chỗ với nút gửi lệnh. */
const FOOT_LINK = 'flex h-[24px] items-center gap-[5px] rounded-[4px] px-[4px] font-semibold text-text-2 hover:bg-muted-box hover:text-accent';

function AdminButton() {
  const { state } = useSession();
  const navigate = useNavigate();
  if (!isAdmin(state?.user?.role)) return null;
  return (
    <button type="button" onClick={() => navigate(SETTINGS_PATH)} className={FOOT_LINK}>
      <Settings size={13} />
      Quản trị
    </button>
  );
}

/** Mở màn Kết nối AI (MCP): bật máy chủ, lấy token và cấu hình cho Claude Desktop, Claude Code, Codex. */
function McpButton() {
  const { appAccess } = useSession();
  const navigate = useNavigate();
  if (appAccess('cqs.tower') !== 'ok') return null;
  return (
    <button type="button" onClick={() => navigate(`${moduleByCode('cqs.tower').path}/mcp`)} className={FOOT_LINK}>
      <Plug size={13} />
      Kết nối AI
    </button>
  );
}

/** Mở thẳng phần Đánh giá ảnh hưởng (git-impact) ở đầu màn Kiểm thử. */
function GitImpactButton() {
  const { appAccess } = useSession();
  const navigate = useNavigate();
  if (appAccess('cqs.test') !== 'ok') return null;
  return (
    <button type="button" onClick={() => navigate(moduleByCode('cqs.test').path)} className={FOOT_LINK}>
      <GitCompareArrows size={13} />
      Git impact
    </button>
  );
}

/** Màn 4 ô nối với tháp: ô 1 danh sách máy, khung giữa chuyển giữa chat (route con) và màn hình trực tiếp. */
function LiveWorkspace() {
  const { devices } = useLive();
  const actions = useChatActions();
  return (
    <Workspace
      devices={devices.filter((d) => d.state !== 'disconnected').length}
      deviceTotal={devices.length}
      deviceList={<DeviceList />}
      centre={<Centre chat={<Outlet />} />}
      statusExtra={
        <>
          <McpButton />
          <GitImpactButton />
          <AdminButton />
        </>
      }
      metrics={<MetricsPane />}
      activity={<ActivityPane actions={actions} />}
      commandBar={<ChatBar />}
    />
  );
}

/** Màn chính trên desktop: 4 ô, route con hiện ở khung giữa. */
function DesktopWorkspace() {
  return (
    <DesktopFrame>
      <UpdateBanner />
      <ReviewBanner />
      <LiveProvider>
        <ChatProvider>
          <EngineProvider>
            <LiveWorkspace />
          </EngineProvider>
        </ChatProvider>
      </LiveProvider>
    </DesktopFrame>
  );
}

function DesktopAdmin() {
  const navigate = useNavigate();
  return (
    <DesktopFrame>
      <button type="button" onClick={() => navigate('/')} className="self-start text-[12.5px]/[16px] font-semibold text-accent">
        ← Về màn làm việc
      </button>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Suspense fallback={<Loading />}>
          <AdminRoutes extraTabs={ADMIN_EXTRA_TABS} />
        </Suspense>
      </div>
    </DesktopFrame>
  );
}

function DesktopRoutes() {
  const { state } = useSession();
  const admin = isAdmin(state?.user?.role);
  return (
    <Routes>
      <Route element={<DesktopWorkspace />}>
        <Route index element={<ChatSurface />} />
        {/* Route sinh từ danh mục phân hệ - thêm app/trang mới không sửa file này */}
        {MODULES.flatMap((m) => m.pages.map((p) => <Route key={`${m.code}/${p.path}`} path={pagePath(m, p)} element={<ModuleRoute m={m} p={p} />} />))}
        <Route path={REVIEW_PATH} element={<ReviewOpsPage />} />
        {/* Hộp Đổi mật khẩu mở từ menu tài khoản; đường dẫn này chỉ để mở thẳng hộp (useShellChrome vẽ hộp) */}
        <Route path={PASSWORD_PATH} element={<CentreEmpty />} />
      </Route>
      {admin && <Route path={`${SETTINGS_PATH}/*`} element={<DesktopAdmin />} />}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Bản web/điện thoại: chỉ lời nhắc xem kết quả trong app trên máy tính (báo cáo nằm trên máy), Quản trị cho Admin. */
function WebWorkspace({ admin }: { admin: boolean }) {
  return (
    <WebScreen phone={{ title: PRODUCT.name, menu: true, padded: false, bodyClass: 'flex flex-col p-[12px]' }}>
      <WebNotice admin={admin} />
    </WebScreen>
  );
}

function WebRoutes() {
  const { state } = useSession();
  const admin = isAdmin(state?.user?.role);
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route index element={<WebWorkspace admin={admin} />} />
        <Route path={LOGIN_PATH} element={<Navigate to="/" replace />} />
        {/* Trang pháp lý công khai: người đã đăng nhập vẫn mở được (link ở chân trang) */}
        <Route path={POLICY_PATH} element={<PolicyPage />} />
        <Route path={TERM_PATH} element={<TermsPage />} />
        {/* Thanh trên của web có mục "Báo cáo" (vai có report.view): ở ChatQASoftware báo cáo nằm trên máy, chỉ hiện lời nhắc */}
        <Route path={REPORT_PATH} element={<WebWorkspace admin={admin} />} />
        <Route path={PASSWORD_PATH} element={<WebScreen bare />} />
        {admin && <Route path={`${ADMIN_PATH}/*`} element={<AdminArea />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

/** Máy trạng thái vào app: kích hoạt -> đăng nhập -> (đổi mật khẩu bắt buộc) -> màn chính, cùng hộp thoại toàn cục đè lên (lib/auth-flow.ts). */
function Gate() {
  const { state, loading, error } = useSession();
  const { pathname } = useLocation();
  // Web: trang chủ, chính sách, điều khoản và trang đăng nhập mở được trước khi có phiên, không phụ thuộc API.
  const webPublic = !isDesktop && isPublicPath(pathname);
  if (loading && !webPublic) return <div className="flex h-dvh items-center justify-center text-sm text-slate-400">Đang tải...</div>;
  if (!state && error && !webPublic) return <StartupError />;

  const entry = entryScreen(state, isDesktop);
  let screen: ReactNode;
  if (entry === 'loading') {
    screen = webPublic ? <PublicRoutes /> : null;
  } else {
    switch (entry) {
      case 'activate':
        screen = <ActivatePage />;
        break;
      case 'login':
        // Desktop vẫn là màn đăng nhập của cửa sổ; web tách trang chủ công khai khỏi màn đăng nhập (/dang-nhap).
        screen = isDesktop ? <LoginPage /> : <PublicRoutes />;
        break;
      case 'mustChange':
        screen = <ChangePasswordPage />;
        break;
      case 'locked':
        // Máy bị thu hồi: chỉ còn hộp thoại "Đóng app" đè lên khung trống.
        screen = <AuthScreen workspace="Máy đã bị thu hồi">{null}</AuthScreen>;
        break;
      default:
        screen = isDesktop ? <DesktopRoutes /> : <WebRoutes />;
    }
  }
  return (
    <>
      {screen}
      <SessionOverlays />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary scope={PRODUCT.name}>
      <SessionProvider>
        <Router basename={basename}>
          <ToastProvider>
            <Gate />
          </ToastProvider>
        </Router>
      </SessionProvider>
    </ErrorBoundary>
  );
}
