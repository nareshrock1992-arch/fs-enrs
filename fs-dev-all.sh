#!/bin/bash
# fs-dev-all.sh — Lifecycle manager for fs-cc and fs-enrs dev environments.
# Enterprise-grade: waits for ports to free, health-checks backend before
# starting frontend, confirms both services are reachable before reporting ready.

set -euo pipefail

FS_CC="/opt/freeswitch-ui/fs-cc"
FS_ENRS="/opt/freeswitch-ui/fs-enrs"

# ─── Helpers ────────────────────────────────────────────────────────────────

# Kill Vite, esbuild, and npm run dev processes (best-effort, never fails).
kill_vite() {
  pkill -f "vite"              2>/dev/null || true
  pkill -f "esbuild"           2>/dev/null || true
  pkill -f "npm run dev"       2>/dev/null || true
  pkill -f "node_modules/.bin/vite" 2>/dev/null || true
}

# Wait up to MAX_WAIT seconds for a TCP port to stop listening.
# Forcibly kills the occupant if still stuck after MAX_WAIT.
wait_port_free() {
  local port=$1
  local max=30
  local i=0
  while ss -ltnp 2>/dev/null | grep -q " :${port} \| :${port}$"; do
    if [ "$i" -ge "$max" ]; then
      echo "  Port $port still occupied after ${max}s — force-killing occupant..."
      fuser -k "${port}/tcp" 2>/dev/null || true
      sleep 2
      return
    fi
    echo "  Waiting for port $port to free... (${i}s)"
    sleep 1
    i=$((i + 1))
  done
  echo "  Port $port is free."
}

# Wait up to MAX_WAIT seconds for an HTTP health endpoint to return 2xx.
wait_http_ready() {
  local url=$1
  local label=${2:-"$url"}
  local max=45
  local i=0
  echo "  Waiting for $label..."
  while ! curl -sf --max-time 2 "$url" >/dev/null 2>&1; do
    if [ "$i" -ge "$max" ]; then
      echo "  ✗ $label did not become ready after ${max}s."
      return 1
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "  ✓ $label is ready (${i}s)."
}

# Wait up to MAX_WAIT seconds for a TCP port to start listening.
wait_port_listening() {
  local port=$1
  local label=${2:-"port $port"}
  local max=45
  local i=0
  echo "  Waiting for $label on port $port..."
  while ! ss -ltnp 2>/dev/null | grep -q " :${port} \| :${port}$"; do
    if [ "$i" -ge "$max" ]; then
      echo "  ✗ $label did not start listening on port $port after ${max}s."
      return 1
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "  ✓ $label listening on port $port (${i}s)."
}

# ─── FS-CC Controls ─────────────────────────────────────────────────────────

start_cc() {
  echo "Starting fs-cc..."
  pm2 start "$FS_CC/ecosystem.config.js"
  cd "$FS_CC/frontend"      && npm run dev -- --host 0.0.0.0 --port 8000 &
  cd "$FS_CC/agent-desktop" && npm run dev -- --host 0.0.0.0 --port 8080 &
  echo "fs-cc started."
}

stop_cc() {
  echo "Stopping fs-cc..."
  pm2 stop   fs-backend  2>/dev/null || true
  pm2 delete fs-frontend 2>/dev/null || true
  pm2 delete fs-agent    2>/dev/null || true
  kill_vite
  echo "fs-cc stopped."
}

status_cc() {
  echo "FS-CC Status:"
  pm2 status fs-backend
  ss -ltnp | grep -q ":8000" && echo "  Frontend :8000 OK" || echo "  Frontend :8000 DOWN"
  ss -ltnp | grep -q ":8080" && echo "  Agent    :8080 OK" || echo "  Agent    :8080 DOWN"
  ss -ltnp | grep -q ":4000" && echo "  Backend  :4000 OK" || echo "  Backend  :4000 DOWN"
}

logs_cc() {
  echo "FS-CC Logs:"
  pm2 logs fs-backend --lines 20
}

# ─── FS-ENRS Controls ───────────────────────────────────────────────────────

