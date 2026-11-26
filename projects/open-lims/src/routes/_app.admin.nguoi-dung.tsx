import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Avatar,
  Badge,
  Button,
  Dropdown,
  InteractionTag,
  InteractionTagPrimary,
  Input,
  Option,
  Toast,
  ToastTitle,
  Toaster,
  useId,
  useToastController,
} from "@fluentui/react-components";
import { Add20Regular } from "@fluentui/react-icons";
import { EmptyState, SearchInput, Toolbar } from "@/components/lims/common";
import { AdminSettingsShell } from "@/components/lims/AdminSettingsShell";
import {
  InviteUserDialog,
  type InviteBranchOption,
} from "@/components/lims/admin/InviteUserDialog";
import { UserDetailDrawer } from "@/components/lims/admin/UserDetailDrawer";
import { DemoUserAuditHistory, UserAuditHistory } from "@/components/lims/admin/UserAuditHistory";
import { NoAccess } from "@/components/lims/NoAccess";
import { useAdminData } from "@/lib/admin/admin-store";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { ADMIN_ROLE_OPTIONS, type AdminUser } from "@/lib/admin/mock-data";
import { createIamApi } from "@/features/iam/api/iamApi";
import type { IamUser } from "@/features/iam/types/iam";
import { apiErrorMessage } from "@/lib/api";

export const Route = createFileRoute("/_app/admin/nguoi-dung")({
  head: () => ({
    meta: [
      { title: "Người dùng - Cài đặt DLP LIMS" },
      {
        name: "description",
        content:
          "Mời người dùng qua email, gán vai trò theo chi nhánh và quản lý trạng thái tài khoản.",
      },
    ],
  }),
  component: UsersScreen,
});

const STATUS_FILTERS = [
  ["all", "Tất cả"],
  ["active", "Hoạt động"],
  ["invited", "Chờ kích hoạt"],
  ["off", "Vô hiệu hoá"],
] as const;

function toAdminUser(user: IamUser): AdminUser {
  const role = user.roles[0];
  const branch = user.branches.map((item) => `CN${item.code || item.id}`).join(", ") || "-";
  return {
    id: user.userId,
    code: user.userId,
    name: user.fullName,
    email: user.email,
    roles: `${role?.name ?? "Chưa gán vai trò"} · ${branch}`,
    roleId: role?.code ?? "",
    branch,
    branchIds: user.branches.map((item) => item.id),
    extraPermissionIds: user.extraPermissionIds,
    status:
      user.status === "ACTIVE"
        ? "active"
        : user.status === "PENDING_ACTIVATION"
          ? "invited"
          : "off",
    lastLogin: user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("vi-VN") : "-",
    administers: user.administers,
    ...(user.jobTitle ? { jobTitle: user.jobTitle } : {}),
    ...(user.invitation?.expiresAt
      ? { expires: new Date(user.invitation.expiresAt).toLocaleDateString("vi-VN") }
      : {}),
    ...(user.invitation?.id ? { invitationId: user.invitation.id } : {}),
  };
}

