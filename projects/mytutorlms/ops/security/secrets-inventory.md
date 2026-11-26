# Secrets inventory

Secrets never go into the repository, `deploy/sites/*/site.json`, backups of the database, logs, the audit log or the browser. `scripts/check-sites.mjs` fails if a site file has a key that looks like a secret.

| Secret | Where it lives | Owner | Rotation |
|---|---|---|---|
| `EMDASH_ENCRYPTION_KEY` (per site) | Cloudflare: Worker secret (`wrangler secret put`). Node: the host's private environment file, mode 0600. Escrowed offline in two places, separately from database backups | Platform owner | **Do not rotate or regenerate.** It encrypts plugin secret settings. A new key makes stored DoveRunner and email credentials unreadable. If it leaks, re-enter every plugin secret after an EmDash-supported key change |
| DoveRunner site key and access key (per site) | EmDash plugin settings, `secret` fields, encrypted with the site key | Site owner | Generate new keys in DoveRunner Console, save them in plugin settings, then confirm a real device plays. Old tokens expire within 10 minutes |
| Email provider credential (per site) | The email provider plugin's own encrypted settings, or the Cloudflare `send_email` binding | Site owner | Rotate at the provider, update the provider settings, then use **Send test** in Site and records |
| Learner reference key (per site) | Plugin KV `state:student-ref-key`, created once | Automatic | Not rotated. It makes the learner IDs sent to DoveRunner unguessable; changing it would break the link between old playback records and learners |
| Wrangler / Cloudflare API token | The operator's machine or CI secret store; never the site | Platform operator | Scope it to the site's account and resources. Revoke it when an operator leaves |
| Backup bucket credentials | The backup operator's machine only | Platform operator | Use credentials separate from the site's media bucket, so a site compromise cannot delete its backups |

Reserved for later releases:

- **SePay and Whop webhook secrets (0.4):** EmDash plugin secret settings.
- **AI provider key (0.7):** Wrangler secret.

Student sign-in codes, sign-in links and session tokens are never stored in plain form. Only SHA-256 hashes are stored, and the audit and email logs drop any field named like a code, token, link, hash or secret.
