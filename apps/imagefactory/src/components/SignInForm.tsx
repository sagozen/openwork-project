import { safeNext } from "@templatedesign/platform/legacy-redirects";
import { Button, Field, InlineNotice, TextInput } from "@templatedesign/ui";
import { useState } from "react";

export interface SignInFormProps {
  /** Same-origin path to return to after sign-in; anything else falls back to the account page. */
  next?: string;
  googleEnabled: boolean;
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  return body.message ?? "Something went wrong. Try again.";
}

export function SignInForm({ next, googleEnabled }: SignInFormProps) {
  const target = next ? safeNext(next) : "/account";
  const callbackURL = target === "/" ? "/account" : target;
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"google" | "email" | null>(null);

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
      if (!body.url) throw new Error("Google sign-in is not configured.");
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
      setError(caught instanceof Error ? caught.message : "We couldn't send the link.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <main id="main" className="w-auth">
      <div className="w-auth__card">
        <a className="td-logo" href="/">
          <span className="td-logo__seal" aria-hidden="true">
            IF
          </span>
          <span className="td-logo__word">ImageFactory</span>
        </a>
        <h1>Sign in</h1>
        {sentTo ? (
          <InlineNotice tone="success" title="Check your email">
            We sent a sign-in link to {sentTo}. It expires in 15 minutes.
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
                  Continue with Google
                </Button>
                <div className="w-auth__divider" aria-hidden="true">
                  <span>or</span>
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
                Email me a sign-in link
              </Button>
            </form>
            <p className="w-auth__fineprint">
              By continuing you agree to the <a href="/legal/terms">Terms</a> and the{" "}
              <a href="/legal/privacy">Privacy notice</a>.
            </p>
          </>
        )}
        <a className="w-auth__back" href="/">
          ← Back
        </a>
      </div>
    </main>
  );
}
