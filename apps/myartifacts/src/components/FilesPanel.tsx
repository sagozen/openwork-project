import { Button, InlineNotice } from "@templatedesign/ui";
import { useState } from "react";
import { errorMessage, formatBytes, when } from "../lib/account-format";

export interface FileRow {
  id: string;
  name: string;
  mime: string;
  size: number | null;
  expires_at: string | null;
  created_at: string;
}

export interface FilesPanelProps {
  initial: FileRow[];
  nextCursor: string | null;
  csrfToken: string;
}

/** The owner's files: copy a one-hour download link, or delete the file for good. */
export function FilesPanel(props: FilesPanelProps) {
  const headers = { "content-type": "application/json", "x-csrf-token": props.csrfToken };
  const [files, setFiles] = useState(props.initial);
  const [cursor, setCursor] = useState(props.nextCursor);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [fallbackLink, setFallbackLink] = useState<string>();
  const [error, setError] = useState<string>();

  const copyLink = async (file: FileRow) => {
    setBusy(`link:${file.id}`);
    setError(undefined);
    setFallbackLink(undefined);
    const response = await fetch(`/api/v1/files/${file.id}/link?ttl=3600&disposition=attachment`, { headers });
    if (!response.ok) {
      setError(await errorMessage(response, "Could not make a link."));
    } else {
      const { url } = (await response.json()) as { url: string };
      try {
        await navigator.clipboard.writeText(url);
        setCopied(file.id);
        window.setTimeout(() => setCopied((current) => (current === file.id ? null : current)), 1800);
      } catch {
        setFallbackLink(url);
      }
    }
    setBusy(null);
  };

  const remove = async (file: FileRow) => {
    if (!window.confirm(`Delete ${file.name}? This removes the file from storage and from every share.`)) return;
    setBusy(`delete:${file.id}`);
    setError(undefined);
    const response = await fetch(`/api/v1/files/${file.id}`, { method: "DELETE", headers });
    if (response.ok) setFiles((current) => current.filter((item) => item.id !== file.id));
    else setError(await errorMessage(response, "Could not delete that file."));
    setBusy(null);
  };

  const more = async () => {
    if (!cursor) return;
    setBusy("more");
    const response = await fetch(`/api/v1/files?limit=50&cursor=${encodeURIComponent(cursor)}`, { headers });
    if (response.ok) {
      const page = (await response.json()) as { items: FileRow[]; next_cursor: string | null };
      setFiles((current) => [...current, ...page.items]);
      setCursor(page.next_cursor);
    } else setError(await errorMessage(response, "Could not load more files."));
    setBusy(null);
  };

  return (
    <section className="w-card" aria-labelledby="acct-files">
      <h2 id="acct-files">Files</h2>
      <p className="td-muted">
        A copied link works for one hour and cannot be switched off early. For a link you can revoke, ask your assistant
        to create a share.
      </p>
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      {fallbackLink ? (
        <InlineNotice tone="info" title="Copy this link">
          <code className="w-break">{fallbackLink}</code>
        </InlineNotice>
      ) : null}
      {files.length === 0 ? (
        <p className="td-muted">No files yet. Ask Claude or ChatGPT to save one.</p>
      ) : (
        <div className="w-table-wrap">
          <table className="td-table td-table--dense">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="td-table__numeric">
                  Size
                </th>
                <th scope="col">Added</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="td-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <th scope="row" className="w-break">
                    {file.name}
                    <br />
                    <span className="td-muted">{file.mime}</span>
                  </th>
                  <td className="td-table__numeric">{formatBytes(file.size)}</td>
                  <td>{when(file.created_at)}</td>
                  <td>{when(file.expires_at, "kept")}</td>
                  <td>
                    <div className="w-row">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busy === `link:${file.id}`}
                        onClick={() => copyLink(file)}
                        aria-live="polite"
                      >
                        {copied === file.id ? "Copied" : "Copy 1-hour link"}
                      </Button>
                      <Button
                        variant="danger-outline"
                        size="sm"
                        loading={busy === `delete:${file.id}`}
                        onClick={() => remove(file)}
                      >
                        Delete
                      </Button>
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
