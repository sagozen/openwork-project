import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  InteractionTag,
  InteractionTagPrimary,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  Spinner,
} from "@fluentui/react-components";
import { NoAccess } from "@/components/lims/NoAccess";
import {
  PageHead,
  PermissionButton,
  StatStrip,
  useDlpToast,
  type StatItem,
} from "@/components/lims/common";
import { AssignTaskDrawer, type AssignTaskResult } from "@/components/lims/lab/AssignTaskDrawer";
import { hintText } from "@/components/lims/request-styles";
import {
  labApi,
  useAnalysisTasks,
  useLabMutation,
  type AnalysisTask,
  type AssignTasksResponse,
  type LabScope,
} from "@/features/lab";
import { apiErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { toneToColor } from "@/lib/admin/tone";
import {
  HANDOVER_LOG,
  LAB_STATS,
  LAB_TASKS,
  TASK_FILTERS,
  TASK_STATE_TEXT,
} from "@/lib/admin/lab-data";
import { DISPLAY_TIME_ZONE } from "@/lib/format";

export const Route = createFileRoute("/_app/cong-viec")({
  head: () => ({
    meta: [{ title: "Bảng công việc lab - DLP LIMS" }, { name: "robots", content: "noindex" }],
  }),
  component: LabTasksScreen,
});

const DEMO_SAMPLE_CODES: Record<string, string> = {
  "2610001201VO": "26100012",
  "2610001201CD": "26100012",
  "2610001202VO": "26100013",
  "2610001202CD": "26100013",
  "2610001301CD": "26100014",
};

const receivedAtFormatter = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit",
  minute: "2-digit",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: DISPLAY_TIME_ZONE,
});

function formatReceivedAt(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of receivedAtFormatter.formatToParts(date)) parts[part.type] = part.value;
  return `${parts.hour}:${parts.minute} · ${parts.day}/${parts.month}/${parts.year}`;
}

const demoTasks = (): AnalysisTask[] =>
  LAB_TASKS.map((task) => ({
    code: task.code,
    sampleCode: DEMO_SAMPLE_CODES[task.code],
    requestCode: "DLP000015",
    parentSampleCode: DEMO_SAMPLE_CODES[task.code] ?? "",
    subSampleCode: "",
    receivedAt: HANDOVER_LOG.find(
      (entry) =>
        entry.step.code === "RECEIVE" &&
        entry.scannedCodes.includes(DEMO_SAMPLE_CODES[task.code] ?? ""),
    )?.performedAt,
    parameter: { code: task.param, name: task.param },
    assignee: task.owner === "-" ? null : { id: task.owner, fullName: task.owner },
    status: {
      code: task.state === "done" ? "SUBMITTED" : task.state.toUpperCase(),
      name: TASK_STATE_TEXT[task.state].label,
      tone: TASK_STATE_TEXT[task.state].tone,
    },
    allowedActions:
      task.state === "unassigned"
        ? ["task:claim", "task:assign"]
        : task.state === "assigned"
          ? ["task:start"]
          : ["result:view"],
  }));

