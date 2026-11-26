import type { ReactNode } from "react";
import { MessageBar, MessageBarBody, MessageBarTitle } from "@fluentui/react-components";
import { ApiError, apiErrorMessage } from "@/lib/api";

// Danh mục chỉ tiêu và hình thức nhận kết quả dùng chung cho màn tạo và màn sửa hồ sơ, để hai
// màn không lệch nhau. Chưa có `GET /parameters` (audit 260814, M2) nên mã vẫn nằm trong FE; khi
// API có danh mục thật thì đây là chỗ duy nhất phải đổi.
export const PARAMETERS = [
  { code: "VO", name: "Vàng O (Auramine O)" },
  { code: "CD", name: "Cadimi (Cd)" },
  { code: "HM", name: "Kim loại nặng" },
] as const;
export const DELIVERY_MODES = [
  { code: "AT_LAB", name: "Tại PTN" },
  { code: "EMAIL", name: "Email" },
  { code: "POST", name: "Bưu điện" },
] as const;

// API field key → nhãn tiếng Việt hiển thị cho người dùng, khớp với label của ô nhập tương ứng
// trên màn tạo/sửa hồ sơ để lỗi server itemized có thể đối chiếu ngay ra ô cần sửa. Từ
// CR-20260831-001, các trường truy xuất BR-021 và chỉ tiêu thuộc CẤP MẪU (`samples[].x`) - nhãn
// giữ nguyên tên bare (không prefix `samples[].`) vì `groupFieldLabel` (remote-edit-request-page)
// đã tự cắt tiền tố trước khi tra bảng này.
export const FIELD_LABELS: Record<string, string> = {
  customerId: "Khách hàng",
  name: "Tên khách hàng",
  taxCode: "Mã số thuế",
  address: "Địa chỉ",
  representative: "Người đại diện",
  phone: "Điện thoại",
  email: "Email",
  product: "Tên mẫu",
  customerSampleCode: "Mã mẫu tham chiếu",
  growingAreaCode: "Mã vùng trồng",
  packingHouseCode: "Mã cơ sở đóng gói",
  containerNumber: "Số container",
  vehiclePlate: "Biển số",
  trailerNumber: "Số rơ-moóc",
  sealNumber: "Số seal",
  samplingLocation: "Địa điểm lấy mẫu",
  parameterCodes: "Chỉ tiêu",
  parameters: "Chỉ tiêu",
  samples: "Danh sách mẫu",
  resultDeliveryModes: "Hình thức nhận kết quả",
  customerCommitmentAcknowledged: "Cam kết BM01",
  sourceDocumentId: "Bản BM01",
  code: "Mã lượt",
  receptionBranch: "Chi nhánh tiếp nhận",
};

export function RequestError({ error, fallback }: { error: unknown; fallback?: string }) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : null;
  return (
    <MessageBar intent="error">
      <MessageBarBody>
        <MessageBarTitle>
          {apiError ? (
            <>
              {apiError.code ? `${apiError.code}: ` : ""}
              {apiError.message}
            </>
          ) : (
            apiErrorMessage(error, fallback)
          )}
        </MessageBarTitle>
        {apiError?.fieldErrors?.map((item) => (
          <div key={`${item.field}-${item.message}`}>
            {FIELD_LABELS[item.field] ?? item.field}: {item.message}
          </div>
        ))}
        {apiError?.traceId ? <div>Mã truy vết: {apiError.traceId}</div> : null}
      </MessageBarBody>
    </MessageBar>
  );
}

export function DataGrid({ children }: { children: ReactNode }) {
  return (
    <div className="dlp-card" style={{ padding: 16, display: "grid", gap: 12 }}>
      {children}
    </div>
  );
}
