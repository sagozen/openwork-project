import { describe, expect, test } from "bun:test";
import { PERSONAS, PERM, type Permission } from "../src/lib/admin/rbac";
import {
  canManageCustomer,
  canManageDebt,
  resolveAllowedNavLinks,
  resolveLandingRoute,
  resolveNavAccess,
} from "../src/lib/auth/nav-access";

const canWith =
  (...permissions: Permission[]) =>
  (permission: Permission) =>
    permissions.includes(permission);

describe("resolveNavAccess", () => {
  test("Quản lý mẫu chỉ mở cho lãnh đạo ký và hai vai một cửa", () => {
    const allowed = PERSONAS.filter(
      (persona) => resolveNavAccess(canWith(...persona.perms), true).sampleManagement,
    ).map((persona) => persona.id);

    expect(allowed).toEqual(["lanhdao", "motcua", "qlmotcua"]);
  });

  test("quyền đọc hồ sơ, lab hoặc tiếp nhận không tự mở Quản lý mẫu", () => {
    expect(
      resolveNavAccess(canWith(PERM.REQUEST_READ, PERM.LAB_READ, PERM.RECEPTION_READ))
        .sampleManagement,
    ).toBe(false);
  });

  test("hides S-20 for a connected user who can read but cannot edit requests", () => {
    const access = resolveNavAccess(canWith(PERM.REQUEST_READ), true);

    expect(access.request).toBe(true);
    expect(access.requestEdit).toBe(false);
  });

  test("shows S-20 for a connected user with both route permissions", () => {
    const access = resolveNavAccess(canWith(PERM.REQUEST_READ, PERM.REQUEST_PATCH_GROUP_A), true);

    expect(access.requestEdit).toBe(true);
  });

  test("keeps the read-only S-20 demo available to request readers", () => {
    const access = resolveNavAccess(canWith(PERM.REQUEST_READ), false);

    expect(access.requestEdit).toBe(true);
  });

  test("does not expose S-20 when request read permission is missing", () => {
    const access = resolveNavAccess(canWith(PERM.REQUEST_PATCH_GROUP_A), true);

    expect(access.requestEdit).toBe(false);
  });

  test("matches every other business route permission gate", () => {
    expect(resolveNavAccess(canWith(PERM.RECEPTION_READ), true).reception).toBe(true);
    expect(resolveNavAccess(canWith(PERM.RECEPTION_HANDOVER_DELIVER), true).handover).toBe(true);
    expect(resolveNavAccess(canWith(PERM.RECEPTION_HANDOVER_LAB), true).handover).toBe(true);
    expect(resolveNavAccess(canWith(PERM.LAB_READ), true).lab).toBe(true);
    expect(resolveNavAccess(canWith(PERM.REVIEW_TECHNICAL), true).technicalReview).toBe(true);
    expect(resolveNavAccess(canWith(PERM.REVIEW_APPROVE), true).approval).toBe(true);
    expect(resolveNavAccess(canWith(PERM.REPORT_READ), true).report).toBe(true);

    const samplingReadOnly = resolveNavAccess(canWith(PERM.SAMPLING_READ), true);
    const samplingWorkOnly = resolveNavAccess(canWith(PERM.SAMPLING_WORK), true);
    const samplingAllowed = resolveNavAccess(canWith(PERM.SAMPLING_READ, PERM.SAMPLING_WORK), true);
    expect(samplingReadOnly.sampling).toBe(false);
    expect(samplingWorkOnly.sampling).toBe(false);
    expect(samplingAllowed.sampling).toBe(true);
  });

  test("mục menu «Nhập kết quả» chỉ hiện cho tài khoản nhập được kết quả", () => {
    // Lãnh đạo ký giữ `lab.read` để theo dõi tiến độ nhưng không nhập được: bảng công việc hiện,
    // mục nhập kết quả thì không.
    const watcher = resolveNavAccess(canWith(PERM.LAB_READ), true);
    expect(watcher.lab).toBe(true);
    expect(watcher.labResultEntry).toBe(false);

    const analyst = resolveNavAccess(canWith(PERM.LAB_READ, PERM.LAB_TASK_WORK), true);
    expect(analyst.labResultEntry).toBe(true);

    // Không có `lab.read` thì route guard của màn cũng chặn, mục menu không được hiện.
    expect(resolveNavAccess(canWith(PERM.LAB_TASK_WORK), true).labResultEntry).toBe(false);
  });

  test("chỉ người nhập được kết quả thấy mục «Nhập kết quả»", () => {
    const allowed = PERSONAS.filter(
      (persona) => resolveNavAccess(canWith(...persona.perms), true).labResultEntry,
    ).map((persona) => persona.id);

    // Trưởng nhóm KHÔNG có mặt ở đây dù mở được S-13 ở chế độ chỉ đọc: người phân công task và
    // kiểm tra kỹ thuật không tự nhập rồi tự duyệt kết quả của mình (xem `rbac.ts`).
    expect(allowed).toEqual(["lab"]);
  });
});

