import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
import { hintText, subLabel } from "../request-styles";
import { CustomerAvatar } from "./CustomerAvatar";
import type { CustomerRecord } from "./types";

const ROWS = [
  ["taxCode", "Mã số thuế"],
  ["representative", "Người đại diện"],
  ["phone", "Điện thoại"],
  ["email", "Email"],
  ["address", "Địa chỉ"],
] as const;

/** Xem nhanh hồ sơ khách hàng ngay trong màn tạo yêu cầu - đối chiếu đúng công ty rồi đóng lại,
 *  không phải rời trang. Trường trống hiển thị gạch ngang khi hồ sơ khách hàng chưa có dữ liệu
 *  tương ứng. */
export function CustomerDetailDialog({
  customer,
  open,
  onOpenChange,
}: {
  customer: CustomerRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 520 }}>
        <DialogBody>
          <DialogTitle>Thông tin khách hàng</DialogTitle>
          <DialogContent>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <CustomerAvatar customer={customer} size={48} />
                <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                  <span style={{ font: "600 16px/22px var(--font-family-base)" }}>
                    {customer.name}
                  </span>
                  <span style={{ justifySelf: "start" }}>
                    <Badge appearance="outline" color="informative">
                      Mã khách hàng {customer.id}
                    </Badge>
                  </span>
                </div>
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                {ROWS.map(([key, label]) => (
                  <div key={key} style={{ display: "grid", gap: 2 }}>
                    <span style={{ ...subLabel, marginBottom: 0 }}>{label}</span>
                    <span style={{ font: "14px/20px var(--font-family-base)" }}>
                      {customer[key] || "—"}
                    </span>
                  </div>
                ))}
              </div>
              <span style={hintText}>
                Thông tin lấy từ hồ sơ khách hàng. Cần sửa thì cập nhật ở danh mục khách hàng.
              </span>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={() => onOpenChange(false)}>
              Đóng
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
