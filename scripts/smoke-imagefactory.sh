#!/usr/bin/env bash
# Post-deploy smoke test for ImageFactory. Read-only: no sign-in email, no image job, no credit
# movement. Every request is a GET or a request the app must reject before it does any work.
#
#   scripts/smoke-imagefactory.sh                                  # https://imagefactory.zhst.app
#   scripts/smoke-imagefactory.sh https://imagefactory.zhst.app
#   SMOKE_RESOLVE_IP=<ip> scripts/smoke-imagefactory.sh            # bypass a stale local DNS cache
set -euo pipefail

BASE="${1:-${APP_URL:-https://imagefactory.zhst.app}}"
BASE="${BASE%/}"
HEADERS=(-H "user-agent: imagefactory-smoke/1")
if [ -n "${SMOKE_RESOLVE_IP:-}" ]; then
  host="${BASE#*://}"
  HEADERS+=(--resolve "${host%%/*}:443:$SMOKE_RESOLVE_IP")
fi

failures=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; failures=$((failures + 1)); }

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
if [ "$STATUS" = 200 ] && printf '%s' "$BODY" | grep -q '"status":"ok"'; then
  pass "health is 200 and reports D1 ok"
else
  fail "health returned $STATUS: ${BODY:0:120}"
fi

request GET /
if [ "$STATUS" = 200 ] && printf '%s' "$BODY" | grep -q '/mcp'; then
  pass "landing page renders and shows the connector URL"
else
  fail "landing page returned $STATUS or has no connector URL"
fi
if [ -n "$(header content-security-policy)" ] && [ "$(header x-frame-options)" = "DENY" ]; then
  pass "security headers are set"
else
  fail "security headers are missing"
fi

request GET /.well-known/oauth-protected-resource/mcp
if [ "$STATUS" = 200 ] && printf '%s' "$BODY" | grep -Eq '"resource":"[^"]*/mcp"'; then
  pass "protected-resource metadata names the /mcp resource"
else
  fail "protected-resource metadata returned $STATUS: ${BODY:0:160}"
fi

request GET /.well-known/oauth-authorization-server
if [ "$STATUS" = 200 ] && printf '%s' "$BODY" | grep -q '"registration_endpoint"'; then
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

request POST /mcp -H 'content-type: application/json' -H 'authorization: Bearer if_live_notarealkeynotarealkeynotarealkey000000'
if [ "$STATUS" = 401 ] && ! header www-authenticate | grep -q 'resource_metadata='; then
  pass "/mcp with a bad API key is a plain 401"
else
  fail "/mcp with a bad API key returned $STATUS"
fi

request GET /api/v1/balance
if [ "$STATUS" = 401 ]; then pass "REST API without a key is 401"; else fail "/api/v1/balance returned $STATUS"; fi

request POST /api/v1/fal-webhook -H 'content-type: application/json' --data '{"request_id":"x","status":"OK"}'
if [ "$STATUS" = 401 ]; then pass "an unsigned provider callback is rejected"; else fail "unsigned webhook returned $STATUS"; fi

# A connector exchanges its code with a form-encoded POST from its own servers, with no same-site Origin.
request POST /api/auth/oauth2/token -H 'content-type: application/x-www-form-urlencoded' \
  --data 'grant_type=authorization_code&code=smoke&client_id=smoke&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&code_verifier=smoke'
if [ "$STATUS" = 400 ] || [ "$STATUS" = 401 ]; then pass "a form-encoded token request from another site reaches the OAuth server"; else fail "token endpoint returned $STATUS for a cross-site form post (expected 400 or 401)"; fi

# The worker API answers only to a registered worker token, never to a browser session or an API key.
request POST /api/internal/worker/lease -H 'content-type: application/json' --data '{"wait_seconds":0}'
if [ "$STATUS" = 401 ]; then pass "the worker lease without a token is 401"; else fail "/api/internal/worker/lease returned $STATUS without a token"; fi
request POST /api/internal/worker/lease -H 'content-type: application/json' -H 'authorization: Bearer wkr_smoke' --data '{"wait_seconds":0}'
if [ "$STATUS" = 401 ]; then pass "the worker lease with an unknown token is 401"; else fail "worker lease returned $STATUS for an unknown token"; fi
request POST /api/internal/worker/jobs/job_x/complete -H 'authorization: Bearer if_live_smoke'
if [ "$STATUS" = 401 ]; then pass "a worker route refuses an API key"; else fail "worker complete returned $STATUS for an API key"; fi

request GET /i/aaaaaaaaaaaaaaaaaaaaaaaaaa.png
if [ "$STATUS" = 404 ]; then pass "an unknown image id is 404"; else fail "/i/<unknown> returned $STATUS"; fi

request GET /i/ref/bas_00000000000000000000000000000000
if [ "$STATUS" = 404 ]; then pass "a reference link without a signature is 404"; else fail "/i/ref/<unsigned> returned $STATUS"; fi

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
