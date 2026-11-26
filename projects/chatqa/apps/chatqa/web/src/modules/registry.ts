// Danh mục phân hệ phía UI = contracts/apps.json (tên, số app, nhóm, phase) + phần giao diện (đường dẫn, icon, trang con).
// Cùng hình dạng với danh mục của HS Desk vì shell dùng chung (packages/ui-shell) đọc nó qua @product/modules/registry.
// ChatQASoftware không có sidebar: mỗi app mở ở khung giữa của màn 4 ô (src/workspace). Test src/modules/registry.test.ts fail nếu lệch contracts.
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { Activity, FileText, FlaskConical, Plug, Radar, RefreshCw, type LucideIcon } from 'lucide-react';
import { PRODUCT_APPS } from '@shell/lib/catalog';
import type { AppCode } from '@shell/platform';

export type ModuleGroup = 'flow' | 'knowledge';
type Page = LazyExoticComponent<ComponentType>;

/** 1 trang con của app. */
export interface ModulePage {
  /** Đường dẫn tương đối trong app; '' = trang mở đầu. */
  path: string;
  label: string;
  icon: LucideIcon;
  phase: 1 | 2;
  /** Chỉ HS Desk dùng (mục trong báo giá); để trống ở ChatQASoftware. */
  quoteRef?: string;
  page: Page;
}

export interface ModuleDef {
  code: AppCode;
  no: number;
  name: string;
  group: ModuleGroup;
  phase: number;
  status: 'active' | 'planned';
  /** Đường dẫn gốc của app (tiếng Việt không dấu). */
  path: string;
  icon: LucideIcon;
  /** Tên ngắn cho badge / tab mobile. */
  short: string;
  summary: string;
  pages: ModulePage[];
  mobile?: boolean;
}

type UIPart = Pick<ModuleDef, 'path' | 'icon' | 'short' | 'summary' | 'pages' | 'mobile'>;

// Trang giữ chỗ của shell: các app chưa có nghiệp vụ.
const p = (path: string, label: string, icon: LucideIcon, page: Page): ModulePage => ({ path, label, icon, phase: 1, page });
const monitorPage: Page = lazy(() => import('../monitor/MonitorPage'));
const mcpPage: Page = lazy(() => import('../tower/McpPage'));
const towerPage: Page = lazy(() => import('../tower/TowerPage'));
const testingPage: Page = lazy(() => import('../testing/TestingPage'));
const docsPage: Page = lazy(() => import('../docs/DocsPage'));
const syncPage: Page = lazy(() => import('../sync/SyncPage'));

/** Phần giao diện của từng phân hệ. Khoá = code trong contracts/apps.json. */
export const MODULE_UI: Record<AppCode, UIPart> = {
  'cqs.tower': {
    path: '/dieu-phoi',
    icon: Radar,
    short: 'Điều phối',
    summary: 'Máy cục bộ, task, điều phối, dừng tất cả, chạy lại lượt lỗi, ngân sách LLM; điều khiển bằng chat và ⌘K.',
    mobile: true,
    pages: [p('', 'Điều phối', Radar, towerPage), p('mcp', 'Kết nối AI (MCP)', Plug, mcpPage)],
  },
  'cqs.test': {
    path: '/kiem-thu',
    icon: FlaskConical,
    short: 'Kiểm thử',
    summary: 'Flow biên dịch một lần thành Maestro YAML, chạy song song trên nhiều máy, đo p50/p95, đạt/lỗi, tự sửa bước lỗi.',
    mobile: true,
    pages: [p('', 'Kiểm thử', FlaskConical, testingPage), p('tai-lieu', 'Tài liệu', FileText, docsPage), p('dong-bo', 'Đồng bộ', RefreshCw, syncPage)],
  },
  'cqs.monitor': {
    path: '/giam-sat',
    icon: Activity,
    short: 'Giám sát',
    summary: 'Trigger và lịch chạy, cảnh báo, webhook, báo cáo gửi khách.',
    mobile: true,
    pages: [p('', 'Giám sát', Activity, monitorPage)],
  },
};

/** Mọi phân hệ trong danh mục (kể cả planned). */
export const ALL_MODULES: ModuleDef[] = PRODUCT_APPS.map((a) => ({
  ...(a as Omit<ModuleDef, keyof UIPart>),
  ...MODULE_UI[a.code as AppCode],
}));

/**
 * Phân hệ có route. ChatQASoftware mở cả app đang "planned" (trang giữ chỗ) để kiểm tra bản quyền, đăng nhập, OTA trước khi có nghiệp vụ;
 * ModuleRoute vẫn chặn theo bản quyền máy và quyền người dùng, Go chặn lần nữa.
 */
export const MODULES = ALL_MODULES;

export const GROUP_LABEL: Record<ModuleGroup, string> = { flow: 'Quy trình', knowledge: 'Tri thức' };

/** Đường dẫn đầy đủ của 1 trang con. */
export const pagePath = (m: ModuleDef, pg: ModulePage) => (pg.path ? `${m.path}/${pg.path}` : m.path);

/** App chứa đường dẫn hiện tại (undefined ở trang chung). */
export const moduleOfPath = (pathname: string) => MODULES.find((m) => pathname === m.path || pathname.startsWith(`${m.path}/`));

/** "App 01" - cách đánh số dùng chung với HS Desk. */
export const appNo = (m: Pick<ModuleDef, 'no'>) => `App ${String(m.no).padStart(2, '0')}`;

export function moduleByCode(code: AppCode): ModuleDef {
  const m = ALL_MODULES.find((x) => x.code === code);
  if (!m) throw new Error(`Không có phân hệ ${code}`);
  return m;
}
