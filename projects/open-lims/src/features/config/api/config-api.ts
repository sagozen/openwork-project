import type { ApiClient } from "@/lib/api";
import type {
  BranchListResponse,
  CatalogGroup,
  CatalogListResponse,
  ConfigBranch,
  ConfigCatalogItem,
  ConfigSystemParameter,
  ParameterListResponse,
} from "../types";

/** PATCH ở mọi chỗ, mọi trường tuỳ chọn: màn hình gửi ĐÚNG thứ vừa đổi (một công tắc, một tên),
 *  chứ không phải cả đối tượng - gửi cả đối tượng buộc mỗi màn phải nhớ gửi lại những trường nó
 *  chưa từng hiển thị, và cái quên đầu tiên sẽ xoá trắng một cột. */
export const configApi = {
  branches: (api: ApiClient) => api.get<BranchListResponse>("/configuration/branches"),
  patchBranch: (
    api: ApiClient,
    id: string,
    patch: Partial<Pick<ConfigBranch, "name" | "address" | "phone" | "active">>,
  ) => api.patch<ConfigBranch>(`/configuration/branches/${encodeURIComponent(id)}`, patch),

  catalogItems: (api: ApiClient, group?: CatalogGroup) =>
    api.get<CatalogListResponse>(
      `/configuration/catalog-items${group ? `?group=${encodeURIComponent(group)}` : ""}`,
    ),
  patchCatalogItem: (
    api: ApiClient,
    id: string,
    patch: Partial<Pick<ConfigCatalogItem, "name" | "unit" | "active" | "resultConfiguration">>,
  ) =>
    api.patch<ConfigCatalogItem>(`/configuration/catalog-items/${encodeURIComponent(id)}`, patch),

  systemParameters: (api: ApiClient) =>
    api.get<ParameterListResponse>("/configuration/system-parameters"),
  patchSystemParameter: (api: ApiClient, key: string, value: string) =>
    api.patch<ConfigSystemParameter>(
      `/configuration/system-parameters/${encodeURIComponent(key)}`,
      { value },
    ),
};
