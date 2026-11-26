import { Dialog, LocaleProvider, QuotaBadge, SiteBar, TopupDialog, type TopupPack } from "@templatedesign/ui";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_STATE,
  type HomeState,
  homeStateHref,
  isPrivateState,
  type AccountPanel as Panel,
  readHomeState,
} from "../lib/home-state";
import type { OwnedJob } from "../lib/job-access";
import { PRICING } from "../lib/pricing-core";
import type { AuthUser, Profile } from "../lib/types";
import { CheckoutReturn } from "./CheckoutReturn.js";
import { JobPanel } from "./JobPanel.js";
import { NewTranscriptForm } from "./NewTranscriptForm.js";
import { SignInForm } from "./SignInForm.js";

const AccountPanel = lazy(() => import("./AccountPanel.js"));

/** A pasted link survives the trip to the payment provider, so "Top up and transcribe" can resume. */
const RESUME_KEY = "ta:resume-link";

export interface HomeAppProps {
  locale: "en" | "vi";
  csrfToken: string;
  /** Present when signed in. */
  account: { user: AuthUser; profile: Profile } | null;
  credits: number;
  initialState: HomeState;
  /** Server-rendered job for `initialState.job`: `null` when it is not the visitor's. */
  initialJob?: OwnedJob | null;
  presetSource: string;
  turnstileSiteKey?: string;
  googleEnabled: boolean;
  packs: TopupPack[];
}

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * The landing page's interactive part: header, the tool, the result and every popup. All of it
 * is driven by the query string, so each state has a URL and the back button moves between them.
 */