describe("supplementary document navigation", () => {
  test("lab with ADD sees supplementary documents without report or approval navigation", () => {
    const lab = PERSONAS.find((persona) => persona.id === "lab");
    expect(lab).toBeDefined();

    const can = canWith(...lab!.perms, PERM.REPORT_SUPPLEMENTARY_DOCUMENT_ADD);
    const access = resolveNavAccess(can, true);
    const links = resolveAllowedNavLinks(can);

    expect(access.lab).toBe(true);
    expect(access.supplementaryDocuments).toBe(true);
    expect(access.report).toBe(false);
    expect(access.approval).toBe(false);
    expect(links).toContainEqual({
      to: "/tai-lieu-bo-sung",
      label: "Tài liệu bổ sung",
    });
    expect(links.some(({ to }) => to === "/tra-ket-qua" || to === "/phe-duyet")).toBe(false);
  });

  test("ADD alone provides the business menu, landing route and allowed link in either auth mode", () => {
    const can = canWith(PERM.REPORT_SUPPLEMENTARY_DOCUMENT_ADD);

    for (const usesClerk of [false, true]) {
      const access = resolveNavAccess(can, usesClerk);
      const { supplementaryDocuments, ...otherAccess } = access;

      expect(supplementaryDocuments).toBe(true);
      expect(Object.values(otherAccess).every((allowed) => !allowed)).toBe(true);
    }
    expect(resolveLandingRoute(can)).toBe("/tai-lieu-bo-sung");
    expect(resolveAllowedNavLinks(can)).toEqual([
      { to: "/tai-lieu-bo-sung", label: "Tài liệu bổ sung" },
      { to: "/ho-tro", label: "Hỗ trợ người dùng" },
    ]);
  });

  test("supplement READ alone opens the viewing screen without add or report access", () => {
    const can = canWith(PERM.REPORT_SUPPLEMENTARY_DOCUMENT_READ);
    const access = resolveNavAccess(can, true);

    expect(access.supplementaryDocuments).toBe(true);
    expect(access.report).toBe(false);
    expect(access.approval).toBe(false);
    expect(resolveLandingRoute(can)).toBe("/tai-lieu-bo-sung");
    expect(resolveAllowedNavLinks(can)).toEqual([
      { to: "/tai-lieu-bo-sung", label: "Tài liệu bổ sung" },
      { to: "/ho-tro", label: "Hỗ trợ người dùng" },
    ]);
  });

  test("users with neither supplement grant do not see or land on supplementary documents", () => {
    const permissionSets: Permission[][] = [
      [],
      [PERM.LAB_READ, PERM.LAB_TASK_WORK],
      [PERM.REPORT_READ],
      [PERM.REVIEW_APPROVE],
      [PERM.REPORT_READ, PERM.REVIEW_APPROVE],
    ];

    for (const permissions of permissionSets) {
      const can = canWith(...permissions);

      expect(resolveNavAccess(can, true).supplementaryDocuments).toBe(false);
      expect(resolveAllowedNavLinks(can).some(({ to }) => to === "/tai-lieu-bo-sung")).toBe(false);
      expect(resolveLandingRoute(can)).not.toBe("/tai-lieu-bo-sung");
    }
  });

  test("report READ remains sufficient only for ordinary report navigation", () => {
    const can = canWith(PERM.REPORT_READ);
    const access = resolveNavAccess(can, true);

    expect(access.report).toBe(true);
    expect(access.supplementaryDocuments).toBe(false);
    expect(resolveLandingRoute(can)).toBe("/tra-ket-qua");
    expect(resolveAllowedNavLinks(can)).toEqual([
      { to: "/tra-ket-qua", label: "Trả kết quả" },
      { to: "/ho-tro", label: "Hỗ trợ người dùng" },
    ]);
  });
});

describe("customer ledger gate", () => {
  test("đòi cả quyền xem công nợ lẫn quyền xem khách hàng", () => {
    expect(resolveNavAccess(canWith(PERM.DEBT_VIEW), true).customer).toBe(false);
    expect(resolveNavAccess(canWith(PERM.REQUEST_CUSTOMER_VIEW), true).customer).toBe(false);
    expect(
      resolveNavAccess(canWith(PERM.DEBT_VIEW, PERM.REQUEST_CUSTOMER_VIEW), true).customer,
    ).toBe(true);
  });

  test("quyền ký duyệt một mình không mở được sổ công nợ", () => {
    // Điều kiện cũ suy "ai xem được công nợ" từ "ai ký phiếu" - đúng tình cờ với bộ vai trò lúc
    // đó. Nay hỏi thẳng `debt.view`, nên người ký mà không có mã đó thì không vào.
    expect(resolveNavAccess(canWith(PERM.REVIEW_APPROVE), true).customer).toBe(false);
    expect(
      resolveNavAccess(canWith(PERM.REVIEW_APPROVE, PERM.REQUEST_CUSTOMER_VIEW), true).customer,
    ).toBe(false);
  });

  test("lãnh đạo và một cửa vào được K-01, các vai trò còn lại thì không", () => {
    const allowed = PERSONAS.filter(
      (persona) => resolveNavAccess(canWith(...persona.perms), true).customer,
    ).map((persona) => persona.id);

    // Một cửa có mặt ở đây vì họ là người thu tiền - đó là lý do điều kiện bỏ `review.approve`.
    expect(allowed).toEqual(["lanhdao", "motcua", "qlmotcua"]);
  });

  test("lãnh đạo sửa và khoá khách hàng nhưng không ghi sổ công nợ", () => {
    const leadership = PERSONAS.find((persona) => persona.id === "lanhdao");
    expect(leadership).toBeDefined();

    const canLeadership = canWith(...leadership!.perms);
    expect(canManageCustomer(canLeadership)).toBe(true);
    expect(canManageDebt(canLeadership)).toBe(false);
  });
});
