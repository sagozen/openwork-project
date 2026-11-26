#!/usr/bin/env bash
# Post-deploy smoke test for MyArtifacts. Read-only: no sign-in email, no upload, no object written
# or read. Every request is a GET or a request the app must reject before it does any work.
#
#   scripts/smoke-myartifacts.sh                                  # https://myartifacts.zhst.app
#   scripts/smoke-myartifacts.sh https://myartifacts.zhst.app
#   SMOKE_RESOLVE_IP=<ip> scripts/smoke-myartifacts.sh            # bypass a stale local DNS cache
set -euo pipefail

BASE="${1:-${APP_URL:-https://myartifacts.zhst.app}}"
BASE="${BASE%/}"
HEADERS=(-H "user-agent: myartifacts-smoke/1")
if [ -n "${SMOKE_RESOLVE_IP:-}" ]; then
  host="${BASE#*://}"
  HEADERS+=(--resolve "${host%%/*}:443:$SMOKE_RESOLVE_IP")
fi

failures=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; failures=$((failures + 1)); }

# Matching uses here-strings: with `pipefail`, `printf | grep -q` fails on a large page when grep stops reading early.
# request <method> <path> [curl args...] -> sets STATUS, BODY and RESPONSE_HEADERS
request() {
  local method="$1" path="$2"
  shift 2
  local head body
  head="$(mktemp)"
  body="$(mktemp)"
  STATUS="$(curl -sS -o "$body" -D "$head" -w '%{http_code}' --max-time 20 -X "$method" \
    "${HEADERS[@]}" "$@" "$BASE$path" || true)"
  BODY="$(cat "$body")"
  RESPONSE_HEADERS="$(tr -d '\r' < "$head")"
  rm -f "$head" "$body"
}

header() { printf '%s\n' "$RESPONSE_HEADERS" | { grep -i "^$1:" || true; } | tail -1 | cut -d: -f2- | sed 's/^ *//'; }

echo "Smoke test: $BASE"

request GET /api/v1/health
if [ "$STATUS" = 200 ] && grep -q '"db":"ok"' <<<"$BODY" && grep -q '"storage":"ok"' <<<"$BODY"; then
  pass "health is 200 and reports D1 and the object store reachable"
else
  fail "health returned $STATUS: ${BODY:0:160}"
fi

request GET /
if [ "$STATUS" = 200 ] && grep -q '/mcp' <<<"$BODY"; then
  pass "landing page renders and shows the connector URL"
else
  fail "landing page returned $STATUS or has no connector URL"
fi
if grep -qi '<meta name="robots" content="noindex' <<<"$BODY"; then
  pass "landing page is noindex"
else
  fail "landing page is not marked noindex"
fi
if [ -n "$(header content-security-policy)" ] && [ "$(header x-frame-options)" = "DENY" ]; then
  pass "security headers are set"
else
  fail "security headers are missing"
fi

request GET /.well-known/oauth-protected-resource/mcp
if [ "$STATUS" = 200 ] && grep -Eq '"resource":"[^"]*/mcp"' <<<"$BODY"; then
  pass "protected-resource metadata names the /mcp resource"
else
  fail "protected-resource metadata returned $STATUS: ${BODY:0:160}"
fi

request GET /.well-known/oauth-authorization-server
if [ "$STATUS" = 200 ] && grep -q '"registration_endpoint"' <<<"$BODY"; then
  pass "authorization-server metadata offers client registration"
else
  fail "authorization-server metadata returned $STATUS: ${BODY:0:160}"
fi

request POST /mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
if [ "$STATUS" = 401 ] && header www-authenticate | grep -q 'resource_metadata='; then
  pass "/mcp without a token is 401 with a resource_metadata challenge"
else
  fail "/mcp without a token returned $STATUS (challenge: $(header www-authenticate))"
fi

request POST /mcp -H 'content-type: application/json' -H 'authorization: Bearer ma_live_notarealkeynotarealkeynotarealkey000000'
if [ "$STATUS" = 401 ] && ! header www-authenticate | grep -q 'resource_metadata='; then
  pass "/mcp with a bad API key is a plain 401"
else
  fail "/mcp with a bad API key returned $STATUS"
fi

for path in /api/v1/files /api/v1/shares /api/v1/usage; do
  request GET "$path"
  if [ "$STATUS" = 401 ]; then pass "REST $path without a key is 401"; else fail "$path returned $STATUS without a key"; fi
done

# A connector exchanges its code with a form-encoded POST from its own servers, with no same-site Origin.
request POST /api/auth/oauth2/token -H 'content-type: application/x-www-form-urlencoded' \
  --data 'grant_type=authorization_code&code=smoke&client_id=smoke&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&code_verifier=smoke'
if [ "$STATUS" = 400 ] || [ "$STATUS" = 401 ]; then pass "a form-encoded token request from another site reaches the OAuth server"; else fail "token endpoint returned $STATUS for a cross-site form post (expected 400 or 401)"; fi

request GET /s/aaaaaaaaaaaaaaaaaaaaaaaaaa
if [ "$STATUS" = 404 ]; then pass "an unknown share token is 404"; else fail "/s/<unknown> returned $STATUS"; fi
if [ "$(header cache-control)" = "no-store" ] && header x-robots-tag | grep -qi 'noindex'; then
  pass "share pages are no-store and noindex"
else
  fail "share pages are missing no-store or noindex"
fi
if header content-security-policy | grep -q "default-src 'none'"; then
  pass "share pages carry their own strict CSP"
else
  fail "share pages are missing the strict CSP"
fi

request GET /s/not-a-token
if [ "$STATUS" = 404 ]; then pass "a malformed share token is 404"; else fail "/s/not-a-token returned $STATUS"; fi

request GET /s/aaaaaaaaaaaaaaaaaaaaaaaaaa/d/aaaaaaaaaaaaaaaaaaaaaaaaaa
if [ "$STATUS" = 404 ]; then pass "a download from an unknown share is 404"; else fail "/s/<unknown>/d/<id> returned $STATUS"; fi

request GET /sign-in
if [ "$STATUS" = 200 ]; then pass "sign-in page renders"; else fail "/sign-in returned $STATUS"; fi

for path in /account /admin/; do
  request GET "$path"
  if [ "$STATUS" = 302 ] && header location | grep -q '^/sign-in'; then
    pass "$path redirects a visitor to sign-in"
  else
    fail "$path returned $STATUS (location: $(header location))"
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "All checks passed."
