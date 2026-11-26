/** Bản ghi khách hàng dùng chung cho ô chọn khách hàng: bản demo (dữ liệu tĩnh) và bản chạy
 *  thật (API `/customers`) cùng một hình dạng, chỉ khác nguồn nạp. Ngoài `id` và `name`, mọi
 *  trường đều tuỳ chọn vì những bản ghi cũ có thể chưa có thông tin liên hệ. */
export interface CustomerRecord {
  id: string;
  name: string;
  taxCode?: string;
  address?: string;
  representative?: string;
  phone?: string;
  email?: string;
}

/** Dữ liệu tạo khách hàng mới - trùng khung với `CreateCustomerInput` của API. */
export interface NewCustomerInput {
  name: string;
  taxCode?: string;
  address?: string;
  representative?: string;
  phone?: string;
  email?: string;
}
