// Vai: nguồn duy nhất contracts/roles.json (cùng file Worker và Go khớp). Role là string vì TS không suy union chữ từ JSON.
import roleCatalog from '@contracts/roles.json';
import { PRODUCT } from '@product/product';

export type Role = (typeof roleCatalog.roles)[number]['code'];
export const ROLES = roleCatalog.roles;
const LEGACY = roleCatalog.legacy as Record<string, string>;
/** Vai khai `products` (contracts/roles.json) chỉ dùng được ở các sản phẩm đó; không khai = mọi sản phẩm. */
const ROLE_PRODUCTS = new Map(roleCatalog.roles.map((r) => [r.code, (r as { products?: readonly string[] }).products]));

/** Phiên lưu từ bản trước còn vai 'owner' (= admin). */
export const normalizeRole = (r: string | undefined | null): string => (r ? (LEGACY[r] ?? r) : '');
export const isAdmin = (r: string | undefined | null) => normalizeRole(r) === 'admin';
export const roleLabel = (r: string | undefined | null) => ROLES.find((x) => x.code === normalizeRole(r))?.label ?? '';
export const roleChip = (r: string | undefined | null) => ROLES.find((x) => x.code === normalizeRole(r))?.chip;
/** Vai có đăng nhập/dùng được sản phẩm này không: khai `products` thì chỉ đúng sản phẩm đó (Vipo = HS Desk). */
export const roleServedByProduct = (role: string, product: string = PRODUCT.code): boolean => {
  const p = ROLE_PRODUCTS.get(normalizeRole(role));
  return !p || p.includes(product);
};

/** Vai dùng được ở sản phẩm của app đang chạy (ChatQASoftware ẩn Vipo của HS Desk). */
export const rolesForProduct = (product: string = PRODUCT.code) => ROLES.filter((r) => roleServedByProduct(r.code, product));
