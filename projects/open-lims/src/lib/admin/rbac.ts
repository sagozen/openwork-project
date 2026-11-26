/* RBAC cho khu vực quản trị.
   Quyền là chuỗi "<đối tượng>.<hành động>" - LẤY NGUYÊN VĂN từ các lớp
   `*Permissions.java` phía backend (vd. `vn.dlp.main.lab.domain.LabPermissions`),
   vì đó là chuỗi mà `@RequiresPermission` thật sự kiểm tra và cũng là chuỗi mà
   `GET /api/v1/me/capabilities` trả về trong `permissions[]`. FE không tự đặt
   thêm quyền: một chuỗi ở đây mà backend không có nghĩa là màn hình đó chưa có
   API thật (ghi vào "Cần backend bổ sung"), không phải cơ hội để chế thêm mã. */

export type Permission = string;

export interface Persona {
  id: RoleId;
  name: string;
  email: string;
  role: string;
  branch: string;
  initials: string;
  perms: Permission[];
}

/** Mã quyền thật, đối chiếu từng dòng với backend (dlp-system/services/main/.../*Permissions.java)
 *  ngày 2026-08-12. `user.*` không có mã riêng cho role/branch/catalog/param - xem ghi chú tại
 *  chỗ dùng USER_MANAGE cho các màn đó. */
export const PERM = {
  // request.domain.RequestPermissions
  REQUEST_CUSTOMER_VIEW: "request.customer.view",
  REQUEST_CREATE: "request.create",
  REQUEST_READ: "request.read",
  REQUEST_PATCH_GROUP_A: "request.patchGroupA",
  REQUEST_CANCEL: "request.cancel",
  PAYMENT_CONFIRM: "payment.confirm",
  PAYMENT_EXCEPTION: "payment.exception",

  // debt.domain.DebtPermissions - sổ công nợ khách hàng (K-01).
  CUSTOMER_MANAGE: "customer.manage",
  DEBT_VIEW: "debt.view",
  DEBT_MANAGE: "debt.manage",

  // reception.domain.ReceptionPermissions
  RECEPTION_READ: "reception.read",
  RECEPTION_ACCEPT: "reception.accept",
  RECEPTION_LABEL_PRINT_PARENT: "reception.labelPrintJob.parent.create",
  RECEPTION_LABEL_PRINT_LAB: "reception.labelPrintJob.lab.create",
  RECEPTION_HANDOVER_DELIVER: "reception.handover.deliver",
  RECEPTION_HANDOVER_LAB: "reception.handover.lab",
  RECEPTION_SPLIT: "reception.split",

  // sampling.domain.SamplingPermissions
  SAMPLING_READ: "sampling.read",
  SAMPLING_ASSIGN: "sampling.assign",
  SAMPLING_WORK: "sampling.work",
  SAMPLING_CHANGE_APPROVE: "sampling.change.approve",

  // lab.domain.LabPermissions
  LAB_READ: "lab.read",
  LAB_TASK_CLAIM: "lab.task.claim",
  LAB_TASK_ASSIGN: "lab.task.assign",
  LAB_TASK_WORK: "lab.task.work",
  LAB_RESULT_VALUE_VIEW: "lab.result.value.view",

  // review.domain.ReviewPermissions
  REVIEW_TECHNICAL: "review.technicalReview",
  REVIEW_APPROVE: "review.approve",
  REVIEW_CUSTOMER_VIEW: "review.customer.view",
  REVIEW_VERSION_HISTORY: "review.resultVersion.history.view",

  // report.domain.ReportPermissions
  REPORT_READ: "report.read",
  REPORT_PREVIEW: "report.preview",
  REPORT_BUILD: "report.build",
  REPORT_SIGN: "report.sign",
  REPORT_RELEASE: "report.release",
  REPORT_REPLACE: "report.replace",
  REPORT_DELIVER: "report.deliver",
  REPORT_SUPPLEMENTARY_DOCUMENT_ADD: "report.supplementaryDocument.add",
  REPORT_SUPPLEMENTARY_DOCUMENT_READ: "report.supplementaryDocument.read",

  // document.domain.DocumentPermissions
  DOCUMENT_DOWNLOAD: "document.download",

  // iam - UserDirectoryResource / RoleResource. Không có "role.*"/"branch.*"/"catalog.*"/
  // "param.*" nào ở backend: cấu hình vai trò/chi nhánh/danh mục/tham số đều đi qua
  // USER_MANAGE ("catalogue carries no role.manage... configuring what a role may do is
  // administration either way" - RoleResource.java). Chi nhánh/danh mục/tham số chưa có
  // route backend nào cả - xem "Cần backend bổ sung" trong báo cáo.
  USER_READ: "user.read",
  USER_MANAGE: "user.manage",

  // Tra cứu nhật ký toàn hệ (A-09). Chỉ vai trò quản trị giữ mã này; lịch sử của MỘT hồ sơ đi
  // đường riêng và gate bằng `request.read`, không cần mã này.
  AUDIT_READ: "audit.read",

  // Sửa cấu hình hệ thống: chi nhánh, danh mục dùng chung, tham số (A-06/A-07/A-08). ĐỌC các
  // danh mục này không cần mã nào - màn tạo hồ sơ và bộ lọc đều lấy từ đó, nên khoá phần đọc lại
  // sẽ làm hỏng màn nghiệp vụ để bảo vệ một danh sách tên đơn vị đo.
  CONFIG_MANAGE: "config.manage",
} as const;

