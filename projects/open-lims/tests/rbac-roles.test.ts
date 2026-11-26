import { describe, expect, test } from "bun:test";
import {
  PERM,
  PERSONAS,
  ROLE_IDS,
  ROLE_PERMISSIONS,
  type Permission,
  type RoleId,
} from "../src/lib/admin/rbac";
import { MOCK_ROLES } from "../src/lib/admin/mock-data";
import { PERM_GROUPS, isPermLocked } from "../src/lib/admin/roles-data";

const ALL_PERM_CODES = Object.values(PERM) as Permission[];
const MATRIX_ITEMS = PERM_GROUPS.flatMap((group) => group.items);

describe("nguồn duy nhất cho tập quyền vai trò", () => {
  test("persona đăng nhập và danh mục vai trò quản trị cấp cùng một tập quyền", () => {
    for (const persona of PERSONAS) {
      const role = MOCK_ROLES.find((item) => item.id === persona.id);
      expect(role?.perms).toEqual(persona.perms);
    }
  });

  test("ma trận A-01d đánh dấu đúng những vai trò đang giữ mã quyền", () => {
    for (const item of MATRIX_ITEMS) {
      const holders = ROLE_IDS.filter((id) => ROLE_PERMISSIONS[id].includes(item.key));
      expect(item.def).toEqual(holders);
    }
  });

  test("mọi mã quyền vai trò đang giữ đều là mã thật trong PERM", () => {
    for (const id of ROLE_IDS) {
      for (const perm of ROLE_PERMISSIONS[id]) expect(ALL_PERM_CODES).toContain(perm);
    }
  });
});

describe("danh mục quyền hiển thị", () => {
  test("quyền bị khoá với một vai trò thì không được cấp mặc định cho vai trò đó", () => {
    for (const item of MATRIX_ITEMS) {
      for (const id of ROLE_IDS) {
        if (isPermLocked(item, id)) expect(item.def).not.toContain(id);
      }
    }
  });
});

/** Ranh giới nghiệp vụ đã chốt - đổi được nhưng phải đổi có chủ đích, không trôi theo mockup. */
describe("ranh giới vai trò", () => {
  const permsOf = (id: RoleId) => ROLE_PERMISSIONS[id];

  test("lãnh đạo theo dõi lab ở chế độ chỉ đọc, không nhập được kết quả", () => {
    expect(permsOf("lanhdao")).toContain(PERM.LAB_READ);
    expect(permsOf("lanhdao")).not.toContain(PERM.LAB_TASK_WORK);
    expect(permsOf("lanhdao")).not.toContain(PERM.LAB_TASK_CLAIM);
    expect(permsOf("lanhdao")).not.toContain(PERM.LAB_TASK_ASSIGN);
  });

  test("lãnh đạo không giữ quyền chết và không vào khu quản trị", () => {
    // `sampling.read` một mình không mở được S-05 (màn đòi cả `sampling.work`).
    expect(permsOf("lanhdao")).not.toContain(PERM.SAMPLING_READ);
    expect(permsOf("lanhdao")).not.toContain(PERM.USER_READ);
    expect(permsOf("lanhdao")).not.toContain(PERM.USER_MANAGE);
  });

  test("chỉ quản trị hệ thống vào được khu quản trị", () => {
    const adminArea = ROLE_IDS.filter(
      (id) => permsOf(id).includes(PERM.USER_READ) || permsOf(id).includes(PERM.USER_MANAGE),
    );
    expect(adminArea).toEqual(["admin"]);
  });

  test("quản trị hệ thống không chạm dữ liệu nghiệp vụ", () => {
    // `config.manage` là quyền cấu hình hệ thống, không phải dữ liệu nghiệp vụ - đúng vai của
    // quản trị hệ thống, khác với hồ sơ / mẫu / kết quả mà vai trò này vẫn không mở được.
    expect(permsOf("admin")).toEqual([
      PERM.USER_READ,
      PERM.USER_MANAGE,
      PERM.AUDIT_READ,
      PERM.CONFIG_MANAGE,
    ]);
  });

  test("quản lý một cửa là nhân viên một cửa cộng thêm quyền duyệt", () => {
    for (const perm of permsOf("motcua")) expect(permsOf("qlmotcua")).toContain(perm);
    for (const perm of [
      PERM.REQUEST_CANCEL,
      PERM.PAYMENT_EXCEPTION,
      PERM.SAMPLING_ASSIGN,
      PERM.SAMPLING_CHANGE_APPROVE,
    ]) {
      expect(permsOf("qlmotcua")).toContain(perm);
      expect(permsOf("motcua")).not.toContain(perm);
    }
  });

  test("một cửa thấy trạng thái task nhưng không thấy trị số kết quả (D28/BR-027)", () => {
    // Hai mã tách nhau chính vì tab «Mẫu & kết quả» của S-03 (URD 8.1 tab 4) phải trả lời được
    // "hồ sơ đang ở bước nào" cho một cửa, mà không hé trị số trước khi phiếu phát hành. Thiếu
    // `lab.read` thì cả tab đóng lại; thừa `lab.result.value.view` thì D28 vỡ.
    for (const id of ["motcua", "qlmotcua"] as RoleId[]) {
      expect(permsOf(id)).toContain(PERM.LAB_READ);
      expect(permsOf(id)).not.toContain(PERM.LAB_RESULT_VALUE_VIEW);
      expect(permsOf(id)).not.toContain(PERM.LAB_TASK_WORK);
    }
  });

  test("vai trò phòng thử nghiệm không thấy thông tin khách hàng (BR-012/D07)", () => {
    for (const id of ["lab", "truongnhom"] as RoleId[]) {
      expect(permsOf(id)).not.toContain(PERM.REQUEST_CUSTOMER_VIEW);
      expect(permsOf(id)).not.toContain(PERM.REVIEW_CUSTOMER_VIEW);
    }
  });
});
