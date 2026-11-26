import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Switch,
  Toast,
  ToastTitle,
  Toaster,
  useId,
  useToastController,
} from "@fluentui/react-components";
import { AdminSettingsShell } from "@/components/lims/AdminSettingsShell";
import { NoAccess } from "@/components/lims/NoAccess";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import {
  PERM_GROUPS,
  STANDARD_ROLES,
  isPermLocked,
  lockedNote,
  type PermGroup,
  type RoleDef,
} from "@/lib/admin/roles-data";
import { createIamApi } from "@/features/iam/api/iamApi";
import { apiErrorMessage } from "@/lib/api";

export const Route = createFileRoute("/_app/admin/vai-tro")({
  head: () => ({
    meta: [
      { title: "Vai trò & quyền - Quản trị DLP LIMS" },
      {
        name: "description",
        content: "Quản lý vai trò chuẩn và ma trận quyền theo miền nghiệp vụ.",
      },
      { property: "og:title", content: "Vai trò & quyền - Quản trị DLP LIMS" },
      {
        property: "og:description",
        content: "Ma trận permission theo miền nghiệp vụ, quyền nhạy cảm bị khoá theo quy định.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RolesScreen,
});

const pane: React.CSSProperties = {
  background: "var(--background-card)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-surface)",
  overflow: "hidden",
};

function RolesScreen() {
  const { can, usesClerk, getToken } = useAuth();
  const api = useMemo(() => createIamApi(getToken), [getToken]);
  const queryClient = useQueryClient();
  const toasterId = useId("toaster-roles");
  const { dispatchToast } = useToastController(toasterId);
  const [roleId, setRoleId] = useState(STANDARD_ROLES[0]!.id);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState(false);
  // Vai trò đang chờ chuyển sang khi vai trò hiện tại còn thay đổi chưa lưu (BUG-04). Trước đây
  // override được giữ theo khoá `${role.id}.${perm}` và không ai dọn: bấm sang vai trò khác rồi
  // quay lại là thấy công tắc vẫn bật, footer vẫn "sẽ thêm 1 quyền", và lần bấm Lưu sau đó cấp
  // một quyền mà người bấm không còn nhớ mình đã bật.
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);

  // GET /roles (RoleResource.java) trả danh mục vai trò/quyền thật - dùng để dựng payload hợp lệ
  // cho PUT /roles/{code}/permissions. Gated user.manage, khớp với gate của cả màn A-01d này.
  const catalogue = useQuery({
    queryKey: ["iam", "roles"],
    queryFn: () => api.roles(),
    enabled: usesClerk && can(PERM.USER_MANAGE),
    staleTime: 30_000,
  });

  // Chế độ demo giữ nguyên bảy vai trò chuẩn + ma trận mẫu. Chế độ Clerk dựng danh sách vai trò
  // và nhóm quyền duy nhất ("Quyền hệ thống") trực tiếp từ GET /roles - API thật không có id/tiền
  // tố nhóm nghiệp vụ.
  const roles: RoleDef[] = usesClerk
    ? (catalogue.data?.roles ?? []).map((r) => ({ id: r.code, name: r.name }))
    : STANDARD_ROLES;
  const permGroups: PermGroup[] = usesClerk
    ? [
        {
          name: "Quyền hệ thống",
          items: (catalogue.data?.permissions ?? []).map((p) => ({
            key: p.code,
            label: p.name,
            note: p.code,
            def: [],
          })),
        },
      ]
    : PERM_GROUPS;
  const role = roles.find((r) => r.id === roleId) ?? roles[0];

  // GET /roles/{code}/permissions - tập quyền vai trò ĐANG giữ, cộng tập quyền vai trò không bao
  // giờ được giữ. PUT thay toàn bộ tập quyền, nên không có câu trả lời này thì mọi lần lưu đều là
  // ghi đè chứ không phải sửa: đó chính là lỗi BUG-02 (mọi công tắc bắt đầu tắt, bấm Lưu là gỡ
  // sạch quyền của vai trò).
  const current = useQuery({
    queryKey: ["iam", "roles", role?.id, "permissions"],
    queryFn: () => api.rolePermissions(role!.id),
    enabled: usesClerk && can(PERM.USER_MANAGE) && !!role,
    staleTime: 30_000,
  });

  // Backend không có role.read/role.write riêng - cấu hình vai trò đi qua USER_MANAGE
  // (RoleResource.java: "catalogue carries no role.manage... administration either way").
  if (!can(PERM.USER_MANAGE)) return <NoAccess screen="Vai trò & quyền" />;
  if (usesClerk && catalogue.isPending)
    return <div style={{ padding: 32 }}>Đang tải danh mục vai trò…</div>;
  if (usesClerk && catalogue.isError)
    return <div style={{ padding: 32 }}>Không thể tải danh mục vai trò. Vui lòng thử lại.</div>;
  if (!role) return <div style={{ padding: 32 }}>Chưa có vai trò nào trong danh mục.</div>;

  const canWrite = can(PERM.USER_MANAGE);
  // Chỉ đọc được tập quyền gốc mới được phép ghi đè nó. Ở chế độ demo không có gì để tải nên
  // luôn sẵn sàng.
  const loaded = !usesClerk || current.isSuccess;
  const notify = (title: string, intent: "success" | "error" = "success") =>
    dispatchToast(
      <Toast>
        <ToastTitle>{title}</ToastTitle>
      </Toast>,
      { intent },
    );

  // Quyền bị khoá: chế độ Clerk lấy đúng danh sách backend trả về (FR-IAM-018 + BR-012/D07 đọc từ
  // cờ trên ops.role/ops.permission), chế độ demo dùng cờ pii/pro của dữ liệu mẫu. FE không tự
  // suy lại quy định - suy lại chính là cách quy định được in ra màn hình mà không có gì thi hành
  // (BUG-03).
  const lockedIds = new Set(current.data?.lockedPermissionIds ?? []);
  const isLocked = (p: PermGroup["items"][number]) =>
    usesClerk ? lockedIds.has(p.key) : isPermLocked(p, role.id);
  // API trả danh sách mã bị khoá chứ không trả lý do từng mã, nên ở chế độ Clerk nêu cả hai quy
  // định đang tạo ra danh sách đó thay vì đoán mã này thuộc quy định nào.
  const lockReason = (p: PermGroup["items"][number]) =>
    usesClerk
      ? "Vai trò này không được cấp quyền theo chính sách phân quyền của hệ thống."
      : lockedNote(p);
  // Trạng thái gốc của từng công tắc: tập quyền máy chủ trả về (Clerk) hoặc ma trận mẫu (demo).
  const baselineIds = new Set(
    usesClerk
      ? (current.data?.permissionIds ?? [])
      : permGroups
          .flatMap((g) => g.items)
          .filter((p) => p.def.includes(role.id))
          .map((p) => p.key),
  );
  const isOn = (p: PermGroup["items"][number]) => {
    if (isLocked(p)) return false;
    return overrides[`${role.id}.${p.key}`] ?? baselineIds.has(p.key);
  };
  const allItems = permGroups.flatMap((g) => g.items);
  const selectedPermissionIds = allItems.filter(isOn).map((p) => p.key);
  const added = allItems.filter((p) => isOn(p) && !baselineIds.has(p.key));
  const removed = allItems.filter((p) => !isOn(p) && baselineIds.has(p.key));
  const dirty = added.length > 0 || removed.length > 0;

  // Đổi vai trò khi còn thay đổi chưa lưu thì hỏi trước; bỏ thay đổi luôn xoá override của vai trò
  // vừa rời đi, để không còn trạng thái bẩn nào sống sót sau lần chuyển.
  const selectRole = (nextRoleId: string) => {
    if (nextRoleId === role.id) return;
    if (dirty) {
      setPendingRoleId(nextRoleId);
      return;
    }
    setRoleId(nextRoleId);
  };
  const discardAndSwitch = () => {
    const next = pendingRoleId;
    setPendingRoleId(null);
    setOverrides((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${role.id}.`))),
    );
    if (next) setRoleId(next);
  };

  const saveRole = () => {
    setConfirming(false);
    if (!usesClerk) {
      notify("Đã lưu ma trận quyền");
      return;
    }
    const permissionIds = selectedPermissionIds;
    void api
      .updateRolePermissions(role.id, permissionIds)
      .then((saved) => {
        // Máy chủ trả về chính tài liệu mà GET trả về, nên dùng thẳng nó làm trạng thái gốc mới
        // và xoá override của vai trò này: nếu không, mọi công tắc vẫn tính là "đã đổi" so với
        // dữ liệu trước khi lưu và nút Lưu vẫn sáng.
        queryClient.setQueryData(["iam", "roles", role.id, "permissions"], saved);
        setOverrides((prev) =>
          Object.fromEntries(
            Object.entries(prev).filter(([key]) => !key.startsWith(`${role.id}.`)),
          ),
        );
        notify(`Đã lưu ma trận quyền cho ${role.name}`);
      })
      .catch((error: unknown) => {
        const e = error as { message?: string; body?: { traceId?: string } };
        notify(
          `${e.message ?? "Lưu ma trận quyền thất bại"}${
            e.body?.traceId ? ` · Trace ID: ${e.body.traceId}` : ""
          }`,
          "error",
        );
      });
  };

  return (
    <>
      <Toaster toasterId={toasterId} position="bottom-end" />
      <AdminSettingsShell code="A-01d">
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div className="dlp-pane" style={{ ...pane, flex: "1 1 240px" }}>
            {roles.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => selectRole(r.id)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "11px 14px",
                  border: 0,
                  borderBottom: "1px solid var(--border-subtle)",
                  cursor: "pointer",
                  background: r.id === role.id ? "var(--background-selected)" : "transparent",
                }}
              >
                <div style={{ font: "14px/20px var(--font-family-base)" }}>{r.name}</div>
                {r.users != null ? (
                  <div className="dlp-datagrid__secondary">{r.users} người dùng</div>
                ) : null}
              </button>
            ))}
          </div>

          <div className="dlp-pane" style={{ ...pane, flex: "2 1 420px" }}>
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border-subtle)",
                font: "600 16px/22px var(--font-family-base)",
              }}
            >
              Ma trận quyền - {role.name}
            </div>

            {/* PUT thay TOÀN BỘ tập quyền. Khi chưa đọc được tập quyền gốc thì mọi công tắc là
                giả thiết chứ không phải trạng thái thật, nên màn này khoá cứng cả công tắc lẫn nút
                Lưu thay vì chỉ cảnh báo bằng chữ - cảnh báo bằng chữ chính là thứ đã để BUG-02
                xảy ra. */}
            {usesClerk && current.isPending ? (
              <div style={{ padding: "12px 16px 0" }}>
                <MessageBar intent="info">
                  <MessageBarBody>Đang nạp quyền hiện có của vai trò…</MessageBarBody>
                </MessageBar>
              </div>
            ) : null}
            {usesClerk && current.isError ? (
              <div style={{ padding: "12px 16px 0" }}>
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Không nạp được quyền đang có:</MessageBarTitle>{" "}
                    {apiErrorMessage(current.error)} Mọi công tắc và nút Lưu bị khoá cho tới khi đọc
                    được tập quyền gốc - lưu lúc này sẽ <strong>thay toàn bộ</strong> quyền của vai
                    trò bằng một trạng thái không ai đọc được.
                  </MessageBarBody>
                  <MessageBarActions>
                    <Button size="small" onClick={() => void current.refetch()}>
                      Thử lại
                    </Button>
                  </MessageBarActions>
                </MessageBar>
              </div>
            ) : null}

            {permGroups.map((g) => (
              <div key={g.name}>
                <div
                  style={{
                    font: "600 12px/16px var(--font-family-base)",
                    color: "var(--foreground-secondary)",
                    padding: "10px 16px 2px",
                  }}
                >
                  {g.name}
                </div>
                {g.items.map((p) => {
                  const locked = isLocked(p);
                  const on = isOn(p);
                  return (
                    <div
                      key={p.key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "8px 16px",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ font: "14px/20px var(--font-family-base)" }}>{p.label}</div>
                        <div className="dlp-datagrid__secondary">
                          {locked ? lockReason(p) : p.note}
                        </div>
                      </div>
                      <Switch
                        checked={on}
                        disabled={locked || !canWrite || !loaded}
                        aria-label={p.label}
                        title={locked ? lockReason(p) : undefined}
                        onChange={() => {
                          const key = `${role.id}.${p.key}`;
                          setOverrides((prev) => ({ ...prev, [key]: !on }));
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            ))}

            <div
              style={{
                padding: "12px 16px",
                borderTop: "1px solid var(--border-subtle)",
                font: "12px/16px var(--font-family-base)",
                color: "var(--foreground-secondary)",
              }}
            >
              Quyền bị khoá theo chính sách không thể bật tại đây. Danh sách khoá do máy chủ quản lý
              và được kiểm tra lại với mọi yêu cầu cập nhật.
            </div>
            <div
              style={{
                padding: "12px 16px",
                borderTop: "1px solid var(--border-subtle)",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 12,
              }}
            >
              <span
                className="dlp-datagrid__secondary"
                style={{ marginRight: "auto" }}
                aria-live="polite"
              >
                {!loaded
                  ? "Chưa đọc được quyền hiện có - không lưu được."
                  : dirty
                    ? `Sẽ thêm ${added.length} quyền, gỡ ${removed.length} quyền.`
                    : "Chưa có thay đổi nào so với quyền hiện có."}
              </span>
              <Button
                appearance="primary"
                disabled={!canWrite || !loaded || !dirty}
                onClick={() => (usesClerk ? setConfirming(true) : saveRole())}
              >
                Lưu thay đổi
              </Button>
            </div>
          </div>
        </div>

        <Dialog
          open={pendingRoleId !== null}
          onOpenChange={(_, d) => {
            if (!d.open) setPendingRoleId(null);
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Bỏ thay đổi chưa lưu của {role.name}?</DialogTitle>
              <DialogContent>
                <p style={{ margin: 0 }}>
                  Vai trò này đang có {added.length} quyền được bật thêm và {removed.length} quyền
                  bị gỡ mà chưa lưu. Chuyển sang vai trò khác sẽ bỏ hết các thay đổi đó.
                </p>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setPendingRoleId(null)}>Ở lại và lưu</Button>
                <Button appearance="primary" onClick={discardAndSwitch}>
                  Bỏ thay đổi và chuyển
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={confirming} onOpenChange={(_, d) => setConfirming(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Thay toàn bộ quyền của {role.name}?</DialogTitle>
              <DialogContent>
                <p style={{ margin: "0 0 12px" }}>
                  Vai trò này sẽ giữ đúng {selectedPermissionIds.length} quyền đang bật. Không có
                  bước hoàn tác.
                </p>
                {added.length ? (
                  <p style={{ margin: "0 0 8px" }}>
                    <strong>Thêm ({added.length}):</strong> {added.map((p) => p.label).join(", ")}
                  </p>
                ) : null}
                {removed.length ? (
                  <p style={{ margin: 0 }}>
                    <strong>Gỡ ({removed.length}):</strong> {removed.map((p) => p.label).join(", ")}
                  </p>
                ) : null}
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setConfirming(false)}>Huỷ</Button>
                <Button appearance="primary" onClick={saveRole}>
                  Thay toàn bộ quyền
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </AdminSettingsShell>
    </>
  );
}
