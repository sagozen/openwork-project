import type { ApiClient } from "@/lib/api";
import type { SavedView, SavedViewListResponse, SaveViewInput } from "../types";

export const viewApi = {
  list: (api: ApiClient) => api.get<SavedViewListResponse>("/me/views"),
  create: (api: ApiClient, input: SaveViewInput) => api.post<SavedView>("/me/views", input),
  update: (api: ApiClient, id: string, input: SaveViewInput) =>
    api.patch<SavedView>(`/me/views/${encodeURIComponent(id)}`, input),
  // 204: máy chủ trả về rỗng, http-client quy thành `undefined`.
  remove: (api: ApiClient, id: string) => api.del<void>(`/me/views/${encodeURIComponent(id)}`),
};
