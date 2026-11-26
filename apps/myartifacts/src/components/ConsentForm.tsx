import { Button, Checkbox, InlineNotice } from "@templatedesign/ui";
import { useEffect, useState } from "react";

interface ConsentDetails {
  clientId: string;
  name: string;
  scopes: string[];
  oauthQuery: string;
}

const SCOPE_TEXT: Record<string, string> = {
  "artifacts:read": "See your files and share links, read their contents and make temporary download links",
  "artifacts:write": "Upload, delete and share files, and revoke share links",
  offline_access: "Stay connected without asking you to sign in again",
};

export interface ConsentFormProps {
  oauthQuery: string;
  csrfToken: string;
  /** Host of the address the app will be sent back to, taken from the signed request. */
  redirectHost: string;
  email: string;
}

/** The OAuth consent screen: who is asking, where they will be sent back, and what they may do. */
export function ConsentForm({ oauthQuery, csrfToken, redirectHost, email }: ConsentFormProps) {
  const [details, setDetails] = useState<ConsentDetails>();
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void (async () => {
      const response = await fetch(`/api/agents/consent?oauth_query=${encodeURIComponent(oauthQuery)}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        setError("This connection request has expired or is not valid. Start again from your assistant.");
        return;
      }
      const loaded = (await response.json()) as ConsentDetails;
      setDetails(loaded);
      setGranted(Object.fromEntries(loaded.scopes.map((scope) => [scope, true])));
    })();
  }, [oauthQuery]);

  const decide = async (accept: boolean) => {
    setBusy(accept ? "allow" : "deny");
    setError(undefined);
    const scope = Object.entries(granted)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(" ");
    const response = await fetch("/api/agents/consent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ oauthQuery, accept, ...(accept ? { scope } : {}) }),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as { detail?: string };
      setError(problem.detail ?? "Could not complete the connection. Start again from your assistant.");
      setBusy(null);
      return;
    }
    window.location.href = ((await response.json()) as { redirectTo: string }).redirectTo;
  };

  const anyScope = Object.values(granted).some(Boolean);

  return (
    <main id="main" className="w-auth">
      <div className="w-auth__card">
        <a className="td-logo" href="/">
          <span className="td-logo__seal" aria-hidden="true">
            MA
          </span>
          <span className="td-logo__word">MyArtifacts</span>
        </a>
        <h1>{details ? `Connect ${details.name}?` : "Connect an app"}</h1>
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        {details ? (
          <>
            <p>
              <strong>{details.name}</strong> wants to use MyArtifacts as <strong>{email}</strong>. After you choose,
              you will be sent back to <strong>{redirectHost}</strong>. Only continue if you started this from that app.
            </p>
            <fieldset className="td-field">
              <legend className="td-field__label">It will be able to</legend>
              {details.scopes.map((scope) => (
                <Checkbox
                  key={scope}
                  label={SCOPE_TEXT[scope] ?? scope}
                  checked={granted[scope] ?? false}
                  onChange={(event) => setGranted({ ...granted, [scope]: event.target.checked })}
                />
              ))}
            </fieldset>
            <Button
              variant="primary"
              size="lg"
              fullWidth
              loading={busy === "allow"}
              disabled={!anyScope}
              onClick={() => decide(true)}
            >
              Allow
            </Button>
            <Button variant="secondary" size="lg" fullWidth loading={busy === "deny"} onClick={() => decide(false)}>
              Deny
            </Button>
          </>
        ) : null}
      </div>
    </main>
  );
}