/** Bảy vai trò chuẩn của hệ thống (A-01d). Cùng id ở PERSONAS, MOCK_ROLES và ma trận quyền. */
export type RoleId =
  "admin" | "lab" | "lanhdao" | "motcua" | "qlmotcua" | "hientruong" | "truongnhom";

/** Nhãn hiển thị của vai trò - dùng chung cho persona đăng nhập, danh mục vai trò ở khu quản trị
 *  và ma trận quyền A-01d, để ba màn không gọi cùng một vai trò bằng ba cái tên. */
export const ROLE_LABELS: Record<RoleId, string> = {
  admin: "Quản trị hệ thống",
  lab: "Nhân viên lab",
  lanhdao: "Lãnh đạo ký",
  motcua: "Nhân viên một cửa",
  qlmotcua: "Quản lý một cửa",
  hientruong: "Nhân viên lấy mẫu (giám định viên)",
  truongnhom: "Trưởng nhóm kỹ thuật",
};

export const ROLE_IDS: RoleId[] = [
  "admin",
  "lab",
  "lanhdao",
  "motcua",
  "qlmotcua",
  "hientruong",
  "truongnhom",
];

/**
 * NGUỒN DUY NHẤT cho tập quyền của bảy vai trò. Trước đây danh sách này được chép tay ở ba nơi
 * (PERSONAS ở đây, MOCK_ROLES ở `mock-data.ts`, ma trận A-01d ở `roles-data.ts`) và đã lệch nhau:
 * người đăng nhập bằng persona nhận một tập quyền, còn màn quản trị in ra một tập khác. Mọi nơi
 * cần tập quyền của một vai trò phải đọc từ đây, không khai báo lại.
 */
