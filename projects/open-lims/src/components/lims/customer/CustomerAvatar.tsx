import { Avatar } from "@fluentui/react-components";
import { Building20Regular } from "@fluentui/react-icons";
import { companyInitials } from "./company-initials";
import type { CustomerRecord } from "./types";

/** Ảnh đại diện công ty: chữ tắt trên nền màu suy ra từ mã khách hàng, nên cùng một khách luôn
 *  có cùng màu ở mọi màn hình - dấu hiệu thị giác giúp người nhập không chọn nhầm hai công ty
 *  tên gần giống nhau. */
export function CustomerAvatar({
  customer,
  size = 32,
}: {
  customer: Pick<CustomerRecord, "id" | "name">;
  size?: 20 | 24 | 28 | 32 | 40 | 48;
}) {
  return (
    <Avatar
      shape="square"
      size={size}
      color="colorful"
      idForColor={customer.id}
      name={customer.name}
      initials={companyInitials(customer.name)}
      icon={<Building20Regular />}
      aria-hidden
    />
  );
}
