#!/usr/bin/env bash
# Deploy any app under apps/<name> that has a wrangler.jsonc.
# Gates -> D1 migrations -> wrangler deploy -> smoke test. It does not touch the transcription
# workers: release those separately (services/transcriber).
#
#   ./deploy-cf.sh transcript          # TranscriptAnything
#   ./deploy-cf.sh ota                 # Ota
#   ./deploy-cf.sh imagefactory        # ImageFactory (also runs scripts/smoke-imagefactory.sh)
#   ./deploy-cf.sh myartifacts         # MyArtifacts (also runs scripts/smoke-myartifacts.sh)
#   ./deploy-cf.sh --list              # list apps with a wrangler.jsonc
#   ./deploy-cf.sh transcript --skip-tests --yes
set -euo pipefail

APP="imagefactory"
LIST=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --list) LIST=1 ;;
    -*) ARGS+=("$arg") ;;
    *) APP="$arg" ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

if [ "$LIST" = 1 ]; then
  for dir in apps/*/; do
    [ -f "${dir}wrangler.jsonc" ] || continue
    name="$(basename "$dir")"
    host="$(node -e '
      const fs = require("node:fs");
      const raw = fs.readFileSync(process.argv[1], "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
      const route = (JSON.parse(raw).routes ?? [])[0]?.pattern ?? "";
      console.log(typeof route === "string" ? route : "");
    ' "${dir}wrangler.jsonc")"
    printf '%-12s %s\n' "$name" "${host:+https://${host%%/*}}"
  done
  exit 0
fi

APP_DIR="apps/$APP"
[ -f "$APP_DIR/wrangler.jsonc" ] || { echo "unknown app: $APP (no $APP_DIR/wrangler.jsonc)" >&2; exit 2; }

# D1 name, public URL and package name come from the app's own config; env vars still override.
read -r CFG_D1 CFG_HOST CFG_PKG < <(node -e '
const fs = require("node:fs");
const dir = process.argv[1];
const raw = fs.readFileSync(`${dir}/wrangler.jsonc`, "utf8")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/,(\s*[}\]])/g, "$1");
const config = JSON.parse(raw);
const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, "utf8"));
const host = (config.routes ?? []).map((route) => route.pattern ?? route).find((p) => typeof p === "string") ?? "";
// An app without a route yet (the tower before its cutover) prints "-" so the fields stay in place.
console.log([config.d1_databases?.[0]?.database_name ?? "", host || "-", pkg.name].join(" "));
' "$APP_DIR")
[ "$CFG_HOST" = "-" ] && CFG_HOST=""
APP_URL="${APP_URL:-${CFG_HOST:+https://${CFG_HOST%%/*}}}"
D1_NAME="${D1_NAME:-$CFG_D1}"
[ -n "$APP_URL" ] || { echo "$APP_DIR/wrangler.jsonc has no route; set APP_URL" >&2; exit 2; }
[ -n "$D1_NAME" ] || { echo "$APP_DIR/wrangler.jsonc has no D1 database; set D1_NAME" >&2; exit 2; }

SKIP_TESTS=0 ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) sed -n 2,11p "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  read -r -p "$1 [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "aborted"
}

if [ -n "$(git status --porcelain -- apps packages services)" ]; then
  git status --short -- apps packages services
  die "uncommitted changes in apps/, packages/ or services/; deploy a committed release"
fi
log "Releasing $APP ($(git rev-parse --short HEAD)) to $APP_URL"

log "Preflight"
if node -e "process.exit(require('./package.json').scripts['preflight:'+process.argv[1]]?0:1)" "$APP"; then
  npm run "preflight:$APP" || die "preflight failed; fix the blocking issues above"
else
  echo "no preflight:$APP script; running the shared preflight"
  node scripts/preflight-app.mjs "$APP" || die "preflight failed; fix the blocking issues above"
fi

log "Gates"
if [ "$SKIP_TESTS" = 0 ]; then
  npm run check:migrations
  npm run check:platform
  npm run check -w "$CFG_PKG"
  npm run test -w "$CFG_PKG"
fi
npm run build -w "$CFG_PKG"

cd "$APP_DIR"
npx wrangler whoami >/dev/null 2>&1 || die "not logged in; run: npx wrangler login"

log "Cloudflare resources"
QUEUES="$(node -e '
const fs = require("node:fs");
const raw = fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
const config = JSON.parse(raw);
const names = (config.queues?.producers ?? []).map((item) => item.queue);
for (const consumer of config.queues?.consumers ?? []) {
  names.push(consumer.queue);
  if (consumer.dead_letter_queue) names.push(consumer.dead_letter_queue);
}
console.log([...new Set(names)].filter(Boolean).join(" "));
')"
if [ -n "$QUEUES" ]; then
  for queue in $QUEUES; do
    npx wrangler queues info "$queue" >/dev/null 2>&1 \
      || die "queue $queue does not exist; create it: (cd $APP_DIR && npx wrangler queues create $queue)"
    echo "$queue exists"
  done
else
  echo "no queues declared"
fi

log "D1 migrations"
PENDING="$(npx wrangler d1 migrations list DB --remote 2>&1 || true)"
echo "$PENDING" | tail -8
if echo "$PENDING" | grep -q "No migrations to apply"; then
  echo "nothing to apply"
else
  BACKUP_DIR="$ROOT/../openwork-backups"
  mkdir -p "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/d1-$APP-$(date -u +%Y%m%dT%H%M%SZ).sql"
  confirm "Export D1 to $BACKUP, then apply the migrations above?"
  if ! npx wrangler d1 export DB --remote --output "$BACKUP"; then
    # A brand-new database has nothing to export; anything else must stop the release.
    TABLES="$(npx wrangler d1 execute DB --remote --json --command \
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[0].results[0].n)}catch{console.log("unknown")}})')"
    [ "$TABLES" = "0" ] || die "D1 export failed; not applying migrations without a backup"
    echo "D1 has no tables yet (first deploy); nothing to back up"
  fi
  npx wrangler d1 migrations apply "$D1_NAME" --remote
fi

log "Worker"
PREVIOUS="$(npx wrangler deployments list --config dist/server/wrangler.json 2>/dev/null \
  | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1 || true)"
echo "current version (rollback target): ${PREVIOUS:-unknown}"
confirm "Deploy $APP to production?"
npx wrangler deploy --config dist/server/wrangler.json

log "Smoke test"
health="$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/api/v1/health" || true)"
[ "$health" = "200" ] || die "health check returned $health; roll back: cd $APP_DIR && npx wrangler rollback ${PREVIOUS:-<version-id>} --config dist/server/wrangler.json"
echo "$APP_URL/api/v1/health -> 200"
status="$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/" || true)"
# The tower is owner-only, so its home page redirects an anonymous visitor to /login.
[ "$status" = "200" ] || { [ "$APP" = "tower" ] && [ "$status" = "302" ]; } || die "home page returned $status; roll back: cd $APP_DIR && npx wrangler rollback ${PREVIOUS:-<version-id>} --config dist/server/wrangler.json"
echo "$APP_URL/ -> $status"
if [ -x "$ROOT/scripts/smoke-$APP.sh" ]; then
  "$ROOT/scripts/smoke-$APP.sh" "$APP_URL" \
    || die "scripts/smoke-$APP.sh failed; roll back: cd $APP_DIR && npx wrangler rollback ${PREVIOUS:-<version-id>} --config dist/server/wrangler.json"
fi
echo "Rollback: cd $APP_DIR && npx wrangler rollback ${PREVIOUS:-<version-id>} --config dist/server/wrangler.json"
