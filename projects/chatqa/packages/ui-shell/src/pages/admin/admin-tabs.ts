// Tab quản trị dùng chung có mặt ở sản phẩm nào. HS Desk giữ nguyên mọi tab; ChatQASoftware ẩn phần chỉ thuộc HS Desk.
import { PRODUCT } from '@product/product';
import type { TabKey } from './admin-context';

/** Tab chỉ dành cho các sản phẩm liệt kê; tab không khai = mọi sản phẩm. */
const ONLY_IN: Partial<Record<TabKey, readonly string[]>> = {
  // Thao tác ghi offline trên Drive (mất mạng, bị hạ vai/khoá khi offline): chỉ HS Desk sinh ra.
  pending: ['hsdesk'],
  // Kết nối Drive của công ty: chỉ HS Desk đồng bộ lên Drive; ChatQASoftware chạy cục bộ, báo cáo nằm trên máy.
  drive: ['hsdesk'],
};

export const adminTabOn = (key: TabKey, product: string = PRODUCT.code) => {
  const only = ONLY_IN[key];
  return !only || only.includes(product);
};
