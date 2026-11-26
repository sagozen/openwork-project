import type { ApiClient, TokenProvider } from "@/lib/api";
import { createApiClient } from "@/lib/api";
import type { CreateHandoverInput, Handover, HandoverLogEntry } from "../types/request";

export interface HandoverClient {
  create(input: CreateHandoverInput): Promise<Handover>;
  list(requestCode: string): Promise<HandoverLogEntry[]>;
}
export function createHandoverClient(tokenProvider: TokenProvider): HandoverClient {
  return createHandoverClientWithApi(createApiClient(tokenProvider));
}
export function createHandoverClientWithApi(api: ApiClient): HandoverClient {
  return {
    create: (input) => api.post<Handover>("/handovers", input),
    // Nhật ký nằm dưới hồ sơ chứ không phải dưới /handovers: một lượt bàn giao chỉ có nghĩa trong
    // ngữ cảnh hồ sơ của nó. `GET /handovers` trần vẫn trả 405 - đó là câu trả lời đúng cho một
    // collection API này không xuất bản.
    list: (requestCode) =>
      api
        .get<{ data: HandoverLogEntry[] }>(
          `/test-requests/${encodeURIComponent(requestCode)}/handovers`,
        )
        .then((response) => response.data),
  };
}
