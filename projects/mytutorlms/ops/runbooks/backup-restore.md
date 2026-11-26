# Backup and restore

A MyTutor site's data is one recovery set: the database, media files and the site's `EMDASH_ENCRYPTION_KEY`. The key also decrypts plugin secret settings (DoveRunner keys, email provider credentials), so a database restored without its key loses those settings. Never regenerate the key for an existing site.

EmDash's JSON export (`emdash site export`) leaves out users, passkeys, plugin storage and plugin settings. It is not a backup for this product.

## Before every upgrade

1. Take a backup with the commands below.
2. Verify it with `restore-verify` (Node) or by importing it into a new, empty D1 database (Cloudflare).
3. Keep the verification output. The account upgrade screen asks for the time of a verified backup taken within the last 24 hours.

## Node host

```sh
node --env-file=<host env file> ops/scripts/backup-node.mjs --data-dir <data dir> --out <backup dir>
node ops/scripts/restore-verify.mjs <backup dir>/mytutor-node-<timestamp>
```

`backup-node` copies the database with SQLite's online backup, so the site can keep running. It copies media and writes `manifest.json` with a SHA-256 hash for every file and a row count for every table. It refuses to run if `EMDASH_ENCRYPTION_KEY` is not in the environment, and it never copies the key or the environment file. Store the key separately (see `ops/security/secrets-inventory.md`).

`restore-verify` checks every hash, copies the database to a new temporary directory, runs SQLite's integrity check and compares row counts with the manifest. For a full rehearsal:

1. Point a preview host at the restored copy, with `MYTUTOR_DATA_DIR` set to it and the same key.
2. Run `npm --prefix themes/mytutor run preview` on a spare port.
3. Sign in as a rehearsal student you create only in the restored copy, and open one course.
4. Stop the preview and delete the copy.

To restore for real:

1. Stop the host.
2. Move the current data directory aside. Never delete it before the restore is confirmed.
3. Copy `emdash.db` and `media/` from the backup into the data directory.
4. Start the host with the same key.
5. Check `/api/health/deep`.

## Cloudflare host

```sh
node ops/scripts/backup-cloudflare.mjs --database <d1 name> --out <backup dir> --config themes/mytutor/wrangler.<site>.jsonc
```

The script:

1. Records the D1 Time Travel bookmark. Time Travel keeps 30 days on paid plans. A Time Travel restore overwrites the database in place, so use it only in an emergency, after exporting the current state.
2. Exports the database table by table and skips EmDash's `_emdash_fts_*` search tables. A plain `wrangler d1 export` fails when those FTS5 tables exist.
3. Writes a manifest with hashes and row counts.

The search tables are rebuilt from content after a restore.

Copy R2 media to the site's backup bucket with an S3-compatible tool such as rclone. Use credentials that can read the media bucket and write only to the backup bucket. Keep an object inventory with the backup.

To restore, import the table files into a **new, empty** D1 database:

```sh
wrangler d1 create <new name>
wrangler d1 execute <new name> --remote --file <table>.sql
```

Run the `execute` command once per table. Then point the Worker's `DB` binding at the new database, deploy the same theme and plugin pair, and check `/api/health/deep`. Compare the workspace's account upgrade and integrity counts with the manifest before reopening the site.

## Rolling back a release

Every release names its rollback target in `plans/261021-2241-full-product-lms/cross-phase-reconciliation.md` (section 2). Redeploy the matched theme and plugin pair of the previous release. A two-step rollback needs a restore.

- **0.3.x → 0.2.2:** redeploy the 0.2.2 pair. 0.2.2 reads account-linked enrollments, and student accounts, grants and the audit log stay in place but unused. Students who moved to accounts need their invitation link, or a reissued one, again. Students who only ever had manual or complimentary access (no invitation) cannot sign in on 0.2.2 at all; invite them to reach their saved progress.
- **The owner migration has an escape hatch.** Its **Revert** button returns invitation enrollments to the 0.2 format and leaves the new collections in place.
- **Restoring the pre-upgrade backup is the last resort.** It loses all activity since that backup.

## What has been verified

- **Node scripts:** run against a development database (71 tables, including plugin storage). The tests covered the hashes, the integrity check, refusal without the key, and detection of a tampered file.
- **Not yet run:** the Cloudflare script against a real D1 database, and a full restore rehearsal on a deployed site. Run both before trusting the procedure with student data.
