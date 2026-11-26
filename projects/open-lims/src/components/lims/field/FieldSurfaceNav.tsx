import { CheckmarkCircle20Regular, ClipboardTaskListLtr20Regular } from "@fluentui/react-icons";

/* Thanh tab dưới của S-05 (bản nối API).
   Luôn hiện, kể cả với tài khoản chỉ đi lấy mẫu. Trước đây cả thanh chỉ dựng khi tài khoản có
   quyền duyệt thay đổi, nên người lấy mẫu - đúng nhóm dùng màn này nhiều nhất - cầm một màn
   không có điểm neo nào ở dưới: hết một lượt là mất chỗ bấm để quay về danh sách, phải với lên
   nút back trên đỉnh màn. Tab "Duyệt thay đổi" vẫn theo quyền, vì bấm vào một mặt làm việc mà
   máy chủ không cho đọc thì chỉ ra một hàng chờ rỗng gây hiểu nhầm là "không có đề nghị nào". */
export function FieldSurfaceNav({
  surface,
  canManage,
  onSurface,
}: {
  surface: "field" | "manager";
  canManage: boolean;
  onSurface: (next: "field" | "manager") => void;
}) {
  return (
    <nav className="dlp-field__tabbar" aria-label="Điều hướng lấy mẫu hiện trường">
      <button
        type="button"
        data-on={surface === "field"}
        aria-current={surface === "field"}
        onClick={() => onSurface("field")}
      >
        <ClipboardTaskListLtr20Regular />
        <span>Lượt của tôi</span>
      </button>
      {canManage ? (
        <button
          type="button"
          data-on={surface === "manager"}
          aria-current={surface === "manager"}
          onClick={() => onSurface("manager")}
        >
          <CheckmarkCircle20Regular />
          <span>Duyệt thay đổi</span>
        </button>
      ) : null}
    </nav>
  );
}
