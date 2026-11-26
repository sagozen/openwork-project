/* Tìm kiếm toàn cục (`GET /api/v1/search`).

   Máy chủ đã lọc theo phạm vi chi nhánh của người gọi, và BỎ HẲN nhóm khách hàng khi người gọi
   không có `request.customer.view` - một dòng bị che vẫn xác nhận rằng có khách hàng trùng với
   thứ vừa gõ, nên che là chưa đủ. */

export type SearchGroupKey = "hoso" | "mau" | "kh" | "phieu";

export interface SearchHit {
  group: SearchGroupKey;
  title: string;
  subtitle?: string;
  status?: string;
  /** Mã hoặc id nội bộ, tuỳ màn đích khoá theo cái nào. */
  targetId: string;
}

export interface SearchResponse {
  hits: SearchHit[];
}
