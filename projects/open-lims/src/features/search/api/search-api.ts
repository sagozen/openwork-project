import type { ApiClient } from "@/lib/api";
import type { SearchResponse } from "../types";

export const searchApi = {
  query: (api: ApiClient, q: string, limitPerGroup = 5) =>
    api.get<SearchResponse>(`/search?q=${encodeURIComponent(q)}&limitPerGroup=${limitPerGroup}`),
};