start_enrs() {
  echo ""
  echo "========================================"
  echo "  Starting fs-enrs Development Environment"
  echo "========================================"

  # 1. Tear down anything already running.
  echo ""
  echo "[1/5] Stopping existing processes..."
  pm2 stop   fs-enrs-backend 2>/dev/null || true
  pm2 delete fs-enrs-backend 2>/dev/null || true
  kill_vite

  # 2. Wait until ports are free before starting.
  echo ""
  echo "[2/5] Waiting for ports to clear..."
  wait_port_free 4100
  wait_port_free 8100

  # 3. Start backend via PM2 in development mode.
  #    --env development selects the env_development block in ecosystem.config.cjs,
  #    ensuring NODE_ENV=development regardless of the default env block.
  echo ""
  echo "[3/5] Starting backend (PM2)..."
  pm2 start "$FS_ENRS/backend/ecosystem.config.cjs" --env development

  # 4. Block until the backend health endpoint responds.
  #    This guarantees the frontend proxy target is live before Vite starts.
  echo ""
  echo "[4/5] Waiting for backend to be healthy..."
  if wait_http_ready "http://localhost:4100/api/health" "Backend :4100"; then
    echo ""
    echo "  ✓ Backend Ready"
  else
    echo ""
    echo "  ✗ Backend failed to start. Check logs: pm2 logs fs-enrs-backend"
    echo "    Aborting frontend start."
    return 1
  fi

  # 5. Start frontend only after backend is confirmed healthy.
  echo ""
  echo "[5/5] Starting frontend (Vite)..."
  cd "$FS_ENRS/frontend" && npm run dev -- --host 0.0.0.0 --port 8100 &

  if wait_http_ready "http://localhost:8100/" "Frontend (Vite)"; then
    echo ""
    echo "  ✓ Frontend Ready"
  else
    echo ""
    echo "  ✗ Frontend did not start on :8100. Check Vite output above."
    return 1
  fi

  echo ""
  echo "========================================"
  echo "  ENRS Development Environment Ready"
  echo "  Backend  : http://localhost:4100"
  echo "  Frontend : http://localhost:8100"
  echo "========================================"
  echo ""
}

stop_enrs() {
  echo "Stopping fs-enrs..."
  pm2 stop   fs-enrs-backend 2>/dev/null || true
  pm2 delete fs-enrs-backend 2>/dev/null || true
  kill_vite
  # Brief pause so port listeners drain before caller tries to start again.
  sleep 1
  echo "fs-enrs stopped."
}

restart_enrs() {
  stop_enrs
  start_enrs
}

status_enrs() {
  echo "FS-ENRS Status:"
  pm2 status fs-enrs-backend 2>/dev/null || echo "  (not registered in PM2)"
  ss -ltnp 2>/dev/null | grep -q ":8100" \
    && echo "  Frontend :8100 OK" || echo "  Frontend :8100 DOWN"
  ss -ltnp 2>/dev/null | grep -q ":4100" \
    && echo "  Backend  :4100 OK" || echo "  Backend  :4100 DOWN"
  # Quick health check
  if curl -sf --max-time 2 "http://localhost:4100/api/health" >/dev/null 2>&1; then
    echo "  Health   :4100 OK"
  else
    echo "  Health   :4100 FAIL"
  fi
}

logs_enrs() {
  echo "FS-ENRS Backend Logs:"
  pm2 logs fs-enrs-backend --lines 20
}

# ─── Combined Controls ───────────────────────────────────────────────────────

start_all() {
  start_cc
  start_enrs
}

stop_all() {
  stop_cc
  stop_enrs
}

restart_all() {
  stop_all
  start_all
}

status_all() {
  status_cc
  echo ""
  status_enrs
}

logs_all() {
  logs_cc
  echo ""
  logs_enrs
}

# ─── Command Router ───────────────────────────────────────────────────────────

case "${1:-}" in
  --start-cc)     start_cc     ;;
  --stop-cc)      stop_cc      ;;
  --status-cc)    status_cc    ;;
  --logs-cc)      logs_cc      ;;

  --start-enrs)   start_enrs   ;;
  --stop-enrs)    stop_enrs    ;;
  --restart-enrs) restart_enrs ;;
  --status-enrs)  status_enrs  ;;
  --logs-enrs)    logs_enrs    ;;

  --start-all)    start_all    ;;
  --stop-all)     stop_all     ;;
  --restart-all)  restart_all  ;;
  --status-all)   status_all   ;;
  --logs-all)     logs_all     ;;

  *)
    echo "Usage:"
    echo "  ./fs-dev-all.sh --start-cc      Start fs-cc backend + frontend"
    echo "  ./fs-dev-all.sh --stop-cc       Stop  fs-cc"
    echo "  ./fs-dev-all.sh --status-cc     Status fs-cc"
    echo "  ./fs-dev-all.sh --logs-cc       Tail  fs-cc backend logs"
    echo ""
    echo "  ./fs-dev-all.sh --start-enrs    Start fs-enrs (waits for health)"
    echo "  ./fs-dev-all.sh --stop-enrs     Stop  fs-enrs"
    echo "  ./fs-dev-all.sh --restart-enrs  Full stop + start with port checks"
    echo "  ./fs-dev-all.sh --status-enrs   Status + health check"
    echo "  ./fs-dev-all.sh --logs-enrs     Tail  fs-enrs backend logs"
    echo ""
    echo "  ./fs-dev-all.sh --start-all     Start both"
    echo "  ./fs-dev-all.sh --stop-all      Stop  both"
    echo "  ./fs-dev-all.sh --restart-all   Restart both"
    echo "  ./fs-dev-all.sh --status-all    Status both"
    echo "  ./fs-dev-all.sh --logs-all      Logs  both"
    ;;
esac