export const ROLE_PERMISSIONS: Record<RoleId, Permission[]> = {
  // FR-IAM-018 và siết thêm một bậc so với mockup: quản trị hệ thống chỉ có quyền quản trị,
  // KHÔNG chạm dữ liệu nghiệp vụ. Mockup cấp cho admin perm 'hoso' (xem danh sách và chi tiết
  // hồ sơ, ẩn trị số); chủ sản phẩm chốt bỏ hẳn - admin không mở hồ sơ kiểm nghiệm. Vì vậy
  // không có `request.read`, kéo theo không có `review.resultVersion.history.view` (perm
  // 'trace' của mockup) vì panel lưu vết chỉ nằm trong màn hồ sơ và kiểm tra kỹ thuật.
  admin: [PERM.USER_READ, PERM.USER_MANAGE, PERM.AUDIT_READ, PERM.CONFIG_MANAGE],

  // Cùng route tiếp nhận/bàn giao nhưng ở vai lab là "chia mã con" và "nhận mẫu vào lab" (D20).
  lab: [
    PERM.LAB_READ,
    PERM.LAB_TASK_CLAIM,
    PERM.LAB_TASK_WORK,
    PERM.LAB_RESULT_VALUE_VIEW,
    PERM.RECEPTION_READ,
    PERM.RECEPTION_SPLIT,
    PERM.RECEPTION_HANDOVER_LAB,
    PERM.RECEPTION_LABEL_PRINT_LAB,
  ],

  // Lãnh đạo ký: theo dõi tiến độ lab ở chế độ CHỈ ĐỌC (`lab.read` không kèm `lab.task.work` nên
  // màn nhập kết quả mở ra không có ô nhập nào) và giữ trọn vòng đời phiếu - dựng, ký, phát hành,
  // thay thế, gửi khách. KHÔNG có `sampling.read`: màn lấy mẫu hiện trường đòi cả `sampling.work`
  // nên một mình mã đó chẳng mở được gì. KHÔNG có `user.read`: khu quản trị chỉ dành cho vai trò
  // quản trị hệ thống, lãnh đạo không quản lý danh bạ người dùng.
  lanhdao: [
    PERM.REQUEST_READ,
    PERM.REQUEST_CUSTOMER_VIEW,
    PERM.DEBT_VIEW,
    PERM.CUSTOMER_MANAGE,
    PERM.LAB_READ,
    PERM.LAB_RESULT_VALUE_VIEW,
    PERM.REVIEW_APPROVE,
    PERM.REVIEW_CUSTOMER_VIEW,
    PERM.REVIEW_VERSION_HISTORY,
    PERM.REPORT_READ,
    PERM.REPORT_BUILD,
    PERM.REPORT_SIGN,
    PERM.REPORT_RELEASE,
    PERM.REPORT_REPLACE,
    PERM.REPORT_DELIVER,
  ],

  motcua: [
    PERM.REQUEST_READ,
    PERM.REQUEST_CREATE,
    PERM.REQUEST_CUSTOMER_VIEW,
    PERM.REQUEST_PATCH_GROUP_A,
    PERM.PAYMENT_CONFIRM,
    PERM.DEBT_VIEW,
    PERM.DEBT_MANAGE,
    PERM.RECEPTION_READ,
    PERM.RECEPTION_ACCEPT,
    PERM.RECEPTION_LABEL_PRINT_PARENT,
    PERM.RECEPTION_HANDOVER_DELIVER,
    PERM.SAMPLING_READ,
    // `lab.read` mở TRẠNG THÁI task (tab «Mẫu & kết quả» của S-03, URD 8.1 tab 4), KHÔNG mở trị
    // số - trị số nằm sau `lab.result.value.view`, quyền mà vai này cố ý không có (D28/BR-027).
    // Hai mã tách nhau đúng vì thế, và máy chủ là bên che trị số.
    PERM.LAB_READ,
    PERM.REPORT_READ,
    PERM.REPORT_BUILD,
    PERM.REPORT_SIGN,
    PERM.REPORT_RELEASE,
    PERM.REPORT_DELIVER,
  ],

  // Quản lý một cửa = nhân viên một cửa + phân công lấy mẫu, duyệt thay đổi hiện trường (S-06),
  // duyệt ngoại lệ thanh toán và huỷ yêu cầu.
  qlmotcua: [
    PERM.REQUEST_READ,
    PERM.REQUEST_CREATE,
    PERM.REQUEST_CUSTOMER_VIEW,
    PERM.REQUEST_PATCH_GROUP_A,
    PERM.REQUEST_CANCEL,
    PERM.PAYMENT_CONFIRM,
    PERM.PAYMENT_EXCEPTION,
    PERM.DEBT_VIEW,
    PERM.DEBT_MANAGE,
    PERM.CUSTOMER_MANAGE,
    PERM.RECEPTION_READ,
    PERM.RECEPTION_ACCEPT,
    PERM.RECEPTION_LABEL_PRINT_PARENT,
    PERM.RECEPTION_HANDOVER_DELIVER,
    PERM.SAMPLING_READ,
    PERM.SAMPLING_ASSIGN,
    PERM.SAMPLING_CHANGE_APPROVE,
    // Cùng lý do như nhân viên một cửa ở trên: trạng thái task, không phải trị số.
    PERM.LAB_READ,
    PERM.REPORT_READ,
    PERM.REPORT_BUILD,
    PERM.REPORT_SIGN,
    PERM.REPORT_RELEASE,
    PERM.REPORT_DELIVER,
  ],

  // S-05 đòi cả `sampling.read` lẫn `sampling.work` (xem `routes/lay-mau.tsx`). Có
  // `request.customer.view` vì BM02 phải lấy chữ ký đại diện khách hàng tại hiện trường.
  hientruong: [
    PERM.SAMPLING_READ,
    PERM.SAMPLING_WORK,
    PERM.REQUEST_READ,
    PERM.REQUEST_CUSTOMER_VIEW,
  ],

  // BR-012/D07: không có `request.customer.view` - vai trò phòng thử nghiệm không thấy khách hàng.
  // Không có `user.read`: danh sách người nhận task lấy từ `.../eligible-assignees` của chính
  // miền lab, không đi qua danh bạ người dùng ở khu quản trị.
  // KHÔNG có `lab.task.work`: trưởng nhóm phân công task và kiểm tra kỹ thuật, người nhập kết quả
  // là nhân viên lab. Giữ `lab.read` + `lab.result.value.view` để vẫn mở được kết quả của một task
  // từ bảng công việc ở chế độ chỉ đọc, nhưng mục menu "Kết quả" không hiện (xem `nav-access.ts`)
  // và mọi ô nhập trên S-13 đều khoá - trưởng nhóm không tự nhập rồi tự duyệt kết quả của mình.
  truongnhom: [
    PERM.LAB_READ,
    PERM.LAB_TASK_ASSIGN,
    PERM.LAB_RESULT_VALUE_VIEW,
    PERM.REVIEW_TECHNICAL,
    PERM.REVIEW_VERSION_HISTORY,
  ],
};

