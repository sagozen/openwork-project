import { InlineNotice, LinkButton, LocaleProvider, PageHeader, t } from "@templatedesign/ui";
import { useEffect, useState } from "react";

type Phase = "confirming" | "paid" | "slow" | "failed" | "expired" | "review";

const FIRST_DELAYS = [1000, 2000, 3000, 5000];
const POLL_TIMEOUT_MS = 120_000;

export interface CheckoutReturnProps {
  locale: "en" | "vi";
  /** Defaults to the `payment` query parameter. */
  paymentId?: string;
  /** Shown as a notice inside the landing page instead of a full page. */
  embedded?: boolean;
  /** Fires once the payment is confirmed, so the page can refresh the balance. */
  onPaid?: () => void;
}

/**
 * Result of the hosted checkout. It only reads `GET /checkout-sessions/{id}`;
 * credits are granted by the signed webhook, never by this component.
 */
export function CheckoutReturn({ locale, paymentId: givenId, embedded = false, onPaid }: CheckoutReturnProps) {
  const tr = (key: Parameters<typeof t>[1], values?: Record<string, string | number>) => t(locale, key, values);
  const [phase, setPhase] = useState<Phase>("confirming");
  const [credits, setCredits] = useState(0);

  // Polls once per payment id; `onPaid` is a notification, not an input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: onPaid must not restart polling
  useEffect(() => {
    const paymentId = givenId ?? new URLSearchParams(window.location.search).get("payment");
    if (!paymentId) {
      setPhase("slow");
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const startedAt = Date.now();

    const tick = async () => {
      if (stopped) return;
      try {
        const response = await fetch(`/api/v1/checkout-sessions/${encodeURIComponent(paymentId)}`, {
          headers: { accept: "application/json" },
        });
        if (stopped) return;
        if (response.ok) {
          const body = (await response.json()) as { status?: string; credits?: number };
          if (body.status === "paid") {
            setCredits(body.credits ?? 0);
            setPhase("paid");
            onPaid?.();
            return;
          }
          if (body.status === "failed" || body.status === "expired" || body.status === "review") {
            setPhase(body.status);
            return;
          }
        }
      } catch {
        // Network blips are expected while the provider settles; keep polling.
      }
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
        setPhase("slow");
        return;
      }
      const delay = FIRST_DELAYS[attempt] ?? 5000;
      attempt += 1;
      timer = setTimeout(tick, delay);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [givenId]);

  const message =
    phase === "confirming"
      ? tr("billing.return.confirming")
      : phase === "paid"
        ? tr("billing.return.added", { count: credits })
        : phase === "slow"
          ? tr("billing.return.slow")
          : phase === "review"
            ? tr("billing.return.review")
            : tr("billing.failed");

  if (embedded) {
    const tone = phase === "paid" ? "success" : phase === "confirming" || phase === "slow" ? "info" : "danger";
    return (
      <div aria-live="polite">
        <InlineNotice tone={tone}>{message}</InlineNotice>
      </div>
    );
  }

  return (
    <LocaleProvider locale={locale}>
      <main id="main" className="w-main">
        <PageHeader title={tr("billing.buyTitle")} description={message} />
        <div className="w-card" aria-live="polite">
          <p className="td-muted" role="status">
            {message}
          </p>
          {phase === "paid" || phase === "slow" || phase === "failed" || phase === "expired" ? (
            <LinkButton href="/?account=wallet" variant="primary" size="sm">
              {tr("billing.backToCredits")}
            </LinkButton>
          ) : null}
        </div>
      </main>
    </LocaleProvider>
  );
}
