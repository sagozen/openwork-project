/* Cấu hình quản trị (`/api/v1/configuration`): chi nhánh, danh mục dùng chung, tham số hệ thống.
   ĐỌC chỉ cần đăng nhập (màn nghiệp vụ lấy danh mục để đổ vào bộ chọn); GHI cần `config.manage`. */

export interface ConfigBranch {
  id: string;
  code: string;
  name: string;
  address?: string;
  phone?: string;
  isTest: boolean;
  active: boolean;
  userCount: number;
}

export type CatalogGroup = "chi-tieu" | "phuong-phap" | "don-vi" | "loai-mau";

export interface ConfigCatalogItem {
  id: string;
  group: CatalogGroup;
  code: string;
  name: string;
  unit?: string;
  active: boolean;
  configurationVersion?: number;
  resultConfiguration?: {
    valueType: import("@/features/sample/sample-api").ValueType;
    allowedValueTypes?: import("@/features/sample/sample-api").ValueType[];
    choices: string[];
    allowedUnits: string[];
    method: string;
    testParts: string[];
    accredited: boolean;
    accreditationConfirmed: boolean;
  };
}

export interface ConfigSystemParameter {
  id: string;
  key: string;
  label: string;
  value?: string;
  valueType: "text" | "number" | "boolean";
  group: string;
  hint?: string;
  updatedAt?: string;
}

export interface BranchListResponse {
  branches: ConfigBranch[];
}
export interface CatalogListResponse {
  items: ConfigCatalogItem[];
}
export interface ParameterListResponse {
  parameters: ConfigSystemParameter[];
}
