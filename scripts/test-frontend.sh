#!/usr/bin/env bash
# Smoke test for the web container (Nginx + React build).
# Usage: ./scripts/test-frontend.sh [BASE_URL]      default: http://localhost:8080
# Prints PASS/FAIL per check. Copy the real output into docs/frontend-test.md.
set -u
BASE="${1:-http://localhost:8080}"
pass=0; fail=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1  -> $2"; fail=$((fail+1)); }

# 1) Static site + SPA routes (refresh on a deep link must NOT 404)
for path in / /movies /movies/abc123 /movies/abc123/2026-11-20 /my-bookings /favorite /admin /admin/add-shows; do
  code=$(curl -s -o "$tmp/body" -w '%{http_code}' "$BASE$path")
  if [ "$code" = "200" ] && grep -q 'id="root"' "$tmp/body"; then ok "SPA route $path"; else bad "SPA route $path" "HTTP $code"; fi
done

# 2) Hashed asset: served, correct type, long cache
curl -s "$BASE/" -o "$tmp/index.html"
asset=$(grep -o '/assets/[^"]*\.js' "$tmp/index.html" | head -1)
if [ -n "$asset" ]; then
  curl -s -D "$tmp/h" -o /dev/null "$BASE$asset"
  grep -qi '^HTTP/.* 200' "$tmp/h" && ok "asset $asset 200" || bad "asset $asset" "$(head -1 "$tmp/h")"
  grep -qi 'content-type:.*javascript' "$tmp/h" && ok "asset content-type javascript" || bad "asset content-type" "not javascript"
  grep -qi 'cache-control:.*max-age=31536000' "$tmp/h" && ok "asset long cache" || bad "asset cache" "no 1y max-age"
else
  bad "find JS asset in index.html" "no /assets/*.js found"
fi

# 3) index.html must not be cached
curl -s -D "$tmp/h" -o /dev/null "$BASE/index.html"
grep -qi 'cache-control:.*no-cache' "$tmp/h" && ok "index.html no-cache" || bad "index.html no-cache" "header missing"

# 4) Headers / hardening
curl -s -D "$tmp/h" -o /dev/null "$BASE/"
grep -qi 'x-content-type-options: nosniff' "$tmp/h" && ok "header X-Content-Type-Options" || bad "header nosniff" "missing"
grep -i '^server:' "$tmp/h" | grep -q '/' && bad "server_tokens off" "version exposed" || ok "Nginx version hidden"

# 5) Health endpoint
[ "$(curl -s "$BASE/healthz")" = "ok" ] && ok "/healthz" || bad "/healthz" "unexpected response"

# 6) Reverse proxy to API container
code=$(curl -s -o "$tmp/api" -w '%{http_code}' "$BASE/api/show/all")
if [ "$code" = "200" ] && grep -q '"success"' "$tmp/api"; then ok "GET /api/show/all via Nginx"; else bad "GET /api/show/all" "HTTP $code (502 = api not healthy / DNS; check 'docker compose logs api')"; fi

echo "------------------------------"
echo "PASS=$pass  FAIL=$fail  (base: $BASE, $(date '+%Y-%m-%d %H:%M'))"
[ "$fail" -eq 0 ]