/** Tài khoản mẫu ở chế độ demo - danh tính, còn tập quyền lấy nguyên từ ROLE_PERMISSIONS. */
export const PERSONAS: Persona[] = [
  {
    id: "admin",
    name: "Nguyễn Quốc Toàn",
    email: "toan.nq@dalienphat.vn",
    role: ROLE_LABELS.admin,
    branch: "Toàn hệ thống",
    initials: "QT",
    perms: ROLE_PERMISSIONS.admin,
  },
  {
    id: "lab",
    name: "Phạm Văn Đức",
    email: "duc.pv@dalienphat.vn",
    role: ROLE_LABELS.lab,
    branch: "CN Bình Dương",
    initials: "VĐ",
    perms: ROLE_PERMISSIONS.lab,
  },
  {
    id: "lanhdao",
    name: "Trần Minh Khôi",
    email: "khoi.tm@dalienphat.vn",
    role: ROLE_LABELS.lanhdao,
    branch: "Toàn hệ thống",
    initials: "MK",
    perms: ROLE_PERMISSIONS.lanhdao,
  },
  {
    id: "motcua",
    name: "Phạm Bảo Ngọc",
    email: "ngoc.pb@dalienphat.vn",
    role: ROLE_LABELS.motcua,
    branch: "CN Bình Dương",
    initials: "BN",
    perms: ROLE_PERMISSIONS.motcua,
  },
  {
    id: "qlmotcua",
    name: "Trần Minh Quân",
    email: "quan.tm@dalienphat.vn",
    role: ROLE_LABELS.qlmotcua,
    branch: "CN Bình Dương",
    initials: "MQ",
    perms: ROLE_PERMISSIONS.qlmotcua,
  },
  {
    id: "hientruong",
    name: "Vũ Hoàng Nam",
    email: "nam.vh@dalienphat.vn",
    role: ROLE_LABELS.hientruong,
    branch: "CN Bình Dương",
    initials: "HN",
    perms: ROLE_PERMISSIONS.hientruong,
  },
  {
    id: "truongnhom",
    name: "Lê Thị Hồng Vân",
    email: "van.lth@dalienphat.vn",
    role: ROLE_LABELS.truongnhom,
    branch: "CN Bình Dương",
    initials: "HV",
    perms: ROLE_PERMISSIONS.truongnhom,
  },
];

