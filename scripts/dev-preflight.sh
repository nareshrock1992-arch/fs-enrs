#!/usr/bin/env bash
# ============================================================================
# dev-preflight.sh — READ-ONLY source-development preflight for FS-ENRS.
#
# Verifies the host is in FS-ENRS DEFAULT DEVELOPMENT MODE (local checked-out
# source, host Piper/FreeSWITCH, no application containers) and that the core
# dependencies the backend needs are actually reachable FROM THE HOST — i.e.
# the same network context the PM2 backend runs in.
#
# It changes NOTHING. It exits non-zero if any critical check fails, so it can
# gate a CI step or a "before you start coding" check.
#
# Checks (each PASS/FAIL):
#   1. Backend process runs from the repo (not a different checkout/build)
#   2. No FS-ENRS application Docker container is serving the app
#   3. Piper HTTP service reachable + healthy on the configured PIPER_BACKEND_URL
#   4. FreeSWITCH ESL port reachable
#   5. PostgreSQL reachable (TCP)
#   6. backend/.env PIPER_BACKEND_URL points at a HOST endpoint (not a Docker name)
#
# Usage:
#   scripts/dev-preflight.sh
#   FS_ENRS_ROOT=/custom/path scripts/dev-preflight.sh
# ============================================================================
set -uo pipefail

REPO="${FS_ENRS_ROOT:-/opt/freeswitch-ui/fs-enrs}"
ENVF="$REPO/backend/.env"
fails=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fails=$((fails+1)); }
info() { printf '  ----  %s\n' "$1"; }

# Read a KEY=value from backend/.env (value only; empty if absent).
envval() { [ -f "$ENVF" ] && sed -nE "s/^$1=(.*)$/\1/p" "$ENVF" | tail -1 | tr -d '\r'; }

echo "FS-ENRS source-development preflight  (repo: $REPO)"
echo "----------------------------------------------------------------"

# 1 — Backend runs from the repo
bpid=$(pgrep -f "$REPO/backend/server.js" | head -1)
if [ -n "$bpid" ]; then
  cwd=$(readlink "/proc/$bpid/cwd" 2>/dev/null)
  case "$cwd" in "$REPO"*) pass "backend running from repo (pid=$bpid)";;
                 *) fail "backend pid=$bpid cwd not in repo: $cwd";; esac
else
  fail "backend (server.js) not running from $REPO"
fi

# 2 — No FS-ENRS application container is serving the app
if command -v docker >/dev/null 2>&1; then
  appc=$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -iE 'enrs|fs-cc|piper' || true)
  [ -z "$appc" ] && pass "no FS-ENRS application containers running" \
                 || fail "unexpected FS-ENRS container(s): $(echo "$appc" | tr '\n' ';')"
else
  pass "docker CLI absent — host-source only"
fi

# 3 — Piper reachable on the URL the backend actually uses
pburl=$(envval PIPER_BACKEND_URL); pburl="${pburl:-http://127.0.0.1:5001}"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${pburl%/}/health" 2>/dev/null)
[ "$code" = "200" ] && pass "Piper healthy at PIPER_BACKEND_URL=$pburl" \
                    || fail "Piper NOT reachable at PIPER_BACKEND_URL=$pburl (HTTP ${code:-000}) — is Piper on this host/port?"

# 4 — FreeSWITCH ESL reachable
eslhost=$(envval ESL_HOST); eslhost="${eslhost:-127.0.0.1}"
eslport=$(envval ESL_PORT); eslport="${eslport:-8021}"
if timeout 4 bash -c "echo > /dev/tcp/${eslhost}/${eslport}" 2>/dev/null; then
  pass "FreeSWITCH ESL reachable at ${eslhost}:${eslport}"
else
  fail "FreeSWITCH ESL NOT reachable at ${eslhost}:${eslport} (ESL_HOST/ESL_PORT in backend/.env)"
fi

# 5 — PostgreSQL reachable (TCP only; no auth attempted)
dbhost=$(envval DB_HOST); dbhost="${dbhost:-127.0.0.1}"
dbport=$(envval DB_PORT); dbport="${dbport:-5432}"
if timeout 4 bash -c "echo > /dev/tcp/${dbhost}/${dbport}" 2>/dev/null; then
  pass "PostgreSQL reachable at ${dbhost}:${dbport}"
else
  fail "PostgreSQL NOT reachable at ${dbhost}:${dbport}"
fi

# 6 — PIPER_BACKEND_URL must be a HOST endpoint, not a Docker service name
if echo "$pburl" | grep -qiE '://(piper|postgres|redis|backend|frontend)(:|/|$)'; then
  fail "PIPER_BACKEND_URL uses a Docker service name ($pburl) — host dev must use 127.0.0.1:<port>"
else
  pass "PIPER_BACKEND_URL is a host endpoint ($pburl)"
fi

echo "----------------------------------------------------------------"
if [ "$fails" -eq 0 ]; then
  printf '\033[32mPREFLIGHT: PASS — source development mode is healthy.\033[0m\n'
  exit 0
else
  printf '\033[31mPREFLIGHT: %d check(s) FAILED — see FAIL lines above.\033[0m\n' "$fails"
  exit 1
fi
