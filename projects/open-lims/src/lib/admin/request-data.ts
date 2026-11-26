/* S-02 · Tạo yêu cầu thử nghiệm (số hoá BM01 Rev 00).
   Dữ liệu trích trực tiếp từ mockup design-handoff/DLP LIMS.dc.html. */

export interface ReqField {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
  placeholder: string;
}

/* Khách hàng dựng sẵn cho bản minh hoạ - bản thật tìm qua `GET /customers?query=`. */
export interface ReqCustomer {
  id: string;
  name: string;
  taxCode?: string;
  address?: string;
  representative?: string;
  phone?: string;
  email?: string;
}

export const REQ_CUSTOMERS: ReqCustomer[] = [
  {
    id: "KH-0142",
    name: "Cty TNHH XNK Nông sản An Phát",
    taxCode: "0312445671",
    address: "12 Nguyễn Văn Cừ, Q.5, TP.HCM",
    representative: "Ngô Thị Kim Chi",
    phone: "0918 442 117",
    email: "an.nguyen@example.com",
  },
  {
    id: "KH-0208",
    name: "Cty CP Nông sản Bình Minh",
    taxCode: "0311998220",
    address: "KCN Tân Bình, TP.HCM",
    representative: "Trần Quốc Bảo",
    phone: "0903 118 240",
    email: "bao.tran@binhminh.vn",
  },
  {
    id: "KH-0317",
    name: "Cty TNHH Thực phẩm Tân Việt",
    taxCode: "0316774102",
    address: "Lô B7, KCN Long Hậu, Long An",
    representative: "Lý Thu Hà",
    phone: "0977 205 663",
  },
];

export const REQ_FIELDS: ReqField[] = [
  {
    key: "lienhe",
    label: "Người đại diện",
    required: true,
    hint: "Để trống thì lấy theo người đại diện của khách hàng",
    placeholder: "Ngô Thị Kim Chi",
  },
  { key: "phone", label: "Điện thoại", required: true, placeholder: "0918442117" },
  { key: "sp", label: "Tên sản phẩm / mẫu", required: true, placeholder: "Sầu riêng" },
  { key: "vungtrong", label: "Mã số vùng trồng", placeholder: "VN-DL-0417" },
  { key: "csdg", label: "Mã cơ sở đóng gói", placeholder: "VN-PH-0092" },
  { key: "container", label: "Số container", placeholder: "ABCD1234567" },
  { key: "bienso", label: "Biển số xe", placeholder: "51C-543.21" },
  { key: "romooc", label: "Số rơ-moóc", hint: "Tuỳ chọn", placeholder: "51R-001.02" },
  { key: "seal", label: "Số seal", placeholder: "SL-889" },
  {
    key: "diadiem",
    label: "Địa điểm lấy mẫu",
    hint: "Chưa có thì để trống - điền khi phân công lấy mẫu",
    placeholder: "Kho X, KCN Quang Minh",
  },
  {
    key: "soluong",
    label: "Số lượng mẫu dự kiến",
    hint: "Trường hệ thống bổ sung",
    placeholder: "5 quả",
  },
];

export const REQ_PARAMS = ["Vàng O (Auramine O)", "Cadimi (Cd)", "Kim loại nặng"];

export const REQ_DELIVERY = ["Tại PTN", "Email", "Bưu điện"];

/* Mã hồ sơ minh hoạ theo dãy DLP toàn hệ do hệ thống sinh - BR-003. */
export const REQ_NEXT_CODE = "DLP000015";