export function HomeApp({
  locale,
  csrfToken,
  account,
  credits: initialCredits,
  initialState,
  initialJob,
  presetSource,
  turnstileSiteKey,
  googleEnabled,
  packs,
}: HomeAppProps) {
  const vi = locale === "vi";
  const signedIn = Boolean(account);
  const [state, setState] = useState<HomeState>(initialState);
  const stateRef = useRef(state);
  const [credits, setCredits] = useState(initialCredits);
  const [preset, setPreset] = useState(presetSource);
  const [mounted, setMounted] = useState(false);

  const show = useCallback((next: HomeState, mode: "push" | "replace" = "push") => {
    stateRef.current = next;
    setState(next);
    const href = homeStateHref(next);
    if (href === currentHref()) return;
    if (mode === "push") window.history.pushState(null, "", href);
    else window.history.replaceState(null, "", href);
  }, []);
  const go = useCallback((patch: Partial<HomeState>) => show({ ...stateRef.current, ...patch }), [show]);

  const refreshCredits = useCallback(async () => {
    if (!signedIn) return;
    try {
      const response = await fetch("/api/v1/wallet", { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const body = (await response.json()) as { wallet: { available: number } };
      setCredits(body.wallet.available);
    } catch {
      // The badge keeps the last known balance; the next settle event retries.
    }
  }, [signedIn]);

  // Back/forward, and same-page state links anywhere on the page (recent jobs, packs, account links).
  useEffect(() => {
    setMounted(true);
    const onPop = () => {
      const next = readHomeState(new URLSearchParams(window.location.search));
      stateRef.current = next;
      setState(next);
    };
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== "/" || !isPrivateState(url.searchParams)) return;
      event.preventDefault();
      const next = readHomeState(url.searchParams);
      show(next);
      if (next.job) window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, [show]);

  // Resume the link that was pasted before "Top up and transcribe".
  useEffect(() => {
    if (!initialState.payment) return;
    try {
      const link = window.sessionStorage.getItem(RESUME_KEY);
      if (link) {
        window.sessionStorage.removeItem(RESUME_KEY);
        setPreset(link);
      }
    } catch {
      // Storage can be blocked; the visitor pastes the link again.
    }
  }, [initialState.payment]);

  // States that need an account send a signed-out visitor to sign-in, then back to the same state.
  useEffect(() => {
    if (signedIn) {
      if (!state.signin) return;
      if (state.next !== "/") window.location.replace(state.next);
      else show({ ...state, signin: false, next: "/" }, "replace");
      return;
    }
    if (state.account) {
      show(
        { ...EMPTY_STATE, signin: true, next: homeStateHref({ ...EMPTY_STATE, account: state.account }) },
        "replace",
      );
    }
  }, [signedIn, state, show]);

  const openTopUp = (link: string | null) => {
    if (link) {
      try {
        window.sessionStorage.setItem(RESUME_KEY, link);
      } catch {
        // Not fatal: only the resume convenience is lost.
      }
    }
    go({ topup: true, cancelled: false });
  };

  const accountTitle: Record<Panel, string> = {
    wallet: vi ? "Ví và nạp credit" : "Wallet and top-up",
    api: vi ? "Khóa API và webhook" : "API keys and webhooks",
    settings: vi ? "Cài đặt" : "Settings",
  };
  const minutes = Math.floor(Math.max(0, credits) / PRICING.creditsPerMinute);

  return (
    <LocaleProvider locale={locale}>
      <SiteBar
        locale={locale}
        brand={{ seal: "TA", name: "TranscriptAnything" }}
        localeHref={(next) => `/api/v1/locale?to=${next}`}
        signedIn={signedIn}
        email={account?.user.email}
        onSignIn={() => go({ signin: true, next: "/" })}
        onAccount={(item) => go({ account: item })}
      />

      <section className="ta-hero" aria-labelledby="hero-title">
        <div className="ta-hero__inner">
          <h1 id="hero-title" className="ta-hero__title">
            {vi ? "Biến mọi liên kết thành " : "Turn any link into a "}
            <em>{vi ? "bản ghi" : "transcript"}</em>.
          </h1>
          <p className="ta-hero__subtitle">
            {vi
              ? "Dán liên kết hoặc tải tệp lên. Dưới 3 phút miễn phí."
              : "Paste a link or upload a file. Under 3 minutes is free."}
          </p>

          {state.payment ? (
            <div className="ta-hero__notice">
              <CheckoutReturn locale={locale} paymentId={state.payment} embedded onPaid={() => void refreshCredits()} />
            </div>
          ) : null}

          <div className="ta-hero__form">
            {state.job ? (
              <JobPanel
                key={state.job}
                locale={locale}
                jobId={state.job}
                initial={initialJob !== undefined && state.job === initialState.job ? initialJob : undefined}
                credits={credits}
                onNew={() => go({ job: null })}
                onSettled={() => void refreshCredits()}
              />
            ) : (
              <NewTranscriptForm
                key={preset}
                locale={locale}
                signedIn={signedIn}
                credits={credits}
                csrfToken={csrfToken}
                presetSource={preset}
                variant="hero"
                maxUploadMb={signedIn ? PRICING.maxUploadMbPaid : PRICING.maxUploadMbFree}
                turnstileSiteKey={turnstileSiteKey}
                onStarted={(jobId) => {
                  go({ job: jobId, payment: null });
                  void refreshCredits();
                }}
                onTopUp={openTopUp}
                onSignIn={() => go({ signin: true, next: "/" })}
              />
            )}
          </div>

          {signedIn ? (
            <div className="ta-hero__quota">
              <QuotaBadge
                credits={credits}
                hint={vi ? `khoảng ${minutes} phút` : `about ${minutes} min`}
                onTopUp={() => openTopUp(null)}
              />
            </div>
          ) : null}
        </div>
      </section>

      <TopupDialog
        open={state.topup}
        onClose={() => go({ topup: false, cancelled: false })}
        packs={packs}
        csrfToken={csrfToken}
        signedIn={signedIn}
        onSignIn={() => go({ topup: false, cancelled: false, signin: true, next: "/?topup=1" })}
        cancelled={state.cancelled}
      />

      <Dialog
        open={state.signin && !signedIn}
        onClose={() => go({ signin: false, next: "/" })}
        title={vi ? "Đăng nhập" : "Sign in"}
        description={vi ? "Không cần mật khẩu." : "No password needed."}
        size="sm"
      >
        <SignInForm variant="inline" locale={locale} next={state.next} googleEnabled={googleEnabled} />
      </Dialog>

      {account ? (
        <Dialog
          open={Boolean(state.account)}
          onClose={() => go({ account: null })}
          title={state.account ? accountTitle[state.account] : ""}
          size="full"
        >
          {mounted && state.account ? (
            <Suspense fallback={<p className="ta-muted">{vi ? "Đang tải…" : "Loading…"}</p>}>
              <AccountPanel
                panel={state.account}
                locale={locale}
                user={account.user}
                profile={account.profile}
                csrfToken={csrfToken}
                credits={credits}
              />
            </Suspense>
          ) : null}
        </Dialog>
      ) : null}
    </LocaleProvider>
  );
}