function LabTasksScreen() {
  const { can, usesClerk } = useAuth();
  const toast = useDlpToast();
  const navigate = useNavigate();
  const [scope, setScope] = useState<LabScope>("all");
  /* Thẻ đếm mà không mở được nhóm nó đếm thì chỉ là con số: một task "Bị trả lại" nằm lẫn giữa 50
     dòng xếp theo lần động gần nhất là không có cách nào tìm ra. Máy chủ đã nhận `status` từ lâu
     (`GET /analysis-tasks?status=...`), phần thiếu chỉ là nối thẻ vào bộ lọc đó. */
  const [status, setStatus] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [assignCodes, setAssignCodes] = useState<string[]>([]);
  const [demo, setDemo] = useState(demoTasks);
  const list = useAnalysisTasks(
    { groupBy: "sample", scope, page, size: 50, ...(status ? { status: [status] } : {}) },
    usesClerk,
  );
  const claim = useLabMutation((api, code: string) => labApi.claim(api, code));
  const assign = useLabMutation(
    (api, input: { taskCodes: string[]; assigneeId: string; reason?: string }) =>
      labApi.assign(api, input),
  );
  const data = list.data;
  const rows = useMemo(() => {
    const tasks = usesClerk ? (data?.content ?? []) : demo;
    return usesClerk
      ? tasks
      : tasks.filter((task) =>
          scope === "mine"
            ? task.assignee?.fullName === "Nguyễn Thị Hà"
            : scope === "unassigned"
              ? task.status.code === "UNASSIGNED"
              : true,
        );
  }, [usesClerk, data?.content, demo, scope]);
  const sampleRows = useMemo(() => {
    const groups = new Map<string, AnalysisTask[]>();
    for (const task of rows) {
      const code = task.sampleCode ?? task.parentSampleCode;
      groups.set(code, [...(groups.get(code) ?? []), task]);
    }
    return [...groups].map(([code, tasks]) => ({ code, tasks }));
  }, [rows]);
  // Máy chủ đếm trên TOÀN phạm vi lab và trả sẵn cả nhãn lẫn tone (`summary`), nên client không
  // dịch mã trạng thái lần nữa - cùng lý do mọi chip trạng thái khác trong app đọc `name`/`tone`
  // của server. Bản server chưa trả `summary` thì dải KPI vắng mặt, không dựng số giả thay vào.
  const pickStatus = (key: string) => {
    setStatus((current) => (current === key ? null : key));
    setPage(1);
    setSelected([]);
  };
  const stats: StatItem[] = usesClerk
    ? (data?.summary ?? []).map((entry) => ({
        label: entry.label,
        value: entry.value,
        tone: entry.tone,
        onSelect: () => pickStatus(entry.key),
        selected: status === entry.key,
      }))
    : LAB_STATS;
  const byParameter = usesClerk ? (data?.byParameter ?? []) : [];
  const busy = claim.isPending || assign.isPending;
  const mutationError = claim.error ?? assign.error;
  const urgent = usesClerk
    ? ["RETURNED", "ENTERING", "RUNNING"]
        .map((key) => data?.summary?.find((entry) => entry.key === key))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.value > 0))
    : [];

  if (!can(PERM.LAB_READ)) return <NoAccess screen="Bảng công việc lab" />;
  if (usesClerk && list.isPending) return <Spinner label="Đang tải bảng công việc lab…" />;

  const act = async (title: string, run: () => Promise<unknown>) => {
    try {
      await run();
      toast(title);
    } catch (error) {
      toast(apiErrorMessage(error), undefined, "error");
    }
  };
  const onClaim = (code: string) => {
    if (!usesClerk) {
      setDemo((items) =>
        items.map((item) =>
          item.code === code
            ? {
                ...item,
                status: { code: "ASSIGNED", name: "Đã nhận task", tone: "warning" },
                assignee: { id: "demo", fullName: "Nguyễn Thị Hà" },
                allowedActions: ["task:start"],
                displayAction: "CONTINUE",
              }
            : item,
        ),
      );
      return;
    }
    void act(`Đã nhận task ${code}`, () => claim.mutateAsync(code));
  };
  const onAssign = (result: AssignTaskResult) => {
    const input = {
      taskCodes: assignCodes,
      assigneeId: result.analystId,
      ...(result.note.trim() ? { reason: result.note.trim() } : {}),
    };
    if (!usesClerk) {
      setDemo((items) =>
        items.map((item) =>
          assignCodes.includes(item.code)
            ? {
                ...item,
                assignee: { id: result.analystId, fullName: result.analystName },
                status: { code: "ASSIGNED", name: "Đã nhận task", tone: "warning" },
                allowedActions: ["task:start"],
              }
            : item,
        ),
      );
      setAssignCodes([]);
      setSelected([]);
      return;
    }
    void act("Đã gửi yêu cầu phân công", async () => {
      const response: AssignTasksResponse = await assign.mutateAsync(input);
      const failed = response.results.filter((item) => item.outcome === "FAILED");
      if (failed.length)
        toast(
          `${failed.length} task phân công không thành công`,
          failed
            .map((item) => item.message)
            .filter(Boolean)
            .join(" · "),
          "warning",
        );
      setAssignCodes([]);
      setSelected([]);
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1300, minWidth: 0 }}>
      <PageHead
        title="Bảng công việc lab"
        description="Mỗi dòng là một mẫu. Bấm mã mẫu để nhập đầy đủ chỉ tiêu trong cùng một màn."
      />
      {urgent.length ? (
        <section
          aria-label="Việc cần ưu tiên"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            padding: "10px 12px",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-surface)",
            background: "var(--background-card)",
          }}
        >
          <strong>Ưu tiên xử lý</strong>
          {urgent.map((entry) => (
            <Button
              key={entry.key}
              size="small"
              appearance={status === entry.key ? "primary" : "secondary"}
              onClick={() => pickStatus(entry.key)}
            >
              {entry.label}: {entry.value}
            </Button>
          ))}
        </section>
      ) : null}
      {stats.length ? <StatStrip items={stats} /> : null}
      {status ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={hintText}>
            Đang lọc theo trạng thái{" "}
            {data?.summary?.find((entry) => entry.key === status)?.label ?? status}.
          </span>
          <Button size="small" onClick={() => pickStatus(status)}>
            Bỏ lọc trạng thái
          </Button>
        </div>
      ) : null}
      {byParameter.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <span style={hintText}>Phân bố theo chỉ tiêu:</span>
          {byParameter.map((entry) => (
            <Badge key={entry.code} appearance="tint" color="informative">
              {`${entry.name} · ${entry.count}`}
            </Badge>
          ))}
        </div>
      ) : null}
      {list.isError ? (
        <MessageBar intent="error">
          <MessageBarBody>{apiErrorMessage(list.error)}</MessageBarBody>
        </MessageBar>
      ) : null}
      {mutationError ? (
        <MessageBar intent="error">
          <MessageBarBody>{apiErrorMessage(mutationError)}</MessageBarBody>
        </MessageBar>
      ) : null}
      <div className="dlp-chiprow" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {TASK_FILTERS.map((filter) => (
          <InteractionTag
            key={filter.key}
            appearance="outline"
            className={filter.key === scope ? "dlp-chip--picked" : "dlp-chip--unpicked"}
          >
            <InteractionTagPrimary
              aria-pressed={filter.key === scope}
              onClick={() => {
                setScope(filter.key as LabScope);
                setStatus(null);
                setPage(1);
                setSelected([]);
              }}
            >
              {filter.key === scope ? "✓ " : ""}
              {filter.label}
            </InteractionTagPrimary>
          </InteractionTag>
        ))}
        <div style={{ flex: 1 }} />
        {selected.length ? (
          <PermissionButton
            allowed={can(PERM.LAB_TASK_ASSIGN)}
            appearance="primary"
            size="small"
            onClick={() => setAssignCodes(selected)}
          >
            Phân công {selected.length} task
          </PermissionButton>
        ) : null}
      </div>
      <div
        style={{
          overflowX: "auto",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-surface)",
        }}
      >
        <table
          className="dlp-datagrid dlp-datagrid--compact"
          style={{ width: "100%", minWidth: 800 }}
        >
          <thead>
            <tr>
              <th aria-label="Chọn" style={{ width: 40 }} />
              <th style={{ width: 100 }}>Số chỉ tiêu</th>
              <th>Mã mẫu</th>
              <th>Giờ–ngày nhận bàn giao</th>
              <th>Người phụ trách</th>
              <th>Trạng thái</th>
              <th style={{ width: 110 }}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {sampleRows.map(({ code, tasks }) => {
              const assignable = tasks.filter((task) =>
                task.allowedActions.includes("task:assign"),
              );
              // Every group is created with a task, so its first parameter always exists.
              const firstTask = tasks[0]!;
              const assignees = [
                ...new Set(
                  tasks.map(
                    (task) => task.assignee?.fullName ?? task.assignee?.id ?? "Chưa phân công",
                  ),
                ),
              ].join(" · ");
              return (
                <tr key={code}>
                  <td>
                    <Checkbox
                      aria-label={`Chọn mẫu ${code} để phân công`}
                      checked={
                        assignable.length > 0 &&
                        assignable.every((task) => selected.includes(task.code))
                      }
                      disabled={!can(PERM.LAB_TASK_ASSIGN) || !assignable.length}
                      onChange={(_, data) =>
                        setSelected((current) =>
                          data.checked
                            ? [...new Set([...current, ...assignable.map((task) => task.code)])]
                            : current.filter(
                                (item) => !assignable.some((task) => task.code === item),
                              ),
                        )
                      }
                    />
                  </td>
                  <td className="dlp-num">{tasks.length}</td>
                  <td>
                    <Link
                      className="dlp-num"
                      to="/nhap-ket-qua"
                      search={{ code }}
                      aria-label={`Nhập kết quả mẫu ${code}`}
                    >
                      {code}
                    </Link>
                  </td>
                  <td className="dlp-num" style={{ whiteSpace: "nowrap" }}>
                    {formatReceivedAt(firstTask.receivedAt)}
                  </td>
                  <td title={assignees} style={{ maxWidth: 240 }}>
                    <div
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {assignees}
                    </div>
                  </td>
                  <td>
                    <Badge appearance="tint" color={toneToColor(firstTask.status.tone)}>
                      {firstTask.status.name}
                    </Badge>
                  </td>
                  <td>
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <MenuButton size="small" aria-label={`Thao tác mẫu ${code}`}>
                          Thao tác
                        </MenuButton>
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          <MenuItem
                            onClick={() => void navigate({ to: "/nhap-ket-qua", search: { code } })}
                          >
                            Nhập / xem kết quả
                          </MenuItem>
                          {tasks.map((task) => (
                            <span key={task.code} style={{ display: "contents" }}>
                              {task.allowedActions.includes("task:claim") ? (
                                <MenuItem
                                  disabled={busy || !can(PERM.LAB_TASK_CLAIM)}
                                  onClick={() => onClaim(task.code)}
                                >
                                  Nhận · {task.parameter.name}
                                </MenuItem>
                              ) : null}
                              {task.allowedActions.includes("task:assign") ? (
                                <MenuItem
                                  disabled={busy || !can(PERM.LAB_TASK_ASSIGN)}
                                  onClick={() => setAssignCodes([task.code])}
                                >
                                  Phân công · {task.parameter.name}
                                </MenuItem>
                              ) : null}
                            </span>
                          ))}
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </td>
                </tr>
              );
            })}
            {!rows.length ? (
              <tr>
                <td colSpan={7}>
                  {status
                    ? "Không có task nào ở trạng thái đang lọc."
                    : "Không có task nào trong phạm vi này."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {usesClerk && data ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          <span style={hintText}>
            Trang {data.page.number}/{data.page.totalPages || 1} · {data.page.totalElements} mẫu
          </span>
          <Button
            size="small"
            disabled={page <= 1}
            onClick={() => {
              setSelected([]);
              setPage((value) => value - 1);
            }}
          >
            Trước
          </Button>
          <Button
            size="small"
            disabled={page >= data.page.totalPages}
            onClick={() => {
              setSelected([]);
              setPage((value) => value + 1);
            }}
          >
            Sau
          </Button>
        </div>
      ) : null}
      <AssignTaskDrawer
        codes={assignCodes}
        open={assignCodes.length > 0}
        onOpenChange={(open) => {
          if (!open) setAssignCodes([]);
        }}
        onConfirm={onAssign}
      />
    </div>
  );
}
