/* Hộp thoại gửi yêu cầu: Lỗi phần mềm · Hỗ trợ sử dụng · Đề xuất tính năng. */
import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Textarea,
} from "@fluentui/react-components";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useSupportStore } from "@/lib/support/support-store";
import {
  SUPPORT_SCREENS,
  TICKET_KIND_TEXT,
  TICKET_PRIORITY_TEXT,
  type TicketKind,
  type TicketPriority,
} from "@/lib/support/support-data";
import { FieldLabel, FileDropField, useDlpToast } from "@/components/lims/common";

const KINDS: TicketKind[] = ["bug", "help", "feature"];
const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

export function NewTicketDialog({
  open,
  onOpenChange,
  defaultKind = "help",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultKind?: TicketKind;
  onCreated?: (id: string) => void;
}) {
  const { user } = useAuth();
  const { createTicket } = useSupportStore();
  const toast = useDlpToast();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const [kind, setKind] = useState<TicketKind>(defaultKind);
  const [title, setTitle] = useState("");
  const [screen, setScreen] = useState("other");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [body, setBody] = useState("");
  const [steps, setSteps] = useState("");
  const [benefit, setBenefit] = useState("");
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    if (open) setKind(defaultKind);
  }, [open, defaultKind]);

  const context = `${pathname} · ${user?.role ?? "-"} · ${user?.branch ?? "-"} · phiên bản 2026.08`;
  const screenLabel =
    SUPPORT_SCREENS.find((s) => s.key === screen)?.label ?? "Khác / không rõ màn hình";

  const reset = () => {
    setTitle("");
    setBody("");
    setSteps("");
    setBenefit("");
    setFiles([]);
    setScreen("other");
    setPriority("normal");
  };

  const submit = () => {
    if (!title.trim() || !body.trim()) {
      toast("Thiếu thông tin", "Nhập tiêu đề và mô tả trước khi gửi.", "warning");
      return;
    }
    const ticket = createTicket({
      kind,
      title: title.trim(),
      screen,
      priority,
      body: body.trim(),
      ...(kind === "bug" && steps.trim() ? { steps: steps.trim() } : {}),
      ...(kind === "feature" && benefit.trim() ? { benefit: benefit.trim() } : {}),
      attachments: files,
      context,
    });
    reset();
    onOpenChange(false);
    toast("Đã gửi yêu cầu", `${ticket.id} · ${TICKET_KIND_TEXT[kind]}`);
    onCreated?.(ticket.id);
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>Gửi yêu cầu tới đội hỗ trợ</DialogTitle>
          <DialogContent>
            <div style={{ display: "grid", gap: 14, paddingTop: 4 }}>
              <Field label="Loại yêu cầu">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {KINDS.map((k) => (
                    <Button
                      key={k}
                      appearance={kind === k ? "primary" : "secondary"}
                      onClick={() => setKind(k)}
                    >
                      {TICKET_KIND_TEXT[k]}
                    </Button>
                  ))}
                </div>
              </Field>

              <Field label="Tiêu đề" required>
                <Input
                  value={title}
                  onChange={(_, d) => setTitle(d.value)}
                  placeholder="Mô tả ngắn gọn vấn đề hoặc đề xuất"
                />
              </Field>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Màn hình liên quan">
                  <Dropdown
                    value={screenLabel}
                    selectedOptions={[screen]}
                    onOptionSelect={(_, d) => setScreen(d.optionValue ?? "other")}
                  >
                    {SUPPORT_SCREENS.map((s) => (
                      <Option key={s.key} value={s.key} text={s.label}>
                        {s.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Mức độ ảnh hưởng">
                  <Dropdown
                    value={TICKET_PRIORITY_TEXT[priority]}
                    selectedOptions={[priority]}
                    onOptionSelect={(_, d) =>
                      setPriority((d.optionValue as TicketPriority) ?? "normal")
                    }
                  >
                    {PRIORITIES.map((p) => (
                      <Option key={p} value={p} text={TICKET_PRIORITY_TEXT[p]}>
                        {TICKET_PRIORITY_TEXT[p]}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>

              <Field label="Mô tả chi tiết" required>
                <Textarea
                  value={body}
                  onChange={(_, d) => setBody(d.value)}
                  resize="vertical"
                  rows={4}
                  placeholder="Điều gì đang xảy ra, bạn mong đợi kết quả thế nào?"
                />
              </Field>

              {kind === "bug" ? (
                <Field label="Các bước tái hiện">
                  <Textarea
                    value={steps}
                    onChange={(_, d) => setSteps(d.value)}
                    resize="vertical"
                    rows={3}
                    placeholder={"1. Mở màn…\n2. Bấm…\n3. Kết quả nhận được…"}
                  />
                </Field>
              ) : null}

              {kind === "feature" ? (
                <Field label="Lợi ích mong đợi">
                  <Textarea
                    value={benefit}
                    onChange={(_, d) => setBenefit(d.value)}
                    resize="vertical"
                    rows={3}
                    placeholder="Tính năng này giúp tiết kiệm thời gian hoặc giảm sai sót ra sao?"
                  />
                </Field>
              ) : null}

              <Field
                label={
                  <FieldLabel
                    label="Đính kèm ảnh / tệp"
                    tooltip={
                      files.length ? files.join(", ") : "Ảnh chụp màn hình giúp xử lý nhanh hơn."
                    }
                  />
                }
              >
                <FileDropField
                  accept="image/jpeg,image/png,application/pdf"
                  multiple
                  compact
                  idle="Thêm ảnh chụp màn hình hoặc tài liệu (JPEG · PNG · PDF)"
                  selected={files.length ? `${files.length} tệp đã chọn` : undefined}
                  buttonLabel={files.length ? "Chọn lại" : "Chọn tệp"}
                  onFiles={(selectedFiles) => setFiles(selectedFiles.map((file) => file.name))}
                />
              </Field>

              <Field label="Ngữ cảnh tự đính kèm">
                <Input value={context} readOnly appearance="filled-darker" />
              </Field>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              Huỷ
            </Button>
            <Button appearance="primary" onClick={submit}>
              Gửi yêu cầu
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
