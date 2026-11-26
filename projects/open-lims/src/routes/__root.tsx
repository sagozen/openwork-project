import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Spinner } from "@fluentui/react-components";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { DlpThemeProvider } from "../components/lims/DlpThemeProvider";
import { AuthProvider } from "../lib/auth/AuthProvider";
import { SupportStoreProvider } from "../lib/support/support-store";

export function ScreenTransition({ label = "Đang chuyển màn hình…" }: { label?: string }) {
  return (
    <div
      className="dlp-screen-transition"
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: "100dvh",
        width: "100%",
        backgroundColor: "var(--color-background)",
        color: "var(--color-foreground)",
      }}
    >
      <Spinner size="medium" label={label} />
    </div>
  );
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Không tìm thấy trang</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Trang này không tồn tại hoặc đã được chuyển đi nơi khác.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Về trang chủ
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Trang này không tải được
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Lỗi nằm ở phía hệ thống. Anh/chị thử tải lại, hoặc quay về trang chủ.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Thử lại
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Về trang chủ
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "DLP LIMS - Đa Liên Phát" },
      {
        name: "description",
        content: "Hệ thống quản lý phòng thí nghiệm Đa Liên Phát (LIMS).",
      },
      { name: "author", content: "Công ty TNHH Đa Liên Phát" },
      { property: "og:title", content: "DLP LIMS - Đa Liên Phát" },
      {
        property: "og:description",
        content: "Hệ thống quản lý phòng thí nghiệm Đa Liên Phát (LIMS).",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
    ],
  }),

  shellComponent: RootShell,
  component: RootComponent,
  pendingComponent: ScreenTransition,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var r=localStorage.getItem("dlp.user-prefs");var p=r?JSON.parse(r):null;var t=p&&p.theme==="dark"?"dark":"light";document.documentElement.setAttribute("data-theme",t);if(t==="dark"){document.documentElement.classList.add("dark")}else{document.documentElement.classList.remove("dark")}}catch(e){}})()`,
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <DlpThemeProvider>
        <AuthProvider>
          <SupportStoreProvider>
            {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
            <Outlet />
          </SupportStoreProvider>
        </AuthProvider>
      </DlpThemeProvider>
    </QueryClientProvider>
  );
}
