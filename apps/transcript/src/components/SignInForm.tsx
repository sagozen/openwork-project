import { safeNext } from "@templatedesign/platform/legacy-redirects";
import { Button, Field, InlineNotice, type Locale, LocaleProvider, TextInput, t } from "@templatedesign/ui";
import { useState } from "react";

export interface SignInFormProps {
  locale: Locale;
  /** Same-origin path to return to after sign-in; anything else falls back to `/`. */
  next?: string;
  googleEnabled: boolean;
  /** `inline` drops the page chrome so the form fits in a popup on the landing page. */
  variant?: "page" | "inline";
}

export function SignInForm({ locale, next, googleEnabled, variant = "page" }: SignInFormProps) {
  const vi = locale === "vi";
  const callbackURL = safeNext(next);
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"google" | "email" | null>(null);

  const readError = async (response: Response) => {
    const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
    return body.message ?? body.code ?? (vi ? "Đã có lỗi. Hãy thử lại." : "Something went wrong. Try again.");
  };

  const google = async () => {
    setBusy("google");
    setError(undefined);
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { url?: string };
      if (!body.url) throw new Error(vi ? "Google chưa được cấu hình." : "Google sign-in is not configured.");
      window.location.href = body.url;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Google sign-in failed.");
      setBusy(null);
    }
  };

  const magicLink = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setBusy("email");
    setError(undefined);
    try {
      const response = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, callbackURL }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setSentTo(email);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : vi ? "Không gửi được liên kết." : "We couldn't send the link.",
      );
    } finally {
      setBusy(null);
    }
  };

  const form = sentTo ? (
    <InlineNotice tone="success" title={vi ? "Kiểm tra email" : "Check your email"}>
      {vi
        ? `Đã gửi liên kết đăng nhập tới ${sentTo}. Liên kết hết hạn sau 15 phút.`
        : `We sent a sign-in link to ${sentTo}. It expires in 15 minutes.`}
    </InlineNotice>
  ) : (
    <>
      {error ? (
        <div className="w-auth__notice">
          <InlineNotice tone="danger">{error}</InlineNotice>
        </div>
      ) : null}

      {googleEnabled ? (
        <>
          <Button variant="secondary" size="lg" fullWidth onClick={google} loading={busy === "google"}>
            {vi ? "Tiếp tục với Google" : "Continue with Google"}
          </Button>
          <div className="w-auth__divider" aria-hidden="true">
            <span>{vi ? "hoặc" : "or"}</span>
          </div>
        </>
      ) : null}

      <form onSubmit={magicLink} noValidate>
        <Field label="Email" required>
          {(props) => (
            <TextInput
              {...props}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" fullWidth loading={busy === "email"}>
          {vi ? "Gửi liên kết đăng nhập" : "Email me a sign-in link"}
        </Button>
      </form>

      <p className="w-auth__fineprint">
        {vi ? "Khi tiếp tục, bạn đồng ý với " : "By continuing you agree to the "}
        <a href="/legal#terms">{vi ? "Điều khoản" : "Terms"}</a>
        {vi ? " và " : " and "}
        <a href="/legal#privacy">{vi ? "Chính sách quyền riêng tư" : "Privacy notice"}</a>.
      </p>
    </>
  );

  if (variant === "inline") return <LocaleProvider locale={locale}>{form}</LocaleProvider>;

  return (
    <LocaleProvider locale={locale}>
      <main id="main" className="w-auth">
        <div className="w-auth__card">
          <a className="td-logo" href="/">
            <span className="td-logo__seal" aria-hidden="true">
              TA
            </span>
            <span className="td-logo__word">TranscriptAnything</span>
          </a>
          <h1>{vi ? "Đăng nhập để lưu bản ghi" : "Sign in to keep your transcripts"}</h1>
          {form}
          <a className="w-auth__back" href="/">
            ← {t(locale, "common.back")}
          </a>
        </div>
      </main>
    </LocaleProvider>
  );
}