function UsersScreen() {
  const { can, getToken, usesClerk, user: authUser, branches: ownBranches } = useAuth();
  const { users: mockUsers, toggleUserStatus } = useAdminData();
  const queryClient = useQueryClient();
  const api = useMemo(() => createIamApi(getToken), [getToken]);
  const [openUser, setOpenUser] = useState<AdminUser | null>(null);
  const remoteUsers = useQuery({
    queryKey: ["iam", "users"],
    queryFn: () => api.users(),
    enabled: usesClerk && can(PERM.USER_READ),
    staleTime: 30_000,
  });
  // GET /users/{id}/assigned-work (UserDirectoryResource.java) đếm việc đang giao qua lab/sampling
  // - chỉ gọi khi hồ sơ đang mở, gated user.read giống GET /users/{id}.
  const assignedWork = useQuery({
    queryKey: ["iam", "users", openUser?.id, "assigned-work"],
    queryFn: () => api.assignedWork(openUser!.id),
    enabled: usesClerk && !!openUser && can(PERM.USER_READ),
    staleTime: 30_000,
  });
  // GET /users/{id}/signature/image trả byte ảnh, và 404 khi người đó chưa đặt chữ ký - đó là
  // trạng thái bình thường, nên không thử lại và không báo lỗi: ngăn xem trước đơn giản là trống.
  const signatureImage = useQuery({
    queryKey: ["iam", "users", openUser?.id, "signature-image"],
    queryFn: () => api.userSignatureImage(openUser!.id),
    enabled: usesClerk && !!openUser && can(PERM.USER_READ),
    retry: false,
    staleTime: 5 * 60_000,
  });
  // Blob chỉ dùng được qua object URL, và object URL phải được thu hồi - nếu không, mỗi lần mở một
  // hồ sơ là một ảnh nằm lại trong bộ nhớ cho tới khi tải lại trang.
  const [signatureUrl, setSignatureUrl] = useState<string>();
  useEffect(() => {
    const blob = signatureImage.data;
    if (!blob) {
      setSignatureUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setSignatureUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [signatureImage.data]);
  // GET /roles (RoleResource.java) đòi đúng user.manage - cùng quyền với nút "Mời người dùng",
  // nên chỉ gọi khi caller thực sự có thể mời.
  const remoteRoles = useQuery({
    queryKey: ["iam", "roles"],
    queryFn: () => api.roles(),
    enabled: usesClerk && can(PERM.USER_MANAGE),
    staleTime: 30_000,
  });
  const remoteItems = useMemo(() => remoteUsers.data?.users ?? [], [remoteUsers.data]);
  const users = usesClerk ? remoteItems.map(toAdminUser) : mockUsers;
  // Ma trận vai trò thật của backend không trùng ADMIN_ROLE_OPTIONS (dữ liệu mẫu "motcua",
  // "qlmotcua"…) - ở chế độ Clerk, dựng bộ lọc vai trò từ chính vai trò đã tải về.
  const roleFilterOptions = useMemo(() => {
    if (!usesClerk) return ADMIN_ROLE_OPTIONS;
    const seen = new Map<string, string>();
    for (const u of remoteItems) {
      for (const r of u.roles) if (!seen.has(r.code)) seen.set(r.code, r.name);
    }
    return Array.from(seen, ([value, label]) => ({ value, label }));
  }, [usesClerk, remoteItems]);
  // Lời mời cần đúng vai trò/chi nhánh thật, không phải dữ liệu mẫu. Vai trò lấy thẳng từ
  // GET /roles (RoleSummary.code là giá trị roleId endpoint mời chấp nhận - api-map.md/
  // RoleResource.java). Chi nhánh chưa có catalogue riêng (không có GET /branches) nên dựng từ
  // chi nhánh của những người dùng đã tải - đủ dùng vì mọi chi nhánh đang hoạt động đều đã có
  // ít nhất một người dùng, kể cả người gọi hiện tại.
  const inviteRoleOptions = useMemo(
    () =>
      remoteRoles.data?.roles.map((r) => ({
        id: r.code,
        name: r.name,
        administers: r.administers ?? false,
      })) ?? [],
    [remoteRoles.data],
  );
  // Danh mục chi nhánh vẫn phải chắp vá: chưa có endpoint `/branches`. Gộp hai nguồn không đầy
  // đủ - chi nhánh của những người dùng đã tải về, và chi nhánh của chính người đang đăng nhập
  // (`GET /me.branches`) - để một chi nhánh mới lập, chưa có ai thuộc về, vẫn chọn được.
  const inviteBranchOptions = useMemo(() => {
    const seen = new Map<string, InviteBranchOption>();
    for (const branch of ownBranches) seen.set(branch.id, { id: branch.id, name: branch.name });
    for (const u of remoteItems)
      for (const b of u.branches) seen.set(b.id, { id: b.id, name: b.name });
    return Array.from(seen.values());
  }, [remoteItems, ownBranches]);
  // PUT /users/{id}/role-assignments thay toàn bộ phân quyền hiện có; sau khi ghi phải nạp lại
  // danh sách để ngăn chi tiết hiển thị đúng vai trò mới thay vì giá trị vừa gửi đi.
  const saveAssignments = useMutation({
    mutationFn: ({
      userId,
      input,
    }: {
      userId: string;
      name: string;
      input: { roleId: string; branchIds: string[]; extraPermissionIds: string[] };
    }) => api.updateRoleAssignments(userId, input),
    onSuccess: (updated, variables) => {
      // Ngăn chi tiết giữ bản sao cũ của người dùng: nếu chỉ invalidate danh sách thì drawer vẫn
      // hiển thị vai trò trước khi sửa và nút Lưu vẫn sáng vì so với dữ liệu cũ. Máy chủ trả về
      // chính user document sau khi ghi, dùng thẳng nó.
      setOpenUser(toAdminUser(updated));
      void queryClient
        .invalidateQueries({ queryKey: ["iam", "users"] })
        .then(() => notify(`Đã cập nhật phân quyền của ${variables.name}`));
    },
  });
  // Chỗ dựa quản trị của đơn vị, đếm theo đúng cờ server trả về (`administers`) chứ không suy từ
  // tên vai trò: người được cấp `user.manage` bằng grant riêng không nằm trong vai trò nào cả, và
  // đếm sót họ nghĩa là chặn nhầm một thao tác hợp lệ. Backend vẫn là nơi từ chối thật
  // (E-IAM-013); phần này chỉ để người dùng biết trước thay vì biết sau khi bấm Lưu.
  const administratorCount = useMemo(
    () => (usesClerk ? users.filter((u) => u.administers).length : 0),
    [usesClerk, users],
  );
  const isLastAdministrator = (u: AdminUser | null) =>
    usesClerk && !!u?.administers && administratorCount <= 1;

  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [inviteOpen, setInviteOpen] = useState(false);
  const toasterId = useId("toaster-users");
  const { dispatchToast } = useToastController(toasterId);
  const notify = (title: string) =>
    dispatchToast(
      <Toast>
        <ToastTitle>{title}</ToastTitle>
      </Toast>,
      { intent: "success" },
    );
  const notifyError = (error: unknown) => {
    const e = error as { message?: string; body?: { traceId?: string } };
    dispatchToast(
      <Toast>
        <ToastTitle>
          {e.message ?? "Thao tác thất bại"}
          {e.body?.traceId ? ` · Trace ID: ${e.body.traceId}` : ""}
        </ToastTitle>
      </Toast>,
      { intent: "error" },
    );
  };

  const roleLabel =
    roleFilter === "all"
      ? "Mọi vai trò"
      : (roleFilterOptions.find((r) => r.value === roleFilter)?.label ?? "Mọi vai trò");

  const rows = useMemo(
    () =>
      users.filter((u) => {
        const q = query.trim().toLowerCase();
        const matchQuery =
          !q ||
          u.name.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q) ||
          u.code.toLowerCase().includes(q);
        const matchRole = roleFilter === "all" || u.roleId === roleFilter;
        const matchStatus = statusFilter === "all" || u.status === statusFilter;
        return matchQuery && matchRole && matchStatus;
      }),
    [users, query, roleFilter, statusFilter],
  );

  if (!can(PERM.USER_READ)) return <NoAccess screen="Người dùng" />;
  if (usesClerk && remoteUsers.isPending)
    return <div style={{ padding: 32 }}>Đang tải danh sách người dùng…</div>;
  if (usesClerk && remoteUsers.isError)
    return <div style={{ padding: 32 }}>Không thể tải danh sách người dùng. Vui lòng thử lại.</div>;
  const canWrite = can(PERM.USER_MANAGE);
  return (
    <>
      <Toaster toasterId={toasterId} position="bottom-end" />
      <AdminSettingsShell
        code="A-01a"
        actions={
          <Button
            appearance="primary"
            icon={<Add20Regular />}
            disabled={!canWrite || (usesClerk && remoteRoles.isPending)}
            title={
              !canWrite
                ? undefined
                : usesClerk && remoteRoles.isPending
                  ? "Đang tải danh mục vai trò…"
                  : usesClerk && remoteRoles.isError
                    ? "Không tải được danh mục vai trò - thử lại."
                    : undefined
            }
            onClick={() => setInviteOpen(true)}
          >
            Mời người dùng
          </Button>
        }
      >
        <Toolbar
          left={
            <>
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="Tìm tên, mã NV, email…"
                label="Tìm người dùng"
              />
              <Dropdown
                value={roleLabel}
                selectedOptions={[roleFilter]}
                onOptionSelect={(_, d) => setRoleFilter(d.optionValue ?? "all")}
                style={{ width: 220, minWidth: 220 }}
                aria-label="Lọc theo vai trò"
              >
                <Option value="all">Mọi vai trò</Option>
                {roleFilterOptions.map((r) => (
                  <Option key={r.value} value={r.value}>
                    {r.label}
                  </Option>
                ))}
              </Dropdown>
              <div className="dlp-chiprow">
                {STATUS_FILTERS.map(([value, label]) => (
                  <InteractionTag
                    key={value}
                    appearance="outline"
                    className={statusFilter === value ? "dlp-chip--picked" : "dlp-chip--unpicked"}
                    size="small"
                  >
                    <InteractionTagPrimary aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}>
                      {statusFilter === value ? "✓ " : ""}
                      {label}
                    </InteractionTagPrimary>
                  </InteractionTag>
                ))}
              </div>
            </>
          }
          right={
            <span className="dlp-datagrid__secondary">
              {rows.length}/{users.length} người dùng
            </span>
          }
        />

        <div className="dlp-card" style={{ overflowX: "auto" }}>
          <table className="dlp-datagrid" style={{ minWidth: 820, tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th style={{ width: 40 }}>TT</th>
                <th style={{ width: 175 }}>Nhân viên</th>
                <th style={{ width: 90 }}>Mã NV</th>
                <th style={{ width: 160 }}>Email</th>
                <th style={{ width: 140 }}>Vai trò · chi nhánh</th>
                <th style={{ width: 170 }}>Trạng thái</th>

                <th className="dlp-stickycol dlp-stickycol--head" style={{ width: 120 }}>
                  Hành động
                </th>
              </tr>
            </thead>

            <tbody>
              {rows.map((u, i) => {
                const tone =
                  u.status === "active" ? "success" : u.status === "invited" ? "warning" : "danger";
                const state =
                  u.status === "active"
                    ? "Hoạt động"
                    : u.status === "invited"
                      ? `Đã mời · hết hạn ${u.expires ?? "-"}`
                      : "Vô hiệu hoá";
                const cta =
                  u.status === "invited"
                    ? "Gửi lại lời mời"
                    : u.status === "active"
                      ? "Khoá tài khoản"
                      : "Mở khoá";
                return (
                  <tr key={u.id}>
                    <td className="dlp-datagrid__secondary dlp-num">{i + 1}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <Avatar size={28} name={u.name} color="colorful" />
                        <div style={{ minWidth: 0 }}>
                          <button
                            type="button"
                            className="dlp-linkcell"
                            onClick={() => setOpenUser(u)}
                            title="Mở hồ sơ người dùng"
                          >
                            {u.name}
                          </button>
                          {u.jobTitle ? (
                            <div className="dlp-datagrid__secondary">{u.jobTitle}</div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="dlp-num">{u.code}</td>
                    <td className="dlp-datagrid__secondary">{u.email}</td>
                    <td>{u.roles}</td>
                    <td>
                      <Badge appearance="tint" color={tone}>
                        {state}
                      </Badge>
                      <div className="dlp-datagrid__secondary dlp-num" style={{ marginTop: 2 }}>
                        Đăng nhập: {u.lastLogin}
                      </div>
                    </td>

                    <td className="dlp-stickycol">
                      <Button
                        appearance="subtle"
                        size="small"
                        disabled={
                          !can(PERM.USER_MANAGE) ||
                          (usesClerk && u.status === "active" && isLastAdministrator(u))
                        }
                        title={
                          usesClerk && u.status === "active" && isLastAdministrator(u)
                            ? "Đây là tài khoản quản trị đang hoạt động cuối cùng - cấp quyền quản trị cho người khác trước."
                            : undefined
                        }
                        onClick={() => {
                          if (!usesClerk) {
                            toggleUserStatus(u.id);
                            notify(`Đã cập nhật trạng thái tài khoản ${u.code}`);
                            return;
                          }
                          if (u.status === "invited") {
                            if (!u.invitationId) {
                              notifyError(new Error("Thiếu mã lời mời - thử tải lại trang."));
                              return;
                            }
                            void api
                              .resendInvitation(u.invitationId)
                              .then(() =>
                                queryClient.invalidateQueries({ queryKey: ["iam", "users"] }),
                              )
                              .then(() => notify(`Đã gửi lại lời mời cho ${u.email}`))
                              .catch(notifyError);
                            return;
                          }
                          // "Khoá tài khoản" cần lý do bắt buộc (POST /users/{id}/deactivate) -
                          // mở hồ sơ để thu thập lý do qua UserDetailDrawer thay vì gọi API thiếu
                          // trường bắt buộc. "Mở khoá" cũng vậy: lý do đi vào audit, và hồ sơ là
                          // chỗ duy nhất trên màn này hỏi được nó.
                          if (u.status === "active" || u.status === "off") setOpenUser(u);
                        }}
                      >
                        {cta}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: 0 }}>
                    <EmptyState
                      title="Không có người dùng nào khớp bộ lọc"
                      hint="Thử xoá từ khoá hoặc chọn lại vai trò/trạng thái."
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <InviteUserDialog
          open={inviteOpen}
          users={users}
          roles={usesClerk ? inviteRoleOptions : undefined}
          branches={usesClerk ? inviteBranchOptions : undefined}
          onOpenChange={setInviteOpen}
          onInvite={(input) => {
            if (!usesClerk) {
              notify(`Đã gửi lời mời tới ${input.email} - trạng thái «Đã mời – chờ kích hoạt»`);
              return;
            }
            void api
              .invite(input)
              .then(() => queryClient.invalidateQueries({ queryKey: ["iam", "users"] }))
              .then(() => notify(`Đã gửi lời mời tới ${input.email}`))
              .catch(notifyError);
          }}
        />

        <UserDetailDrawer
          user={openUser}
          canWrite={canWrite}
          canDisable={can(PERM.USER_MANAGE)}
          lastAdministrator={isLastAdministrator(openUser)}
          self={usesClerk && !!authUser && openUser?.id === authUser.id}
          workload={usesClerk ? assignedWork.data : undefined}
          workloadLoading={usesClerk && assignedWork.isPending}
          signatureImageUrl={signatureUrl}
          history={
            // Nhật ký nằm sau `audit.read`, quyền khác với `user.manage` mở được drawer này -
            // không có thì drawer tự nói lý do thay vì hiện lịch sử trống.
            usesClerk ? (
              openUser && can(PERM.AUDIT_READ) ? (
                <UserAuditHistory userId={openUser.id} />
              ) : undefined
            ) : (
              <DemoUserAuditHistory />
            )
          }
          onClose={() => setOpenUser(null)}
          onDisable={(u, reason) => {
            if (!usesClerk) {
              toggleUserStatus(u.id);
              setOpenUser(null);
              notify(`Đã vô hiệu hoá ${u.name} - lý do: ${reason}`);
              return;
            }
            void api
              .deactivate(u.id, reason)
              .then(() => queryClient.invalidateQueries({ queryKey: ["iam", "users"] }))
              .then(() => {
                setOpenUser(null);
                notify(`Đã vô hiệu hoá ${u.name}`);
              })
              .catch(notifyError);
          }}
          onReactivate={
            usesClerk
              ? (u, reason) => {
                  void api
                    .reactivate(u.id, reason)
                    .then(() => queryClient.invalidateQueries({ queryKey: ["iam", "users"] }))
                    .then(() => {
                      setOpenUser(null);
                      notify(`Đã mở khoá tài khoản ${u.name}`);
                    })
                    .catch(notifyError);
                }
              : (u) => {
                  toggleUserStatus(u.id);
                  setOpenUser(null);
                  notify(`Đã mở khoá tài khoản ${u.code}`);
                }
          }
          onNotify={(title) => notify(title)}
          roles={usesClerk ? inviteRoleOptions : undefined}
          branches={usesClerk ? inviteBranchOptions : undefined}
          permissions={usesClerk ? remoteRoles.data?.permissions : undefined}
          savingAssignments={saveAssignments.isPending}
          assignmentsError={
            saveAssignments.error ? apiErrorMessage(saveAssignments.error) : undefined
          }
          onSaveAssignments={
            usesClerk
              ? (u, input) => saveAssignments.mutate({ userId: u.id, name: u.name, input })
              : undefined
          }
        />
      </AdminSettingsShell>
    </>
  );
}