/** Nhãn hiển thị cho màn hình A-01d (ma trận vai trò × quyền). Danh sách chỉ gồm mã thật. */
export const ALL_PERMISSIONS: { key: Permission; label: string }[] = [
  { key: PERM.REQUEST_READ, label: "Xem yêu cầu thử nghiệm" },
  { key: PERM.REQUEST_CREATE, label: "Tạo yêu cầu thử nghiệm" },
  { key: PERM.REQUEST_PATCH_GROUP_A, label: "Sửa thông tin nhóm A của yêu cầu" },
  { key: PERM.REQUEST_CANCEL, label: "Huỷ yêu cầu thử nghiệm" },
  { key: PERM.REQUEST_CUSTOMER_VIEW, label: "Xem thông tin khách hàng (PII)" },
  { key: PERM.PAYMENT_CONFIRM, label: "Xác nhận thanh toán" },
  { key: PERM.PAYMENT_EXCEPTION, label: "Duyệt ngoại lệ thanh toán" },

  { key: PERM.DEBT_VIEW, label: "Xem công nợ khách hàng" },
  { key: PERM.DEBT_MANAGE, label: "Phát hành hoá đơn & ghi phiếu thu" },
  { key: PERM.CUSTOMER_MANAGE, label: "Sửa, khoá và mở khoá khách hàng" },

  { key: PERM.RECEPTION_READ, label: "Xem hàng đợi tiếp nhận" },
  { key: PERM.RECEPTION_ACCEPT, label: "Checklist chấp nhận/giữ/từ chối" },
  { key: PERM.RECEPTION_SPLIT, label: "Tách mẫu con" },
  { key: PERM.RECEPTION_LABEL_PRINT_PARENT, label: "In tem mẫu gốc (một cửa)" },
  { key: PERM.RECEPTION_LABEL_PRINT_LAB, label: "In tem mẫu con (lab)" },
  { key: PERM.RECEPTION_HANDOVER_DELIVER, label: "Bàn giao chuyển đi (một cửa)" },
  { key: PERM.RECEPTION_HANDOVER_LAB, label: "Bàn giao nhận vào lab" },

  { key: PERM.SAMPLING_READ, label: "Xem phân công lấy mẫu" },
  { key: PERM.SAMPLING_ASSIGN, label: "Phân công lấy mẫu" },
  { key: PERM.SAMPLING_WORK, label: "Thực hiện lấy mẫu hiện trường" },
  { key: PERM.SAMPLING_CHANGE_APPROVE, label: "Duyệt yêu cầu thay đổi hiện trường" },

  { key: PERM.LAB_READ, label: "Xem bảng công việc lab" },
  { key: PERM.LAB_TASK_CLAIM, label: "Tự nhận task phân tích" },
  { key: PERM.LAB_TASK_ASSIGN, label: "Phân công task phân tích" },
  { key: PERM.LAB_TASK_WORK, label: "Nhập kết quả / đính kèm file kỹ thuật" },
  { key: PERM.LAB_RESULT_VALUE_VIEW, label: "Xem giá trị kết quả (thô/chốt)" },

  { key: PERM.REVIEW_TECHNICAL, label: "Kiểm tra kỹ thuật (trưởng nhóm)" },
  { key: PERM.REVIEW_APPROVE, label: "Phê duyệt & phát hành phiếu (lãnh đạo)" },
  { key: PERM.REVIEW_CUSTOMER_VIEW, label: "Xem khách hàng khi kiểm tra/duyệt" },
  { key: PERM.REVIEW_VERSION_HISTORY, label: "Xem lịch sử phiên bản kết quả" },

  { key: PERM.REPORT_READ, label: "Xem phiếu kết quả / lịch sử trả kết quả" },
  { key: PERM.REPORT_PREVIEW, label: "Xem trước bản nháp phiếu kết quả" },
  { key: PERM.REPORT_BUILD, label: "Dựng phiếu kết quả" },
  { key: PERM.REPORT_SIGN, label: "Đính kèm bản ký" },
  { key: PERM.REPORT_RELEASE, label: "Phát hành phiếu kết quả" },
  { key: PERM.REPORT_REPLACE, label: "Thay thế phiếu đã phát hành" },
  { key: PERM.REPORT_DELIVER, label: "Gửi phiếu (nháp hoặc đã phát hành)" },
  { key: PERM.REPORT_SUPPLEMENTARY_DOCUMENT_ADD, label: "Thêm tài liệu bổ sung" },
  { key: PERM.REPORT_SUPPLEMENTARY_DOCUMENT_READ, label: "Xem và tải tài liệu bổ sung" },
  { key: PERM.DOCUMENT_DOWNLOAD, label: "Tải tài liệu được phép truy cập" },

  { key: PERM.USER_READ, label: "Xem người dùng" },
  {
    key: PERM.USER_MANAGE,
    label: "Quản trị người dùng và vai trò",
  },
  {
    key: PERM.CONFIG_MANAGE,
    label: "Sửa cấu hình hệ thống, chi nhánh và danh mục dùng chung",
  },
  { key: PERM.AUDIT_READ, label: "Tra cứu nhật ký hệ thống toàn hệ" },
];

/** Trung tâm hỗ trợ (S ho-tro/*) không có route backend riêng - mở cho mọi tài khoản đã
 *  đăng nhập, không phải một permission có thể sai lệch. */
export function can(perms: Permission[], needed: Permission): boolean {
  if (perms.includes("*") || perms.includes(needed)) return true;
  if (needed.startsWith("support.")) return true;
  return false;
}

/** Vào được A-00 (trang cài đặt) nếu có bất kỳ quyền nào chạm tới khu vực quản trị. Chỉ
 *  `user.*` là quyền quản trị thật ở backend hôm nay; role/chi nhánh/danh mục/tham số dùng
 *  chung USER_MANAGE (xem ghi chú ở PERM) nên không cần liệt kê thêm domain nào khác. */
export function canViewAdminArea(perms: Permission[]): boolean {
  return can(perms, PERM.USER_READ) || can(perms, PERM.USER_MANAGE);
}
