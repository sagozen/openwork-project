import { Button, InlineNotice } from "@templatedesign/ui";
import { useState } from "react";
import { errorMessage, when } from "../lib/account-format";
import { CopyButton } from "./CopyButton.js";

export interface ShareRow {
  id: string;
  url: string;
  title: string | null;
  has_password: boolean;
  state: "active" | "revoked" | "expired";
  expires_at: string | null;
  view_count: number;
  download_count: number;
  last_viewed_at: string | null;
  item_count: number;
  created_at: string;
}

export interface SharesPanelProps {
  initial: ShareRow[];
  nextCursor: string | null;
  csrfToken: string;
}

/** The owner's share links: see how they are used, copy the address, switch one off. */
export function SharesPanel(props: SharesPanelProps) {
  const headers = { "content-type": "application/json", "x-csrf-token": props.csrfToken };
  const [shares, setShares] = useState(props.initial);
  const [cursor, setCursor] = useState(props.nextCursor);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const revoke = async (share: ShareRow) => {
    if (!window.confirm("Revoke this link? Anyone who opens it afterwards sees that it is no longer available."))
      return;
    setBusy(`revoke:${share.id}`);
    setError(undefined);
    const response = await fetch(`/api/v1/shares/${share.id}`, { method: "DELETE", headers });
    if (response.ok) {
      const { share: updated } = (await response.json()) as { share: ShareRow };
      setShares((current) => current.map((item) => (item.id === share.id ? updated : item)));
    } else setError(await errorMessage(response, "Could not revoke that link."));
    setBusy(null);
  };

  const more = async () => {
    if (!cursor) return;
    setBusy("more");
    const response = await fetch(`/api/v1/shares?limit=50&cursor=${encodeURIComponent(cursor)}`, { headers });
    if (response.ok) {
      const page = (await response.json()) as { items: ShareRow[]; next_cursor: string | null };
      setShares((current) => [...current, ...page.items]);
      setCursor(page.next_cursor);
    } else setError(await errorMessage(response, "Could not load more links."));
    setBusy(null);
  };

  return (
    <section className="w-card" aria-labelledby="acct-shares">
      <h2 id="acct-shares">Share links</h2>
      <p className="td-muted">
        Revoking takes effect within 5 minutes for anyone who already opened the link. Passwords are not stored in a
        readable form and cannot be shown again.
      </p>
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      {shares.length === 0 ? (
        <p className="td-muted">No share links yet. Ask your assistant to share a file.</p>
      ) : (
        <div className="w-table-wrap">
          <table className="td-table td-table--dense">
            <thead>
              <tr>
                <th scope="col">Link</th>
                <th scope="col">Password</th>
                <th scope="col" className="td-table__numeric">
                  Views
                </th>
                <th scope="col" className="td-table__numeric">
                  Downloads
                </th>
                <th scope="col">Expires</th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="td-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shares.map((share) => (
                <tr key={share.id}>
                  <th scope="row" className="w-break">
                    {share.title ?? "Untitled"}
                    <br />
                    <a href={share.url}>{share.url}</a>
                    <br />
                    <span className="td-muted">
                      {share.item_count} {share.item_count === 1 ? "file" : "files"} · last viewed{" "}
                      {when(share.last_viewed_at)}
                    </span>
                  </th>
                  <td>{share.has_password ? "yes" : "no"}</td>
                  <td className="td-table__numeric">{share.view_count}</td>
                  <td className="td-table__numeric">{share.download_count}</td>
                  <td>{when(share.expires_at, "until revoked")}</td>
                  <td>{share.state}</td>
                  <td>
                    <div className="w-row">
                      <CopyButton value={share.url} label="Copy link" />
                      {share.state === "active" ? (
                        <Button
                          variant="danger-outline"
                          size="sm"
                          loading={busy === `revoke:${share.id}`}
                          onClick={() => revoke(share)}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor ? (
        <Button variant="secondary" size="sm" loading={busy === "more"} onClick={more}>
          Load more
        </Button>
      ) : null}
    </section>
  );
}
