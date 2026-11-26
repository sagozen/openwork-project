import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createQueryKeys } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { createHandoverClient } from "../api";

export const handoverKeys = createQueryKeys("handovers");

export function useHandoverApi() {
  const { getToken } = useAuth();
  return useMemo(() => createHandoverClient(getToken), [getToken]);
}

/**
 * Nhật ký giao-nhận của một hồ sơ, mới nhất trước.
 *
 * Ba màn cùng ghi vào `ops.handover` (Tiếp nhận, Bàn giao, tab «Huỷ & bàn giao» của hồ sơ) nên cả
 * ba phải đọc chung một nhật ký - nếu không, mỗi màn lại là một cửa ghi mù, và không màn nào cho
 * biết lượt bàn giao vừa rồi đã được ghi hay chưa.
 */
export function useHandoverLog(requestCode: string | undefined, enabled = true) {
  const api = useHandoverApi();
  return useQuery({
    queryKey: handoverKeys.list({ requestCode }),
    queryFn: () => api.list(requestCode!),
    enabled: enabled && !!requestCode,
  });
}
