import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Toast,
  ToastTitle,
  Toaster,
  useId,
  useToastController,
} from "@fluentui/react-components";
import { AdminSettingsShell } from "@/components/lims/AdminSettingsShell";
import { FieldLabel } from "@/components/lims/common";
import { NoAccess } from "@/components/lims/NoAccess";
import { useAdminData } from "@/lib/admin/admin-store";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { usePatchSystemParameter, useSystemParameters } from "@/features/config";
import { apiErrorMessage } from "@/lib/api";

export const Route = createFileRoute("/_app/admin/tham-so")({
  head: () => ({
    meta: [
      { title: "Tham số hệ thống - Quản trị DLP LIMS" },
      {
        name: "description",
        content: "Quy tắc đánh số, hạn lưu mẫu và cấu hình cổng tra cứu.",
      },
    ],
  }),
  component: ParamsScreen,
});

function ParamsScreen() {
  const { can, usesClerk } = useAuth();
  const demo = useAdminData();
  const remote = useSystemParameters();
  const patch = usePatchSystemParameter();
  const toasterId = useId("toaster-params");
  const { dispatchToast } = useToastController(toasterId);
  // Bản nháp của những ô đang gõ dở. Ghi lên máy chủ theo TỪNG PHÍM là sai: mỗi ký tự sẽ thành
  // một lần sửa cấu hình có ghi nhật ký, và giá trị dở dang ("9" trên đường tới "90") sẽ có thật
  // trong khoảnh khắc nào đó. Nên gõ vào nháp, ghi khi rời ô.
  const [draft, setDraft] = useState<Record<string, string>>({});

  const canWrite = can(PERM.CONFIG_MANAGE);

  const params = usesClerk
    ? (remote.data?.parameters ?? []).map((p) => ({
        id: p.key,
        key: p.key,
        label: p.label,
        value: p.value ?? "",
        group: p.group,
        hint: p.hint,
      }))
    : demo.params;

  const commit = (key: string, value: string, original: string) => {
    setDraft((prev) => {
      const { [key]: _dropped, ...rest } = prev;
      return rest;
    });
    if (value === original) return;
    if (!usesClerk) {
      demo.updateParam(key, value);
      return;
    }
    patch.mutate(
      { key, value },
      {
        onSuccess: () =>
          dispatchToast(
            <Toast>
              <ToastTitle>Đã lưu tham số</ToastTitle>
            </Toast>,
            { intent: "success" },
          ),
        onError: (error) =>
          dispatchToast(
            <Toast>
              <ToastTitle>{apiErrorMessage(error, "Không lưu được tham số.")}</ToastTitle>
            </Toast>,
            { intent: "error" },
          ),
      },
    );
  };

  if (!can(PERM.USER_MANAGE)) return <NoAccess screen="Tham số hệ thống" />;

  const groups = [...new Set(params.map((p) => p.group))];

  return (
    <>
      <Toaster toasterId={toasterId} position="bottom-end" />
      <AdminSettingsShell code="A-12">
        <div style={{ display: "grid", gap: 12 }}>
          {usesClerk && remote.isLoading ? <Spinner label="Đang tải tham số..." /> : null}
          {usesClerk && remote.error ? (
            <MessageBar intent="error">
              <MessageBarBody>
                {apiErrorMessage(remote.error, "Không tải được tham số hệ thống.")}
              </MessageBarBody>
            </MessageBar>
          ) : null}
          {groups.map((group) => (
            <section key={group} className="dlp-card" style={{ padding: 16 }}>
              <h2
                style={{
                  margin: "0 0 12px",
                  fontSize: "var(--font-size-400)",
                  fontWeight: 600,
                }}
              >
                {group}
              </h2>
              <div
                style={{
                  display: "grid",
                  gap: 16,
                  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                }}
              >
                {params
                  .filter((p) => p.group === group)
                  .map((p) => (
                    <Field key={p.id} label={<FieldLabel label={p.label} tooltip={p.hint} />}>
                      <Input
                        value={draft[p.id] ?? p.value}
                        disabled={!canWrite || patch.isPending}
                        onChange={(_, d) => setDraft((prev) => ({ ...prev, [p.id]: d.value }))}
                        onBlur={(event) => commit(p.id, event.target.value, p.value)}
                      />
                    </Field>
                  ))}
              </div>
            </section>
          ))}
        </div>
      </AdminSettingsShell>
    </>
  );
}
