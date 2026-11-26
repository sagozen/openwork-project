import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from "@fluentui/react-components";
import { useEffect, useRef } from "react";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";

function QrFrame({ seed }: { seed: string }) {
  const cells = Array.from(
    { length: 36 },
    (_, i) => (seed.charCodeAt(i % seed.length) + i * 5) % 3 === 0,
  );
  return (
    <div
      aria-hidden
      style={{
        width: 96,
        height: 96,
        display: "grid",
        gridTemplateColumns: "repeat(6,1fr)",
        gridTemplateRows: "repeat(6,1fr)",
        background: "var(--background-card)",
        border: "1px solid var(--border-subtle)",
        padding: 6,
      }}
    >
      {cells.map((on, i) => (
        <div key={i} style={{ background: on ? "var(--foreground-primary)" : "transparent" }} />
      ))}
    </div>
  );
}

export interface ScanMessage {
  tone: "success" | "warning" | "error" | "info";
  title: string;
  body: string;
}

/* S-09 · Khung quét QR tem nội bộ khi bàn giao mẫu vào lab. */
export function HandoverScanCard({
  title,
  hint,
  value,
  seed,
  message,
  disabled,
  resolving,
  allowParentScan,
  onChange,
  onScan,
  onScanParent,
}: {
  title: string;
  hint: string;
  value: string;
  seed: string;
  message?: ScanMessage | null;
  disabled?: boolean;
  resolving?: boolean;
  allowParentScan?: boolean;
  onChange: (v: string) => void;
  onScan: () => void;
  onScanParent: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!disabled && !resolving && !value) inputRef.current?.focus();
  }, [disabled, resolving, value]);
  return (
    <div style={card}>
      <div style={sectionTitle}>{title}</div>

      <div
        style={{
          border: "1px dashed var(--border-default)",
          borderRadius: "var(--radius-surface)",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          background: "var(--background-subtle)",
        }}
      >
        <QrFrame seed={seed} />
        <span style={{ ...hintText, textAlign: "center" }}>{hint}</span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <Field label="Hoặc nhập mã tem">
            <Input
              ref={inputRef}
              value={value}
              disabled={disabled || resolving}
              placeholder="2610001201"
              onChange={(_, d) => onChange(d.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onScan();
                }
              }}
            />
          </Field>
        </div>
        <Button
          appearance="primary"
          disabled={disabled || resolving || !value.trim()}
          onClick={onScan}
        >
          {resolving ? "Đang nhận diện…" : "Quét"}
        </Button>
      </div>

      {/* Nút đứng TRÊN thông báo: thông báo hiện/mất sau mỗi lượt quét, để nó chen vào giữa thì
          nút bị đẩy xuống ngay lúc người ta đang bấm liên tiếp - đúng cái làm bấm trượt nút. */}
      {allowParentScan ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button size="small" disabled={!!disabled} onClick={onScanParent}>
            Quét mã cha (cả lô)
          </Button>
        </div>
      ) : null}

      {message ? (
        <MessageBar intent={message.tone}>
          <MessageBarBody>
            <MessageBarTitle>{message.title}</MessageBarTitle>
            {message.body}
          </MessageBarBody>
        </MessageBar>
      ) : null}
    </div>
  );
}
