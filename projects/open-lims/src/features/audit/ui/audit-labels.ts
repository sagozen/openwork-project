/* Nhãn tiếng Việt cho mã `action` và `targetType` của nhật ký audit.
 *
 * Mã ở đây LẤY NGUYÊN VĂN từ các hằng `ACTION` trong `services/main` và từ danh sách
 * `target_type` mà `PgAuditEventReader` nối về hồ sơ — đối chiếu ngày 2026-08-29. Một mã không
 * có trong bảng này **hiển thị nguyên mã**, không đoán nhãn: nhật ký audit là bằng chứng, đọc
 * sai tên một hành động còn tệ hơn đọc một chuỗi kỹ thuật. */

const ACTION_LABELS: Record<string, string> = {
  // iam
  "iam.me.read": "Xem hồ sơ cá nhân",
  "iam.me.preferences.update": "Đổi tuỳ chọn cá nhân",
  "iam.me.signature.update": "Đổi chữ ký / chức danh cá nhân",
  "iam.users.read": "Xem danh sách người dùng",
  "iam.user.read": "Xem hồ sơ người dùng",
  "iam.user.signature.read": "Xem ảnh chữ ký người dùng",
  "iam.user.assigned-work.read": "Xem việc đang giao của người dùng",
  "iam.user.invitation.create": "Mời người dùng",
  "iam.user.invitation.resend": "Gửi lại lời mời",
  "iam.user.invitation.refused": "Từ chối lời mời (tổ hợp quyền bị cấm)",
  "iam.user.invitation.unsent": "Lời mời đã tạo nhưng chưa gửi được email",
  "iam.user.invitation.resend.unsent": "Gửi lại lời mời nhưng email chưa đi",
  "iam.user.invitation.unrecorded": "Lời mời không ghi nhận được",
  "iam.user.activated": "Kích hoạt tài khoản (hoàn tất lời mời)",
  "iam.user.deactivate": "Vô hiệu hoá người dùng",
  "iam.user.reactivate": "Mở khoá người dùng",
  "iam.user.reactivate.refused": "Từ chối mở khoá người dùng",
  "iam.user.role-assignments.replace": "Đổi phân công vai trò × chi nhánh",
  "iam.user.role-assignments.refused": "Từ chối đổi phân công vai trò",
  "iam.role.permissions.replace": "Thay tập quyền của vai trò",
  "iam.role.permissions.refused": "Từ chối sửa quyền vai trò",

  // request
  "request.testRequest.create": "Tạo hồ sơ",
  "request.testRequest.patchGroupA": "Sửa thông tin nhóm A",
  "request.testRequest.cancel": "Huỷ hồ sơ",
  "request.testRequest.history.read": "Xem lịch sử hồ sơ",
  "request.customer.create": "Tạo khách hàng",
  "request.payment.confirm": "Xác nhận thanh toán",
  "request.payment.exception.grant": "Cấp ngoại lệ thanh toán",
  "request.document.upload": "Tải tài liệu lên",
  "request.document.download": "Tải tài liệu về",

  // sampling
  "sampling.assignment.assign": "Phân công lấy mẫu",
  "sampling.assignment.open": "Mở lượt lấy mẫu hiện trường",
  "sampling.assignment.reject_sampling": "Từ chối lấy mẫu",
  "sampling.reconciliation.submit": "Gửi kết quả đối soát",
  "sampling.bm02.create": "Ký biên bản BM02",
  "sampling.bm03.create": "Chốt phiếu BM03",
  "sampling.change_request.raise": "Tạo yêu cầu thay đổi hiện trường",
  "sampling.change_request.approve": "Duyệt yêu cầu thay đổi hiện trường",
  "sampling.change_request.reject": "Từ chối yêu cầu thay đổi hiện trường",

  // reception
  "reception.sample.decide": "Quyết định tiếp nhận mẫu",
  "reception.sample.split": "Chia mẫu con",
  "reception.handover.create": "Ghi nhận bàn giao mẫu",
  "reception.labelPrintJob.create": "In tem",
  "reception.labelPrintJob.retry": "In lại tem",

  // lab
  "lab.task.claim": "Tự nhận task phân tích",
  "lab.task.assign": "Phân công task phân tích",
  "lab.task.start": "Bắt đầu task phân tích",
  "lab.task.submitReview": "Gửi task đi kiểm tra",
  "lab.result.enter": "Nhập kết quả gốc",
  "lab.result.chooseFinal": "Chọn kết quả cuối",
  "lab.technicalFile.attach": "Đính kèm file kỹ thuật",

  // review
  "review.technicalFile.download": "Tải file kỹ thuật khi kiểm tra",
  "review.task.accept": "Chấp nhận task khi kiểm tra kỹ thuật",
  "review.task.return": "Trả lại task cho lab",
  "review.item.quickConfirm": "Xác nhận nhanh khi kiểm tra",
  "review.request.approve": "Phê duyệt hồ sơ",
  "review.request.reject": "Trả lại hồ sơ",
  "review.resultVersion.history.view": "Xem lịch sử phiên bản kết quả",

  // report
  "report.build": "Dựng phiên bản phiếu",
  "report.signedScan.attach": "Đính kèm bản scan đã ký",
  "report.release": "Phát hành phiếu",
  "report.replace": "Thay thế phiếu đã phát hành",
  "report.draftDelivery.send": "Gửi bản nháp phiếu",

  // platform · portal
  "platform.audit.search": "Tra cứu nhật ký audit",
  "portal.probe.sequential-codes": "Cổng tra cứu: dò mã liên tiếp",
  "portal.probe.code-fanout": "Cổng tra cứu: dò nhiều mã khác nhau",
  "portal.probe.not-found-spike": "Cổng tra cứu: dồn dập tra mã không tồn tại",
};

const TARGET_LABELS: Record<string, string> = {
  test_request: "Hồ sơ",
  test_request_history: "Lịch sử hồ sơ",
  sample: "Mẫu",
  analysis_task: "Task phân tích",
  raw_result: "Kết quả gốc",
  final_result: "Kết quả cuối",
  technical_file: "File kỹ thuật",
  label_print_job: "Tem in",
  sampling_assignment: "Lượt lấy mẫu",
  sampling_change_request: "Yêu cầu thay đổi hiện trường",
  report: "Phiếu kết quả",
  report_delivery: "Lượt gửi phiếu",
  document: "Tài liệu đính kèm",
  app_user: "Người dùng",
  role: "Vai trò",
};

/** Nhãn hành động, hoặc chính mã khi chưa có nhãn. */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** Nhãn loại đối tượng, hoặc chính mã khi chưa có nhãn. */
export function targetLabel(targetType: string): string {
  return TARGET_LABELS[targetType] ?? targetType;
}

/** Mã hành động đã có nhãn, dùng dựng danh sách gợi ý cho ô lọc của màn A-09. */
export const KNOWN_ACTIONS: { code: string; label: string }[] = Object.entries(ACTION_LABELS)
  .map(([code, label]) => ({ code, label }))
  .sort((a, b) => a.code.localeCompare(b.code));

/** Loại đối tượng đã có nhãn, dùng cho ô lọc của màn A-09. */
export const KNOWN_TARGET_TYPES: { code: string; label: string }[] = Object.entries(TARGET_LABELS)
  .map(([code, label]) => ({ code, label }))
  .sort((a, b) => a.code.localeCompare(b.code));
