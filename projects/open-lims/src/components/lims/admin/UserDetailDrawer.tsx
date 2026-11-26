import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Textarea,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { Fragment, useState, type ReactNode } from "react";
import type { AdminUser } from "@/lib/admin/mock-data";
import { PERM } from "@/lib/admin/rbac";
import type { IamRoleCatalogueEntry } from "@/features/iam/types/iam";
import {
  RoleBranchPicker,
  type BranchOption,
  type RoleOption,
} from "@/components/lims/admin/RoleBranchPicker";

const label: React.CSSProperties = { color: "var(--foreground-secondary)" };
const groupTitle: React.CSSProperties = {
  font: "600 12px/16px var(--font-family-base)",
  color: "var(--foreground-secondary)",
  marginBottom: 8,
};
const boxed: React.CSSProperties = {
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-surface)",
  overflow: "hidden",
};

/* A-01c · Chi tiết người dùng, phân quyền và vô hiệu hoá tài khoản. */
export function UserDetailDrawer({
  user,
  canWrite,
  canDisable,
  lastAdministrator,
  self,
  onClose,
  onDisable,
  onReactivate,
  onNotify,
  roles,
  branches,
  permissions,
  onSaveAssignments,
  savingAssignments,
  assignmentsError,
  workload,
  workloadLoading,
  signatureImageUrl,
  history,
}: {
  user: AdminUser | null;
  canWrite: boolean;
  canDisable: boolean;
  /**
   * Người này là tài khoản quản trị đang hoạt động cuối cùng của đơn vị (`IamUser.administers` +
   * đếm trên danh sách). Khi đúng, mọi thao tác lấy đi quyền quản trị của họ đều bị chặn ngay tại
   * đây - backend từ chối bằng `E-IAM-013`, nhưng chỉ sau khi người dùng đã bấm Lưu.
   */
  lastAdministrator?: boolean;
  /** Hồ sơ đang mở chính là người đang đăng nhập - cảnh báo, không chặn. */
  self?: boolean;
  onClose: () => void;
  onDisable: (u: AdminUser, reason: string) => void;
  /** Mở khoá tài khoản đã vô hiệu hoá (`POST /users/{id}/reactivate`). */
  onReactivate?: (u: AdminUser, reason: string) => void;
  onNotify: (title: string, body: string) => void;
  /** Vắng mặt ở chế độ demo: không có máy chủ nào để ghi phân quyền vào. */
  roles?: RoleOption[];
  branches?: BranchOption[];
  permissions?: IamRoleCatalogueEntry[];
  onSaveAssignments?: (
    u: AdminUser,
    input: { roleId: string; branchIds: string[]; extraPermissionIds: string[] },
  ) => void;
  savingAssignments?: boolean;
  assignmentsError?: string;
  workload?: {
    samplingAssignments: number;
    analysisTasks: number;
    pendingApprovals: number;
    total: number;
  };
  /** GET /users/{id}/assigned-work đang tải - tránh nháy "không có việc" trước khi có dữ liệu. */
  workloadLoading?: boolean;
  /**
   * Object URL của ảnh chữ ký đang lưu (`GET /users/{id}/signature/image`), do màn gọi tải và tự
   * thu hồi. Vắng khi người đó chưa đặt chữ ký, hoặc ở chế độ demo - ngăn xem trước không hiện.
   */
  signatureImageUrl?: string;
  /**
   * Khối "Lịch sử phân quyền và trạng thái". Do chỗ gọi dựng vì nguồn khác nhau theo chế độ, và
   * vì nhật ký nằm sau quyền `audit.read` mà drawer này không tự kiểm được.
   */
  history?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  // Nạp lại bản nháp khi đổi người hoặc khi máy chủ trả phân quyền vừa lưu.
  const [draft, setDraft] = useState<{
    roleId: string;
    branchIds: string[];
    extraPermissionIds: string[];
  } | null>(null);
  const [draftFor, setDraftFor] = useState<AdminUser | null>(null);
  if (user && draftFor !== user) {
    setDraftFor(user);
    setDraft({
      roleId: user.roleId,
      branchIds: user.branchIds ?? [],
      extraPermissionIds: user.extraPermissionIds ?? [],
    });
  }
  const assignment = draft ?? {
    roleId: user?.roleId ?? "",
    branchIds: user?.branchIds ?? [],
    extraPermissionIds: user?.extraPermissionIds ?? [],
  };
  const canEditAssignments =
    canWrite && !!onSaveAssignments && !!roles && !!permissions && !!user?.extraPermissionIds;
  const assignmentChanged =
    !!user &&
    (assignment.roleId !== user.roleId ||
      assignment.branchIds.slice().sort().join(",") !==
        (user.branchIds ?? []).slice().sort().join(",") ||
      assignment.extraPermissionIds.slice().sort().join(",") !==
        (user.extraPermissionIds ?? []).slice().sort().join(","));
  // Người quản trị cuối cùng phải giữ user.manage qua vai trò hoặc grant riêng, và còn chi nhánh.
  const targetRoleAdministers =
    roles?.find((r) => r.id === assignment.roleId)?.administers ?? false;
  const wouldLoseLastAdministrator =
    !!lastAdministrator &&
    ((!targetRoleAdministers && !assignment.extraPermissionIds.includes(PERM.USER_MANAGE)) ||
      assignment.branchIds.length === 0);
  // Hồ sơ đã vô hiệu hoá: ngăn này chuyển sang việc mở khoá. Trạng thái "chờ kích hoạt" không vào
  // nhánh này - người đó chưa từng bị khoá, việc của họ là lời mời.
  const reactivating = user?.status === "off";
  const lastAdministratorNote =
    "Đây là tài khoản quản trị đang hoạt động cuối cùng. Cấp quyền quản trị cho người khác trước, " +
    "rồi mới đổi vai trò hoặc vô hiệu hoá tài khoản này.";

  const identity = user
    ? [
        { k: "Email", v: user.email },
        {
          k: "Trạng thái",
          v:
            user.status === "active"
              ? "Hoạt động"
              : user.status === "invited"
                ? `Đã mời – chờ kích hoạt (hết hạn ${user.expires ?? "-"})`
                : "Vô hiệu hoá",
        },
        { k: "Mã người dùng", v: user.id },
        // Chức danh chỉ hiện khi có: người chưa được đặt chức danh vẫn phê duyệt bình thường, và
        // phiếu của họ chỉ in họ tên - một dòng "-" ở đây sẽ đọc như một thiếu sót.
        ...(user.jobTitle ? [{ k: "Chức danh", v: user.jobTitle }] : []),
        { k: "Múi giờ hiển thị", v: "Asia/Ho_Chi_Minh" },
        { k: "Đăng nhập cuối", v: user.lastLogin },
      ]
    : [];

  return (
    <Drawer
      type="overlay"
      position="end"
      separator
      open={!!user}
      onOpenChange={(_, d) => {
        if (!d.open) {
          setReason("");
          onClose();
        }
      }}
      style={{ width: 480 }}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Đóng"
              onClick={() => {
                setReason("");
                onClose();
              }}
            />
          }
        >
          {user?.name ?? ""}
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        {user ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 16 }}>
            <div
              className="dlp-labelgrid"
              style={{
                display: "grid",
                gridTemplateColumns: "130px 1fr",
                gap: "8px 14px",
                font: "14px/20px var(--font-family-base)",
              }}
            >
              {identity.map((r) => (
                <Fragment key={r.k}>
                  <span style={label}>{r.k}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>
                    {r.v}
                  </span>
                </Fragment>
              ))}
            </div>

            {signatureImageUrl ? (
              <div>
                <div style={groupTitle}>Chữ ký in trên phiếu kết quả</div>
                <div style={{ ...boxed, padding: 12, display: "grid", gap: 6 }}>
                  <img
                    src={signatureImageUrl}
                    alt={`Chữ ký của ${user.name}`}
                    style={{
                      maxWidth: 240,
                      maxHeight: 96,
                      objectFit: "contain",
                      background: "#fff",
                      borderRadius: 4,
                    }}
                  />
                  {/* Chỉ xem. Chữ ký do người khác tải lên là bằng chứng của không ai, nên không
                      có đường ghi từ đây - chính chủ đặt trong «Hồ sơ cá nhân». */}
                  <span style={{ ...label, font: "12px/16px var(--font-family-base)" }}>
                    Chỉ chính chủ đặt được chữ ký này, trong «Hồ sơ cá nhân».
                  </span>
                </div>
              </div>
            ) : null}

            <div>
              <div style={groupTitle}>Phân quyền</div>
              <div style={{ ...boxed, padding: 12 }}>
                <div style={{ marginBottom: 10 }}>
                  Hiện tại:{" "}
                  <Badge appearance="tint" color="informative" size="small">
                    {user.roles}
                  </Badge>
                </div>
                {canEditAssignments ? (
                  <>
                    <RoleBranchPicker
                      roles={roles}
                      branches={branches ?? []}
                      roleId={assignment.roleId}
                      branchIds={assignment.branchIds}
                      disabled={savingAssignments}
                      onChange={(next) => setDraft({ ...assignment, ...next })}
                    />
                    <Field label="Quyền bổ sung cho người dùng" style={{ marginTop: 12 }}>
                      <span style={{ ...label, font: "12px/16px var(--font-family-base)" }}>
                        Chỉ cấp riêng cho người này; không thay đổi quyền của vai trò.
                      </span>
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        {permissions?.map((permission) => (
                          <Checkbox
                            key={permission.code}
                            label={permission.name}
                            aria-label={permission.name}
                            title={permission.code}
                            checked={assignment.extraPermissionIds.includes(permission.code)}
                            disabled={savingAssignments}
                            onChange={(_, data) =>
                              setDraft({
                                ...assignment,
                                extraPermissionIds: data.checked
                                  ? [...assignment.extraPermissionIds, permission.code]
                                  : assignment.extraPermissionIds.filter(
                                      (code) => code !== permission.code,
                                    ),
                              })
                            }
                          />
                        ))}
                      </div>
                    </Field>
                    {assignmentsError ? (
                      <MessageBar intent="error" style={{ marginTop: 10 }}>
                        <MessageBarBody>{assignmentsError}</MessageBarBody>
                      </MessageBar>
                    ) : null}
                    {wouldLoseLastAdministrator ? (
                      <MessageBar intent="error" style={{ marginTop: 10 }}>
                        <MessageBarBody>
                          <MessageBarTitle>Không lưu được thay đổi này:</MessageBarTitle>{" "}
                          {lastAdministratorNote}
                        </MessageBarBody>
                      </MessageBar>
                    ) : self ? (
                      <MessageBar intent="warning" style={{ marginTop: 10 }}>
                        <MessageBarBody>
                          <MessageBarTitle>Đây là tài khoản của chính bạn:</MessageBarTitle> đổi vai
                          trò sẽ áp dụng ngay cho phiên đang mở, kể cả khi vai trò mới không vào
                          được màn quản trị.
                        </MessageBarBody>
                      </MessageBar>
                    ) : null}
                    <div style={{ marginTop: 10 }}>
                      <Button
                        appearance="primary"
                        size="small"
                        disabled={
                          savingAssignments ||
                          !assignmentChanged ||
                          !assignment.roleId ||
                          assignment.branchIds.length === 0 ||
                          wouldLoseLastAdministrator
                        }
                        title={wouldLoseLastAdministrator ? lastAdministratorNote : undefined}
                        onClick={() => onSaveAssignments(user, assignment)}
                      >
                        {savingAssignments ? "Đang lưu…" : "Lưu phân quyền"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <span style={{ ...label, font: "12px/16px var(--font-family-base)" }}>
                    {canWrite
                      ? "Không thể cập nhật phân quyền trên môi trường hiện tại."
                      : "Cần quyền quản lý người dùng để đổi phân quyền."}
                  </span>
                )}
              </div>
            </div>

            <div>
              <div style={groupTitle}>Lịch sử phân quyền và trạng thái</div>
              {/* Nội dung do chỗ gọi cấp: chế độ thật đọc nhật ký `audit.read`, bản minh hoạ
                  dùng dữ liệu dựng sẵn. Không có quyền đọc nhật ký thì nói thẳng, thay vì in một
                  lịch sử bịa giống hệt nhau cho mọi người dùng như trước đây. */}
              {history ?? (
                <span style={{ ...label, font: "12px/16px var(--font-family-base)" }}>
                  Cần quyền đọc nhật ký hệ thống để xem lịch sử của tài khoản này.
                </span>
              )}
            </div>

            {/* Tài khoản đã vô hiệu hoá thì việc duy nhất còn làm được ở đây là mở khoá lại; hỏi
                "việc đang giao" của một người đã bị cắt quyền là hỏi nhầm câu. */}
            {reactivating ? (
              <div
                style={{
                  borderTop: "1px solid var(--border-subtle)",
                  paddingTop: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div style={{ font: "600 14px/20px var(--font-family-base)" }}>
                  Mở khoá tài khoản
                </div>
                <Field label="Lý do - không bắt buộc">
                  <Textarea
                    rows={2}
                    value={reason}
                    onChange={(_, d) => setReason(d.value)}
                    placeholder="Ví dụ: quay lại làm việc từ 01/09/2026"
                  />
                </Field>
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Phân quyền cũ được giữ nguyên:</MessageBarTitle> vô hiệu hoá
                    không đóng vai trò và chi nhánh, nên mở khoá trả lại đúng phân quyền trước đó -
                    kiểm tra lại mục Phân quyền phía trên nếu người này đổi công việc.
                  </MessageBarBody>
                </MessageBar>
              </div>
            ) : (
              <div
                style={{
                  borderTop: "1px solid var(--border-subtle)",
                  paddingTop: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div style={{ font: "600 14px/20px var(--font-family-base)" }}>
                  Vô hiệu hoá tài khoản
                </div>
                <Field label="Lý do - bắt buộc">
                  <Textarea
                    rows={2}
                    value={reason}
                    onChange={(_, d) => setReason(d.value)}
                    placeholder="Ví dụ: nghỉ việc từ 05/08/2026"
                  />
                </Field>
                {lastAdministrator ? (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>Không vô hiệu hoá được tài khoản này:</MessageBarTitle>{" "}
                      {lastAdministratorNote}
                    </MessageBarBody>
                  </MessageBar>
                ) : null}
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Việc đang giao phải phân công lại:</MessageBarTitle> Vô hiệu
                    hoá chặn mọi request trong 60 giây và thu hồi phiên đăng nhập, nhưng hồ sơ người
                    dùng không bị xoá - tên vẫn còn trên audit và phiếu đã ký.
                  </MessageBarBody>
                </MessageBar>
                <div style={boxed}>
                  {workload ? (
                    userWorkload(workload).map((w) => (
                      <div
                        key={w.item}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 12px",
                          borderBottom: "1px solid var(--border-subtle)",
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontVariantNumeric: "tabular-nums" }}>{w.item}</div>
                          <div className="dlp-datagrid__secondary">{w.kind}</div>
                        </div>
                        <Button
                          size="small"
                          disabled={!canWrite}
                          onClick={() =>
                            onNotify(
                              `Phân công lại ${w.item.split(" · ")[0]}`,
                              "Việc chuyển sang người khác trước khi vô hiệu hoá tài khoản.",
                            )
                          }
                        >
                          {w.cta}
                        </Button>
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: "10px 12px" }} className="dlp-datagrid__secondary">
                      {workloadLoading
                        ? "Đang tải việc đang giao…"
                        : "Không có việc nào đang giao cho người dùng này."}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DrawerBody>

      <DrawerFooter>
        {reactivating ? (
          <Button
            appearance="primary"
            disabled={!canDisable || !onReactivate}
            onClick={() => {
              if (!user || !onReactivate) return;
              onReactivate(user, reason.trim());
              setReason("");
            }}
          >
            Mở khoá tài khoản
          </Button>
        ) : (
          <Button
            appearance="outline"
            disabled={!canDisable || !reason.trim() || !!lastAdministrator}
            title={lastAdministrator ? lastAdministratorNote : undefined}
            onClick={() => {
              if (!user) return;
              onDisable(user, reason.trim());
              setReason("");
            }}
          >
            Vô hiệu hoá tài khoản
          </Button>
        )}
        <Button
          onClick={() => {
            setReason("");
            onClose();
          }}
        >
          Đóng
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function userWorkload(workload?: {
  samplingAssignments: number;
  analysisTasks: number;
  pendingApprovals: number;
  total: number;
}) {
  if (!workload) return [];
  return [
    {
      item: `${workload.samplingAssignments} lượt lấy mẫu`,
      kind: "Lượt hiện trường",
      cta: "Phân công lại",
    },
    {
      item: `${workload.analysisTasks} analysis task`,
      kind: "Công việc phòng thí nghiệm",
      cta: "Phân công lại",
    },
    {
      item: `${workload.pendingApprovals} hồ sơ chờ duyệt`,
      kind: "Hồ sơ chờ duyệt",
      cta: "Chuyển người duyệt",
    },
  ];
}
