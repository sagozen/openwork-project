// Danh mục app dùng chung (contracts/apps.json) có app của mọi sản phẩm; shell chỉ hiện app của sản phẩm đang chạy.
import catalog from '@contracts/apps.json';
import { PRODUCT } from '@product/product';

// App "hidden" (vd Hàng đường bộ TQ chưa chốt với khách) không hiện ở đâu trên giao diện.
export const PRODUCT_APPS = catalog.apps.filter((a) => a.product === PRODUCT.code && a.status !== 'hidden');
/** Sản phẩm đang chạy là HS Desk. So sánh qua string vì PRODUCT.code là kiểu chữ của từng app. */
export const IS_HSDESK = (PRODUCT.code as string) === 'hsdesk';
