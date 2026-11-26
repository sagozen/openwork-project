import { QueryClient } from "@tanstack/react-query";
import { createRouter, parseSearchWith, stringifySearchWith } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { ScreenTransition } from "./routes/__root";

/* Mặc định TanStack Router bọc mọi giá trị query qua JSON, nên `?code=26100016` in ra thành
   `?code=%2226100016%22` - link chia sẻ trông sai và vỡ nếu ai đó parse lại. Mọi search param của
   ứng dụng đều là chuỗi đơn (`code`, `draftId`, `redirect`), nên giữ chuỗi nguyên và chỉ JSON-hoá
   các kiểu còn lại. Chiều đọc vẫn thử JSON trước để URL cũ (đã bọc nháy) không gãy. */
const encodeSearchValue = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

const decodeSearchValue = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: ScreenTransition,
    stringifySearch: stringifySearchWith(encodeSearchValue),
    parseSearch: parseSearchWith(decodeSearchValue),
  });

  return router;
};
