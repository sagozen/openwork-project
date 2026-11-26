import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Radio,
  Textarea,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiErrorMessage, useApiClient } from "@/lib/api";
import { labApi } from "@/features/lab";
import { useAuth } from "@/lib/auth/AuthProvider";
import { toneToColor } from "@/lib/admin/tone";
import { LAB_ANALYSTS } from "@/lib/admin/lab-data";
import { FieldLabel } from "@/components/lims/common";

export interface AssignTaskResult {
  analystId: string;
  analystName: string;
  note: string;
}

/* S-14 · Drawer «Phân công analysis task» (UC-17, D21) - cùng khuôn với S-05. */
export function AssignTaskDrawer({
  codes,
  open,
  onOpenChange,
  onConfirm,
}: {
  codes: string[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (r: AssignTaskResult) => void;
}) {
  const { usesClerk } = useAuth();
  const api = useApiClient();
  // Danh sách người nhận phụ thuộc chi nhánh của TASK (không phải người gán), nên chỉ scope theo
  // task đầu tiên khi phân công hàng loạt - GET .../{code}/eligible-assignees là route theo task.
  const scopeCode = codes[0];
  const eligible = useQuery({
    queryKey: ["analysis-tasks", "eligible-assignees", scopeCode],
    queryFn: () => labApi.eligibleAssignees(api, scopeCode!),
    enabled: usesClerk && open && Boolean(scopeCode),
  });
  const analystOptions = usesClerk
    ? (eligible.data?.content ?? []).map((a) => ({
        id: a.id,
        name: a.fullName,
        load: `${a.branch.name} · ${a.activeTaskCount} task đang xử lý`,
        state: a.available ? "Sẵn sàng" : "Không khả dụng",
        tone: a.available ? ("success" as const) : ("danger" as const),
        available: a.available,
      }))
    : LAB_ANALYSTS;
  const [analystId, setAnalystId] = useState(analystOptions[0]?.id ?? "");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      setAnalystId(usesClerk ? "" : LAB_ANALYSTS[0]!.id);
      setNote("");
    }
  }, [open, usesClerk]);

  useEffect(() => {
    const first = analystOptions[0];
    if (usesClerk && first && !analystOptions.some((a) => a.id === analystId)) {
      setAnalystId(first.id);
    }
  }, [analystOptions, analystId, usesClerk]);

  const analyst = analystOptions.find((a) => a.id === analystId);

  return (
    <Drawer
      type="overlay"
      position="end"
      separator
      open={open}
      onOpenChange={(_, d) => onOpenChange(d.open)}
      style={{ width: 420 }}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Đóng"
              onClick={() => onOpenChange(false)}
            />
          }
        >
          Phân công task - {codes.length > 1 ? `${codes.length} task` : (codes[0] ?? "")}
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 16 }}>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Phạm vi phòng thử nghiệm:</MessageBarTitle>
              Chỉ nhân sự thuộc Phòng Hoá lý mới nhận được task. Một task chỉ có một người phụ
              trách; hệ thống ghi audit người gán - người nhận - thời điểm.
            </MessageBarBody>
          </MessageBar>

          {codes.length > 1 ? (
            <div className="dlp-datagrid__secondary dlp-num">{codes.join(" · ")}</div>
          ) : null}

          <div>
            <div
              style={{
                font: "600 12px/16px var(--font-family-base)",
                color: "var(--foreground-secondary)",
                marginBottom: 8,
              }}
            >
              Nhân viên phân tích
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {eligible.isError ? (
                <MessageBar intent="error">
                  <MessageBarBody>{apiErrorMessage(eligible.error)}</MessageBarBody>
                </MessageBar>
              ) : null}
              {usesClerk && !analystOptions.length && !eligible.isPending ? (
                <span className="dlp-datagrid__secondary">
                  Không có nhân sự nào giữ quyền nhận task tại chi nhánh của task này.
                </span>
              ) : null}
              {analystOptions.map((a) => {
                const on = a.id === analystId;
                return (
                  <div
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setAnalystId(a.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setAnalystId(a.id);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: 10,
                      border: `1px solid ${on ? "var(--border-accent)" : "var(--border-subtle)"}`,
                      borderRadius: "var(--radius-control)",
                      cursor: "pointer",
                      background: on ? "var(--background-selected)" : "var(--background-surface)",
                    }}
                  >
                    <Radio checked={on} onChange={() => setAnalystId(a.id)} label="" />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ font: "14px/20px var(--font-family-base)" }}>{a.name}</div>
                      <div className="dlp-datagrid__secondary">{a.load}</div>
                    </div>
                    <Badge appearance="tint" size="small" color={toneToColor(a.tone)}>
                      {a.state}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </div>

          <Field
            label={
              <FieldLabel
                label="Lý do đổi người phụ trách"
                tooltip="Bắt buộc khi task đang có người phụ trách; có thể bỏ trống khi phân công task chưa có người."
              />
            }
          >
            <Textarea
              rows={2}
              value={note}
              placeholder="Ví dụ: chạy cùng mẻ với 2610001202VO"
              onChange={(_, d) => setNote(d.value)}
            />
          </Field>
        </div>
      </DrawerBody>

      <DrawerFooter>
        <Button
          appearance="primary"
          disabled={!analyst?.available}
          onClick={() => {
            if (analyst) onConfirm({ analystId, analystName: analyst.name, note });
          }}
        >
          Xác nhận phân công
        </Button>
        <Button onClick={() => onOpenChange(false)}>Huỷ</Button>
      </DrawerFooter>
    </Drawer>
  );
}
