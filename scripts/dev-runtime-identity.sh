#!/usr/bin/env bash
# ============================================================================
# dev-runtime-identity.sh — "Am I running the current local source repo?"
#
# Read-only. Prints, at a glance, WHAT FS-ENRS runtime is actually live on this
# host and WHERE it executes from, so a developer or Claude session can confirm
# the server is in FS-ENRS DEFAULT DEVELOPMENT MODE:
#
#     LOCAL CHECKED-OUT SOURCE REPOSITORY  (never a Docker image/container)
#
# It NEVER starts, stops, builds, or modifies anything. Safe to run any time.
#
# Usage:
#   scripts/dev-runtime-identity.sh
#   FS_ENRS_ROOT=/custom/path scripts/dev-runtime-identity.sh
# ============================================================================
set -uo pipefail

REPO="${FS_ENRS_ROOT:-/opt/freeswitch-ui/fs-enrs}"
BACKEND_PORT="${ENRS_BACKEND_PORT:-4100}"
PIPER_PORT="${PIPER_PORT:-5001}"
FRONTEND_PORT="${ENRS_FRONTEND_PORT:-8100}"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }

# Resolve the working directory of a PID (empty if none).
pid_cwd() { readlink "/proc/$1/cwd" 2>/dev/null; }

echo "========================================"
echo "FS-ENRS DEVELOPMENT RUNTIME"
echo "========================================"

# ── Source root + git ────────────────────────────────────────────────────────
echo "SOURCE ROOT:"
echo "  $REPO"
if [ -d "$REPO/.git" ]; then
  git config --global --add safe.directory "$REPO" >/dev/null 2>&1 || true
  echo "GIT:"
  echo "  branch: $(git -C "$REPO" branch --show-current 2>/dev/null || echo '?')"
  echo "  commit: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?')"
  dirty=$(git -C "$REPO" status --short 2>/dev/null | wc -l | tr -d ' ')
  echo "  dirty files: $dirty"
else
  red "  (not a git repository — is FS_ENRS_ROOT correct?)"
fi

# ── Backend ──────────────────────────────────────────────────────────────────
echo "BACKEND:"
bpid=$(pgrep -f "$REPO/backend/server.js" | head -1)
if [ -n "$bpid" ]; then
  cwd=$(pid_cwd "$bpid")
  case "$cwd" in
    "$REPO"*) green "  SOURCE  (cwd=$cwd  pid=$bpid  port=$BACKEND_PORT)";;
    *)        red   "  RUNNING but cwd NOT in repo: $cwd  pid=$bpid";;
  esac
else
  # Any node server.js NOT from this repo? (would indicate wrong checkout)
  other=$(pgrep -af 'backend/server.js' | grep -v "$REPO" | head -1)
  [ -n "$other" ] && red "  NOT from repo: $other" || red "  NOT RUNNING"
fi

# ── Frontend ─────────────────────────────────────────────────────────────────
echo "FRONTEND:"
fpid=""
for p in $(pgrep -f 'vite' 2>/dev/null); do
  c=$(pid_cwd "$p"); case "$c" in "$REPO/frontend"*) fpid=$p; fcwd=$c; break;; esac
done
if [ -n "$fpid" ]; then
  green "  SOURCE  (cwd=$fcwd  pid=$fpid  port=$FRONTEND_PORT)"
else
  echo "  (Vite for this repo not currently running — start with: cd $REPO/frontend && npm run dev)"
fi

# ── Piper (host service) ─────────────────────────────────────────────────────
echo "PIPER:"
ppid=$(pgrep -f 'uvicorn src.server:app' | head -1)
health=$(curl -s --max-time 4 "http://127.0.0.1:${PIPER_PORT}/health" 2>/dev/null)
if [ -n "$ppid" ] && echo "$health" | grep -q '"status":"ok"'; then
  green "  HOST SERVICE  (127.0.0.1:${PIPER_PORT}  pid=$ppid  HEALTH: OK)"
elif [ -n "$health" ]; then
  echo "  HOST SERVICE  (127.0.0.1:${PIPER_PORT}  HEALTH: $health)"
else
  red "  UNREACHABLE on 127.0.0.1:${PIPER_PORT}  (systemctl status piper-tts)"
fi

# ── FreeSWITCH (host systemd) ────────────────────────────────────────────────
echo "FREESWITCH:"
fspid=$(pgrep -f '/opt/freeswitch/bin/freeswitch' | head -1)
if [ -n "$fspid" ]; then
  esl=$( (ss -lntp 2>/dev/null | grep -q ':8021') && echo 'ESL:8021 listening' || echo 'ESL:8021 NOT listening')
  green "  HOST SYSTEMD  (pid=$fspid  $esl)"
else
  red "  NOT RUNNING"
fi

# ── Docker: any FS-ENRS *application* containers? ────────────────────────────
echo "DOCKER:"
if command -v docker >/dev/null 2>&1; then
  appc=$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null \
          | grep -iE 'enrs|fs-cc|piper|frontend|backend|agent-desktop' || true)
  if [ -z "$appc" ]; then
    green "  FS-ENRS APPLICATION CONTAINERS: NONE"
  else
    red   "  FS-ENRS APPLICATION CONTAINER(S) RUNNING (unexpected for source dev):"
    echo "$appc" | sed 's/^/    /'
  fi
else
  green "  docker CLI not present — application is host-source only"
fi

echo "========================================"
# Final verdict line: SOURCE mode requires backend running from the repo AND no app containers.
if [ -n "${bpid:-}" ] && case "$(pid_cwd "${bpid:-0}")" in "$REPO"*) true;; *) false;; esac \
   && { ! command -v docker >/dev/null 2>&1 || [ -z "$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -iE 'enrs|fs-cc|piper' || true)" ]; }; then
  green "SOURCE DEVELOPMENT MODE: VERIFIED"
else
  red   "SOURCE DEVELOPMENT MODE: NOT VERIFIED  (see red lines above)"
fi
echo "========================================"
