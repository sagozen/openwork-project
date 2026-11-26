import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Button,
  Field,
  Input,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { portalApi } from "@/features/portal";
import { apiErrorMessage } from "@/lib/api";
import { saveBlob } from "@/features/report";
import { searchString } from "@/lib/route-search";

export const Route = createFileRoute("/tra-cuu")({
  validateSearch: (s: Record<string, unknown>): { code?: string } => ({
    code: searchString(s["code"]) ?? searchString(s["reportCode"]) ?? searchString(s["sampleCode"]),
  }),
  head: () => ({
    meta: [
      { title: "Tra cứu kết quả · Đa Liên Phát" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PublicLookup,
});
interface Turnstile {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  remove: (id: string) => void;
  reset: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}
const sitekey = import.meta.env["VITE_TURNSTILE_SITE_KEY"] as string | undefined;
function PublicLookup() {
  const { code } = Route.useSearch();
  const [input, setInput] = useState(code ?? "");
  const [token, setToken] = useState("");
  const [challengeError, setChallengeError] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!sitekey || !container.current) return;
    let disposed = false;
    const render = () => {
      if (disposed || !container.current || !window.turnstile) return;
      widget.current = window.turnstile.render(container.current, {
        sitekey,
        callback: setToken,
        "expired-callback": () => setToken(""),
        "error-callback": () => {
          setToken("");
          setChallengeError("Không tải được xác minh. Vui lòng tải lại trang.");
        },
      });
    };
    const existing = document.querySelector<HTMLScriptElement>("script[data-dlp-turnstile]");
    if (window.turnstile) render();
    else if (existing) existing.addEventListener("load", render);
    else {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.dataset["dlpTurnstile"] = "true";
      script.async = true;
      script.addEventListener("load", render);
      script.addEventListener("error", () =>
        setChallengeError("Không tải được xác minh. Vui lòng tải lại trang."),
      );
      document.head.appendChild(script);
    }
    return () => {
      disposed = true;
      existing?.removeEventListener("load", render);
      if (widget.current) window.turnstile?.remove(widget.current);
    };
  }, []);
  const lookup = useMutation({
    mutationFn: () => portalApi.lookup(input.trim(), { turnstileToken: token }),
    onSettled: () => {
      setToken("");
      if (widget.current) window.turnstile?.reset(widget.current);
    },
  });
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
  const pdf = useMutation({
    mutationFn: async (disposition: "inline" | "attachment") => {
      if (lookup.data?.status.code !== "VALID" || !lookup.data.pdf) return;
      const blob = await portalApi.pdf(lookup.data.reportCode, disposition, {
        turnstileToken: token,
      });
      if (disposition === "inline") setPreviewUrl(URL.createObjectURL(blob));
      else saveBlob(blob, `${lookup.data.reportCode}.pdf`);
    },
    onSettled: () => {
      setToken("");
      if (widget.current) window.turnstile?.reset(widget.current);
    },
  });
  return (
    <main style={{ maxWidth: 720, margin: "48px auto", padding: 24, display: "grid", gap: 20 }}>
      <h1>Tra cứu kết quả thử nghiệm</h1>
      <p>Nhập mã mẫu hoặc mã phiếu. Kết quả được cung cấp sau khi phát hành.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPreviewUrl(undefined);
          pdf.reset();
          lookup.mutate();
        }}
        style={{ display: "grid", gap: 12 }}
      >
        <Field label="Mã mẫu hoặc mã phiếu" required>
          <Input
            value={input}
            onChange={(_, d) => {
              setInput(d.value);
              lookup.reset();
              setPreviewUrl(undefined);
            }}
            placeholder="26100001 hoặc mã phiếu trên QR"
          />
        </Field>
        <div ref={container} />
        {!sitekey ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              Cổng tra cứu chưa được cấu hình xác minh. Vui lòng liên hệ Đa Liên Phát.
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {challengeError ? <p role="alert">{challengeError}</p> : null}
        <Button
          appearance="primary"
          type="submit"
          disabled={!input.trim() || !token || lookup.isPending}
        >
          Tra cứu
        </Button>
      </form>
      {lookup.isPending ? <Spinner label="Đang tra cứu…" /> : null}
      {lookup.error || pdf.error ? (
        <MessageBar intent="error">
          <MessageBarBody>{apiErrorMessage(lookup.error || pdf.error)}</MessageBarBody>
        </MessageBar>
      ) : null}
      {lookup.data ? (
        <section aria-live="polite">
          {lookup.data.status.code === "VALID" && lookup.data.pdf ? (
            <>
              <h2>{lookup.data.reportCode}</h2>
              <p>
                Đã phát hành{" "}
                {lookup.data.releasedAt
                  ? new Date(lookup.data.releasedAt).toLocaleString("vi-VN")
                  : ""}
              </p>
              <Button disabled={pdf.isPending || !token} onClick={() => pdf.mutate("attachment")}>
                Tải PDF kết quả
              </Button>
              <Button disabled={pdf.isPending || !token} onClick={() => pdf.mutate("inline")}>
                Xem PDF
              </Button>
              <p>Xác minh lại để xem hoặc tải PDF.</p>
              {previewUrl ? (
                <iframe
                  title="PDF kết quả đã phát hành"
                  src={previewUrl}
                  style={{ width: "100%", height: 650, border: 0 }}
                />
              ) : null}
            </>
          ) : lookup.data.status.code === "SUPERSEDED" ? (
            <div>
              <p>Phiếu này đã được thay thế.</p>
              <Button
                onClick={() => {
                  setInput(lookup.data?.currentReportCode ?? "");
                  lookup.reset();
                  pdf.reset();
                  setPreviewUrl(undefined);
                  setToken("");
                  if (widget.current) window.turnstile?.reset(widget.current);
                }}
              >
                Tra cứu phiếu hiện hành: {lookup.data.currentReportCode}
              </Button>
            </div>
          ) : (
            <p>Chưa có kết quả</p>
          )}
          <p>Thời điểm tra cứu: {new Date(lookup.data.queriedAt).toLocaleString("vi-VN")}</p>
          <p>Kết quả đọc trực tiếp từ hệ thống DLP.</p>
          <p>Trang tra cứu không thay thế phiếu có ký tên, đóng dấu.</p>
        </section>
      ) : null}
    </main>
  );
}
