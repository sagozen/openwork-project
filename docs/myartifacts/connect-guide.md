# Connect MyArtifacts to Claude and ChatGPT

MyArtifacts stores files for you and shares them by link. You add it once as a connector, then ask your
assistant in plain words: save this file, give me a link, share it with a password, switch the link off. It is a
private app: only its owner can sign in or connect.

The connector URL is shown on the [home page](https://myartifacts.zhst.app/) and on your account page:

```
https://myartifacts.zhst.app/mcp
```

> **Verification status.** Sign-in, the tools and the share pages are covered by automated tests against the
> app's own code. They have not yet been run from a real Claude or ChatGPT account against the deployed site.
> The "Verified" column is filled in after that check (see the deploy guide, section 9).

| Client | Added how | Verified |
|---|---|---|
| Claude on the web | Settings, Connectors, Add custom connector | not yet |
| Claude Desktop | Syncs from your Claude account | not yet |
| Claude Code | `claude mcp add --transport http myartifacts <url>` | not yet |
| ChatGPT | Settings, Apps & Connectors, developer mode, add an MCP server | not yet |
| n8n, scripts | API key | not yet |

## Claude (web, Desktop)

1. Open Settings, then Connectors, then **Add custom connector**.
2. Paste the connector URL. If Claude asks how to identify itself, choose to register automatically.
3. Claude opens MyArtifacts. Sign in with your email link or Google (only the owner's address works), check the
   app name and the address it will return to, and choose **Allow**.
4. In a conversation, turn the connector on and ask for what you need. Claude Desktop uses the same connector once
   it is on your account.

## Claude Code

```bash
claude mcp add --transport http myartifacts https://myartifacts.zhst.app/mcp
```

Then run `/mcp` inside Claude Code and sign in. Claude Code can make HTTP requests, so it uploads large files
straight to storage: it asks for an upload URL, sends the bytes with `curl -T`, and confirms.

## ChatGPT

1. Settings, Apps & Connectors, then turn on developer mode.
2. Add a connector: paste the same URL and choose OAuth.
3. Sign in and choose **Allow**, then enable the connector in a chat.

ChatGPT cannot send a file's bytes to a URL, so it saves small content directly (`put_file`, up to about 4 MB) or
imports a public link (`import_from_url`, up to 100 MB).

## How a file gets in

| Situation | What the assistant uses |
|---|---|
| Small content it has in the conversation (a note, JSON, CSV, a small image) | `put_file`: the content goes in the request. Up to about 4 MB. |
| A big or binary file, and the client can run commands or HTTP requests | `create_upload`, then a PUT of the bytes, then `complete_upload`. Up to 5 GB, straight to storage. |
| The file already has a public https link | `import_from_url`, up to 100 MB. Private and local addresses are refused. |

## How someone else gets it

| You want | Ask for | Lasts |
|---|---|---|
| A quick link for yourself or a colleague | "Give me a download link for report.pdf" (`get_download_link`) | 1 minute to 7 days, 1 hour by default. Cannot be switched off early. |
| A link you control | "Share these files with a password, valid for a week" (`create_share`) | Until you revoke it or its expiry. Optional password. No download limit. |

A share link looks like `https://myartifacts.zhst.app/s/...`. One file opens a page with a preview (image, PDF,
video, audio, plain text) and a Download button; several files show a list. The files themselves open from the
storage host, not from this site, and HTML or SVG files always download rather than run. If you ask for a
generated password, it is shown once in the reply: copy it then, because it cannot be shown again. Revoke a share
by asking ("revoke that link") or on the account page; it stops within 5 minutes for anyone who already opened it.

## Check it works

1. "Save `Hello` as hello.txt", then "list my files" and "read hello.txt": the text comes back.
2. "Give me a download link for hello.txt" and open it in a browser.
3. In Claude Code or a shell: "upload this 500 MB file". Its stored size must equal the file's real size.
4. "Share hello.txt with a password": open the link in a private window. The page asks for the password and shows
   nothing else. Enter it, see the preview, download. Then "revoke that link" and reload: the page says it is no
   longer available.

## Tools

Read: `list_files`, `get_file`, `read_file`, `get_download_link`, `get_usage`, `list_shares`, `get_share`.
Write: `create_upload`, `complete_upload`, `put_file`, `import_from_url`, `set_file_expiry`, `delete_file`,
`create_share`, `update_share`, `revoke_share`.

Files are kept until you delete them. To have one removed later, ask for an expiry ("delete it in 30 days").
`read_file` returns text up to 1 MB or an image up to 4 MB so the assistant can read what it stored; for
anything else it gives you a link instead.

## Automating with n8n, scripts or any HTTP client

Create an API key on your account page. Read and write keys can store and share; read-only keys can list and make
download links.

```bash
# Save a small file (raw body, up to about 4 MB)
curl -X POST "https://myartifacts.zhst.app/api/v1/files?name=report.pdf&expires_in_days=30" \
  -H "Authorization: Bearer ma_live_..." -H "Content-Type: application/octet-stream" --data-binary @report.pdf

# Big file: ask for an upload URL, PUT the bytes, confirm
curl -X POST https://myartifacts.zhst.app/api/v1/files/uploads -H "Authorization: Bearer ma_live_..." \
  -H "Content-Type: application/json" -d '{"name":"video.mp4","size":524288000,"mime":"video/mp4"}'
curl -T video.mp4 -H "Content-Type: video/mp4" "<upload_url from the reply>"
curl -X POST https://myartifacts.zhst.app/api/v1/files/<file_id>/complete -H "Authorization: Bearer ma_live_..."

# A one-hour download link, and a password-protected share
curl "https://myartifacts.zhst.app/api/v1/files/<file_id>/link?ttl=3600" -H "Authorization: Bearer ma_live_..."
curl -X POST https://myartifacts.zhst.app/api/v1/shares -H "Authorization: Bearer ma_live_..." \
  -H "Content-Type: application/json" -d '{"file_ids":["<file_id>"],"password":"generate","expires_in_days":7}'
```

The PUT must send exactly the declared number of bytes and the declared content type, within 15 minutes.
Routes: `GET`/`POST /api/v1/files`, `GET`/`PATCH`/`DELETE /api/v1/files/{id}` (PATCH sets or clears the expiry),
`POST /api/v1/files/uploads`, `POST /api/v1/files/{id}/complete`, `POST /api/v1/files/import`,
`GET /api/v1/files/{id}/link`, `GET`/`POST /api/v1/shares`, `GET`/`PATCH`/`DELETE /api/v1/shares/{id}` (DELETE
revokes), `GET /api/v1/usage`. The MCP endpoint takes the same key as a bearer token.

## Good to know

- **Where files live.** In a private bucket at Contabo Object Storage. This site keeps names, sizes and share
  settings only.
- **Temporary links.** A link from `get_download_link` works until its own expiry and cannot be revoked early. Use
  a share when you may need to take access back.
- **Revoking.** Disconnect an app or revoke a key on the account page. The next request from it fails and asks to
  sign in again.
- **Limits.** 4 MB per inline save, 100 MB per import, 5 GB per presigned upload, 50 files per share. There is no
  storage quota and no download limit.
