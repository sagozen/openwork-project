import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { viewApi } from "../api";
import type { SaveViewInput } from "../types";

const viewsKey = ["me", "views"] as const;

export function useSavedViews(enabled = true) {
  const api = useApiClient();
  const { usesClerk, isSignedIn } = useAuth();
  return useQuery({
    queryKey: viewsKey,
    queryFn: () => viewApi.list(api),
    enabled: enabled && usesClerk && isSignedIn,
  });
}

/** Tạo / sửa / xoá dùng chung một khoá bộ nhớ đệm, nên bất kỳ thao tác nào cũng làm mới danh
 *  sách - kể cả khi "đặt làm mặc định" gỡ cờ mặc định của một chế độ xem KHÁC. */
export function useSaveView() {
  const api = useApiClient();
  const cache = useQueryClient();
  const invalidate = () => cache.invalidateQueries({ queryKey: viewsKey });
  return {
    create: useMutation({
      mutationFn: (input: SaveViewInput) => viewApi.create(api, input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: SaveViewInput }) =>
        viewApi.update(api, id, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => viewApi.remove(api, id),
      onSuccess: invalidate,
    }),
  };
}
