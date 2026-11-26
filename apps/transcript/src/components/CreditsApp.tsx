import type { LedgerRow, Wallet } from "@templatedesign/platform/credits";
import { formatDate, formatDateTime } from "@templatedesign/platform/format";
import {
  AppShell,
  Button,
  Dialog,
  InlineNotice,
  LinkButton,
  LocaleProvider,
  PageHeader,
  PricingPack,
  ToastProvider,
  t,
} from "@templatedesign/ui";
import { useEffect, useRef, useState } from "react";
import { appNav } from "../lib/app-nav";
import { packSummary } from "../lib/packs";
import { PRICING } from "../lib/pricing-core";
import type { AuthUser, Profile } from "../lib/types";

interface PaymentSummary {
  id: string;
  created_at: string;
  pack_id: string;
  credits: number;
  amount_cents: number;
  tax_cents: number | null;
  total_cents: number | null;
  currency: string;
  status: string;
  refunded_cents: number;
}

type CheckoutError = "paused" | "unverified" | "rate_limited" | "unknown" | null;

const RECEIPT_STATUSES = new Set(["paid", "refunded", "partially_refunded", "chargeback"]);

function usd(cents: number | null, locale: "en" | "vi"): string {
  if (cents === null) return "—";
  return new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
}

function CreditsInner({
  locale,
  user,
  profile,
  wallet,
  ledger,
  credits,
  csrfToken,
  embedded = false,
}: {
  locale: "en" | "vi";
  user: AuthUser;
  profile: Profile;
  wallet: Wallet;
  ledger: LedgerRow[];
  credits: number;
  csrfToken: string;
  embedded?: boolean;
}) {
  const tr = (key: Parameters<typeof t>[1], values?: Record<string, string | number>) => t(locale, key, values);
  const packs = packSummary(locale, PRICING.creditsPerMinute);
  const [selected, setSelected] = useState<(typeof packs)[number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CheckoutError>(null);
  const [cancelled, setCancelled] = useState(false);
  const [payments, setPayments] = useState<PaymentSummary[] | null>(null);
  // One key per dialog open, reused on retries of the same intent.
  const idempotencyKey = useRef<string | null>(null);

  function openPack(pack: (typeof packs)[number]) {
    idempotencyKey.current = crypto.randomUUID();
    setError(null);
    setSelected(pack);
  }

  /* biome-ignore lint/correctness/useExhaustiveDependencies: preselect + fetch once on mount; packs are static */
  useEffect(() => {
    // On the landing page the query string belongs to the page (the top-up popup shows the notice).
    if (!embedded) {
      const params = new URLSearchParams(window.location.search);
      setCancelled(params.get("checkout") === "cancelled");
      const requested = params.get("pack");
      if (requested) {
        const pack = packs.find((candidate) => candidate.id === requested);
        if (pack) openPack(pack);
      }
    }
    fetch("/api/v1/payments")
      .then((response) => (response.ok ? response.json() : { data: [] }))
      .then((body) => setPayments((body as { data?: PaymentSummary[] }).data ?? []))
      .catch(() => setPayments([]));
    // Runs once: the query string and the first pack list are enough to preselect the dialog.
  }, []);

  async function startCheckout() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    // One key per dialog open: a retry after a network error must not charge twice.
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    const key = idempotencyKey.current;
    try {
      const response = await fetch("/api/v1/checkout-sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
          "idempotency-key": key,
        },
        body: JSON.stringify({ pack_id: selected.id }),
      });
      if (response.status === 201) {
        const body = (await response.json()) as { url?: string };
        if (body.url) {
          window.location.assign(body.url);
          return;
        }
      }
      if (response.status === 403) {
        const body = (await response.json()) as { details?: { reason?: string } };
        setError(body.details?.reason === "email_unverified" ? "unverified" : "unknown");
      } else if (response.status === 429) {
        setError("rate_limited");
      } else if (response.status === 503) {
        setError("paused");
      } else {
        setError("unknown");
      }
    } catch {
      setError("unknown");
    } finally {
      setBusy(false);
    }
  }

  const errorCopy =
    error === "paused"
      ? tr("billing.checkoutPaused")
      : error === "unverified"
        ? tr("billing.verifyEmail")
        : error === "rate_limited"
          ? tr("billing.tooMany")
          : error === "unknown"
            ? tr("billing.checkoutError")
            : null;

  const content = (
    <>
      {cancelled ? (
        <InlineNotice tone="info" title={tr("billing.cancelled")}>
          {tr("billing.oneTime")}
        </InlineNotice>
      ) : null}

      <div className="g-grid g-grid--4">
        <div className="w-card">
          <p className="td-field__label">{tr("billing.available")}</p>
          <p className="td-stat">{wallet.available}</p>
          <p className="td-field__hint">{tr("credit.available", { count: wallet.available })}</p>
        </div>
        <div className="w-card">
          <p className="td-field__label">{tr("billing.freeThisMonth")}</p>
          <p className="td-stat">{wallet.free}</p>
          <p className="td-field__hint">{tr("billing.reset", { date: formatDate(wallet.freeResetAt, locale) })}</p>
        </div>
        <div className="w-card">
          <p className="td-field__label">{locale === "vi" ? "Credit đã mua" : "Purchased"}</p>
          <p className="td-stat">{wallet.purchased}</p>
          <p className="td-field__hint">{locale === "vi" ? "Có giá trị 24 tháng" : "Valid for 24 months"}</p>
        </div>
        <div className="w-card">
          <p className="td-field__label">{tr("billing.reserved")}</p>
          <p className="td-stat">{wallet.reserved}</p>
          <p className="td-field__hint">{tr("billing.reservedNote")}</p>
        </div>
      </div>

      <section className="w-section" aria-labelledby="credit-packs">
        <div className="w-row w-row--between">
          <h2 id="credit-packs">{tr("billing.packs")}</h2>
          <span className="td-field__hint">{tr("billing.oneTime")}</span>
        </div>
        <div className="g-grid g-grid--3">
          {packs.map((pack) => (
            <PricingPack
              key={pack.id}
              name={pack.name}
              credits={pack.credits}
              price={pack.price}
              perPage={
                locale === "vi"
                  ? `${pack.perMinute} USD mỗi phút · ${pack.minutes} phút`
                  : `${pack.perMinute} USD per minute · ${pack.minutes} minutes`
              }
              featured={pack.featured}
              onSelect={() => openPack(pack)}
            />
          ))}
        </div>
      </section>

      <section className="w-section" aria-labelledby="history-title">
        <h2 id="history-title">{tr("billing.history")}</h2>
        {payments === null ? (
          <p className="td-muted">{tr("common.loading")}</p>
        ) : payments.length === 0 ? (
          <p className="td-muted">{tr("billing.noPayments")}</p>
        ) : (
          <div className="td-table-wrap">
            <table className="td-table td-table--dense">
              <caption className="td-visually-hidden">{tr("billing.history")}</caption>
              <thead>
                <tr>
                  <th scope="col">{tr("billing.colDate")}</th>
                  <th scope="col">{tr("billing.colPack")}</th>
                  <th scope="col">{tr("billing.colCredits")}</th>
                  <th scope="col">{tr("billing.colAmount")}</th>
                  <th scope="col">{tr("billing.colTax")}</th>
                  <th scope="col">{tr("billing.colTotal")}</th>
                  <th scope="col">{tr("billing.colStatus")}</th>
                  <th scope="col">{tr("billing.receipts")}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{formatDateTime(payment.created_at, locale)}</td>
                    <td>{payment.pack_id}</td>
                    <td className="td-table__numeric">{payment.credits.toLocaleString()}</td>
                    <td className="td-table__numeric">{usd(payment.amount_cents, locale)}</td>
                    <td className="td-table__numeric">{usd(payment.tax_cents, locale)}</td>
                    <td className="td-table__numeric">{usd(payment.total_cents, locale)}</td>
                    <td>{tr(`billing.status.${payment.status}` as Parameters<typeof t>[1])}</td>
                    <td>
                      {RECEIPT_STATUSES.has(payment.status) ? (
                        <a href={`/api/v1/payments/${payment.id}/receipt`} target="_blank" rel="noreferrer">
                          {tr("billing.invoice")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="w-section" aria-labelledby="ledger-title">
        <h2 id="ledger-title">{tr("billing.ledger")}</h2>
        {ledger.length === 0 ? (
          <p className="td-muted">{locale === "vi" ? "Chưa có giao dịch credit." : "No credit events yet."}</p>
        ) : (
          <div className="td-table-wrap">
            <table className="td-table td-table--dense">
              <caption className="td-visually-hidden">{tr("billing.ledger")}</caption>
              <thead>
                <tr>
                  <th scope="col">{locale === "vi" ? "Thời điểm" : "When"}</th>
                  <th scope="col">{locale === "vi" ? "Loại" : "Event"}</th>
                  <th scope="col" className="td-table__numeric">
                    {tr("credit.label")}
                  </th>
                  <th scope="col">{locale === "vi" ? "Nguồn" : "Source"}</th>
                  <th scope="col">Job</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.created_at, locale)}</td>
                    <td>{tr(`billing.kind.${row.kind}` as Parameters<typeof t>[1])}</td>
                    <td className="td-table__numeric">{row.credits > 0 ? `+${row.credits}` : row.credits}</td>
                    <td>{row.source}</td>
                    <td>
                      {row.job_id ? (
                        <LinkButton href={`/?job=${row.job_id}`} variant="tertiary" size="sm">
                          {row.job_id.slice(0, 12)}…
                        </LinkButton>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={tr("billing.buyTitle")}
        description={tr("billing.buyIntro")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSelected(null)}>
              {tr("common.close")}
            </Button>
            <Button variant="primary" onClick={startCheckout} disabled={busy}>
              {busy ? tr("common.loading") : tr("billing.continueToPayment")}
            </Button>
          </>
        }
      >
        {selected ? (
          <p className="td-muted">
            {selected.name} · {selected.credits.toLocaleString()} credits · {selected.price} USD
          </p>
        ) : null}
        {wallet.available < (selected?.credits ?? 0) ? (
          <p className="td-field__hint">
            {tr("billing.needMore", { needed: selected?.credits ?? 0, available: wallet.available })}
          </p>
        ) : null}
        <p className="td-field__hint">{tr("billing.taxNote")}</p>
        {errorCopy ? (
          <p className="td-field__hint" role="alert">
            {errorCopy}
            {error === "unverified" ? (
              <>
                {" "}
                <a href="/?account=settings">{tr("nav.settings")}</a>
              </>
            ) : null}
          </p>
        ) : null}
      </Dialog>
    </>
  );

  if (embedded) {
    return (
      <div className="ta-account">
        <p className="ta-account__actions">
          <a className="td-btn td-btn--secondary td-btn--sm" href="/api/v1/wallet/export">
            {locale === "vi" ? "Xuất CSV" : "Export CSV"}
          </a>
        </p>
        {content}
      </div>
    );
  }

  return (
    <AppShell
      brandName="TranscriptAnything"
      brandMark="TA"
      nav={appNav(locale)}
      currentPath="/app/credits"
      credits={credits}
      locale={profile.uiLanguage}
      accountName={profile.displayName || user.name || user.email}
    >
      <PageHeader
        title={tr("billing.title")}
        description={
          locale === "vi"
            ? "3 credit mỗi phút đã bắt đầu. Media tối đa 3 phút không cần credit."
            : "3 credits per started minute. Media up to 3 minutes needs no credits at all."
        }
        actions={
          <a className="td-btn td-btn--secondary td-btn--sm" href="/api/v1/wallet/export">
            {locale === "vi" ? "Xuất CSV" : "Export CSV"}
          </a>
        }
      />
      {content}
    </AppShell>
  );
}

export function CreditsApp(props: {
  locale: "en" | "vi";
  user: AuthUser;
  profile: Profile;
  wallet: Wallet;
  ledger: LedgerRow[];
  credits: number;
  csrfToken: string;
  /** Content only, for the account popups on the landing page. */
  embedded?: boolean;
}) {
  return (
    <LocaleProvider locale={props.locale}>
      <ToastProvider>
        <CreditsInner {...props} />
      </ToastProvider>
    </LocaleProvider>
  );
}
