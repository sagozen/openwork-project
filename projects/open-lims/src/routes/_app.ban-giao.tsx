import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button, Field, Input, MessageBar, MessageBarBody } from "@fluentui/react-components";
import { NoAccess } from "@/components/lims/NoAccess";
import { PageHead, useDlpToast } from "@/components/lims/common";
import { HandoverLog } from "@/components/lims/intake/HandoverLog";
import { createHandoverClientWithApi } from "@/features/request/api";
import { createReceptionApi } from "@/features/reception/api/reception-api";
import { handoverContextKeys, sampleKeys } from "@/features/reception/hooks";
import { handoverKeys, invalidateRequestRecords, useHandoverLog } from "@/features/request/hooks";
import { apiErrorMessage, useApiClient } from "@/lib/api";
import { card } from "@/components/lims/request-styles";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { initialHandoverItems } from "@/lib/admin/lab-data";

export const Route = createFileRoute("/_app/ban-giao")({
  head: () => ({
    meta: [{ title: "Bàn giao mẫu vào lab - DLP LIMS" }, { name: "robots", content: "noindex" }],
  }),
  component: HandoverScreen,
});

function HandoverScreen() {
  const { can, usesClerk } = useAuth();
  const api = useApiClient();
  const cache = useQueryClient();
  const toast = useDlpToast();
  const [step, setStep] = useState<"DELIVER" | "RECEIVE">(() =>
    can(PERM.RECEPTION_HANDOVER_DELIVER) ? "DELIVER" : "RECEIVE",
  );
  const [input, setInput] = useState("");
  const [requestCode, setRequestCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [recorded, setRecorded] = useState<Array<{ code: string; step: string; at: string }>>([]);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const log = useHandoverLog(requestCode || undefined, usesClerk && can(PERM.RECEPTION_READ));
  const canWrite = can(
    step === "DELIVER" ? PERM.RECEPTION_HANDOVER_DELIVER : PERM.RECEPTION_HANDOVER_LAB,
  );

  // Chờ ô nhập được mở lại sau khi lưu rồi trả focus cho lượt quét tiếp theo.
  useEffect(() => {
    if (pending || !canWrite) return;
    const scanInput = inputRef.current;
    scanInput?.focus({ preventScroll: true });
    scanInput?.select();
  }, [step, pending, canWrite]);

  async function scan() {
    const scannedCode = input.trim();
    if (!scannedCode || inFlight.current || !canWrite) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      if (
        recorded.some(
          (entry) => entry.code.toLowerCase() === scannedCode.toLowerCase() && entry.step === step,
        )
      ) {
        throw new Error("Mã mẫu đã được ghi nhận ở bước này trong phiên làm việc.");
      }
      if (usesClerk) {
        const reception = createReceptionApi(api);
        const context = await reception.handoverContext(scannedCode);
        const sampleCode = context.scanCodes.find(
          (code) => code.toLowerCase() === scannedCode.toLowerCase(),
        );
        if (!sampleCode)
          throw new Error(
            context.blockedReason || "Quét đúng mã mẫu; không dùng mã hồ sơ hoặc mã mẫu con.",
          );
        if (!context.allowed || context.nextStep.code !== step)
          throw new Error(
            context.blockedReason ||
              `Mẫu đang ở bước «${context.nextStep.name}», không thể ghi nhận bước này.`,
          );
        const client = createHandoverClientWithApi(api);
        await client.create({
          requestCode: context.requestCode,
          step,
          scannedCodes: [sampleCode],
          scanMethod: "QR",
        });
        setRequestCode(context.requestCode);
        await Promise.allSettled([
          cache.invalidateQueries({ queryKey: handoverKeys.all }),
          cache.invalidateQueries({ queryKey: handoverContextKeys.all }),
          cache.invalidateQueries({ queryKey: sampleKeys.all }),
          invalidateRequestRecords(cache),
        ]);
      } else if (!initialHandoverItems().some((sample) => sample.code === scannedCode)) {
        throw new Error("Mã mẫu không thuộc dữ liệu minh hoạ.");
      }
      setRecorded((entries) => [
        { code: scannedCode, step, at: new Date().toLocaleString("vi-VN") },
        ...entries,
      ]);
      setInput("");
      toast(step === "DELIVER" ? "Đã bàn giao mẫu" : "Đã nhận mẫu vào lab", scannedCode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : apiErrorMessage(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  if (!can(PERM.RECEPTION_HANDOVER_DELIVER) && !can(PERM.RECEPTION_HANDOVER_LAB))
    return <NoAccess screen="Bàn giao vào lab" />;
  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 1000 }}>
      <PageHead
        title="Bàn giao vào lab"
        description="Chọn bước giao hoặc nhận rồi quét mã mẫu. Hệ thống ghi người thao tác và thời điểm."
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {(["DELIVER", "RECEIVE"] as const).map((value) => (
          <Button
            key={value}
            appearance={step === value ? "primary" : "secondary"}
            aria-pressed={step === value}
            disabled={
              pending ||
              !can(
                value === "DELIVER" ? PERM.RECEPTION_HANDOVER_DELIVER : PERM.RECEPTION_HANDOVER_LAB,
              )
            }
            onClick={() => {
              setStep(value);
              setError("");
            }}
          >
            {value === "DELIVER" ? "Giao mẫu vào lab" : "Lab nhận mẫu"}
          </Button>
        ))}
      </div>
      <div style={card}>
        <Field
          label="Quét mã mẫu"
          hint="Máy quét nhập mã và Enter để ghi nhận. Mỗi lượt chỉ giao hoặc nhận một mẫu."
        >
          <Input
            ref={inputRef}
            value={input}
            disabled={pending || !canWrite}
            placeholder="26100001"
            onChange={(_, data) => setInput(data.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void scan();
              }
            }}
          />
        </Field>
        <Button
          appearance="primary"
          disabled={pending || !canWrite || !input.trim()}
          onClick={() => void scan()}
          style={{ alignSelf: "flex-start" }}
        >
          {pending
            ? "Đang ghi nhận…"
            : step === "DELIVER"
              ? "Quét và bàn giao"
              : "Quét và nhận vào lab"}
        </Button>
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        ) : null}
      </div>
      <div style={card}>
        <strong>Mẫu đã ghi nhận trong phiên</strong>
        {recorded.length ? (
          recorded.map((entry, index) => (
            <div key={`${entry.code}:${entry.step}:${index}`}>
              {entry.code} · {entry.step === "DELIVER" ? "Đã giao" : "Đã nhận vào lab"} · {entry.at}
            </div>
          ))
        ) : (
          <span>Chưa có mẫu được ghi nhận.</span>
        )}
      </div>
      {usesClerk && requestCode && can(PERM.RECEPTION_READ) ? (
        <div style={card}>
          <HandoverLog entries={log.data} pending={log.isPending} />
        </div>
      ) : null}
    </div>
  );
}
