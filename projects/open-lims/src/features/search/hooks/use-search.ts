import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useDebounced } from "@/lib/use-debounced";
import { searchApi } from "../api";

/** Máy chủ bỏ qua truy vấn ngắn hơn 2 ký tự, nên client cũng không hỏi. */
const MIN_QUERY = 2;

export function useGlobalSearch(query: string, enabled = true) {
  const api = useApiClient();
  const { usesClerk } = useAuth();
  const debounced = useDebounced(query).trim();
  return useQuery({
    queryKey: ["search", debounced],
    queryFn: () => searchApi.query(api, debounced),
    enabled: enabled && usesClerk && debounced.length >= MIN_QUERY,
    // Gõ lại đúng thứ vừa tìm là chuyện thường; giữ kết quả một lúc để không gọi lại.
    staleTime: 30_000,
  });
}
