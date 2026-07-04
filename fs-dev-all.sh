#!/bin/bash

FS_CC="/opt/freeswitch-ui/fs-cc"
FS_ENRS="/opt/freeswitch-ui/fs-enrs"

# -------------------------
# Helper: Kill Vite + Node
# -------------------------
kill_vite() {
  pkill -f "vite" 2>/dev/null
  pkill -f "esbuild" 2>/dev/null
  pkill -f "npm run dev" 2>/dev/null
  pkill -f "node_modules/.bin/vite" 2>/dev/null
}

# -------------------------
# FS‑CC Controls
# -------------------------
start_cc() {
  echo "🚀 Starting fs‑cc..."
  pm2 start "$FS_CC/ecosystem.config.js"
  cd "$FS_CC/frontend" && npm run dev -- --host 0.0.0.0 --port 8000 &
  cd "$FS_CC/agent-desktop" && npm run dev -- --host 0.0.0.0 --port 8080 &
  echo "✅ fs‑cc started."
}

stop_cc() {
  echo "🛑 Stopping fs‑cc..."
  pm2 stop fs-backend 2>/dev/null
  pm2 delete fs-frontend 2>/dev/null
  pm2 delete fs-agent 2>/dev/null
  kill_vite
  echo "🛑 fs‑cc stopped."
}

status_cc() {
  echo "📊 FS‑CC Status:"
  pm2 status fs-backend
  ss -ltnp | grep -q ":8000" && echo "Frontend 8000 OK" || echo "Frontend 8000 DOWN"
  ss -ltnp | grep -q ":8080" && echo "Agent 8080 OK" || echo "Agent 8080 DOWN"
  ss -ltnp | grep -q ":4000" && echo "Backend 4000 OK" || echo "Backend 4000 DOWN"
}

logs_cc() {
  echo "📜 FS‑CC Logs:"
  pm2 logs fs-backend --lines 20
}

# -------------------------
# FS‑ENRS Controls
# -------------------------
start_enrs() {
  echo "🚀 Starting fs‑enrs..."
  pm2 start "$FS_ENRS/backend/ecosystem.config.cjs" --name fs-enrs-backend
  cd "$FS_ENRS/frontend" && npm run dev -- --host 0.0.0.0 --port 8100 &
  echo "✅ fs‑enrs started."
}

stop_enrs() {
  echo "🛑 Stopping fs‑enrs..."
  pm2 stop fs-enrs-backend 2>/dev/null
  pm2 delete fs-enrs-backend 2>/dev/null
  kill_vite
  echo "🛑 fs‑enrs stopped."
}

status_enrs() {
  echo "📊 FS‑ENRS Status:"
  pm2 status fs-enrs-backend
  ss -ltnp | grep -q ":8100" && echo "Frontend 8100 OK" || echo "Frontend 8100 DOWN"
  ss -ltnp | grep -q ":4100" && echo "Backend 4100 OK" || echo "Backend 4100 DOWN"
}

logs_enrs() {
  echo "📜 FS‑ENRS Logs:"
  pm2 logs fs-enrs-backend --lines 20
}

# -------------------------
# Combined Controls
# -------------------------
start_all() {
  start_cc
  start_enrs
}

stop_all() {
  stop_cc
  stop_enrs
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

# -------------------------
# Command Router
# -------------------------
case "$1" in
  --start-cc) start_cc ;;
  --stop-cc) stop_cc ;;
  --status-cc) status_cc ;;
  --logs-cc) logs_cc ;;

  --start-enrs) start_enrs ;;
  --stop-enrs) stop_enrs ;;
  --status-enrs) status_enrs ;;
  --logs-enrs) logs_enrs ;;

  --start-all) start_all ;;
  --stop-all) stop_all ;;
  --status-all) status_all ;;
  --logs-all) logs_all ;;

  *)
    echo "ℹ️ Usage:"
    echo "   ./fs-dev-all.sh --start-cc"
    echo "   ./fs-dev-all.sh --stop-cc"
    echo "   ./fs-dev-all.sh --status-cc"
    echo "   ./fs-dev-all.sh --logs-cc"
    echo ""
    echo "   ./fs-dev-all.sh --start-enrs"
    echo "   ./fs-dev-all.sh --stop-enrs"
    echo "   ./fs-dev-all.sh --status-enrs"
    echo "   ./fs-dev-all.sh --logs-enrs"
    echo ""
    echo "   ./fs-dev-all.sh --start-all"
    echo "   ./fs-dev-all.sh --stop-all"
    echo "   ./fs-dev-all.sh --status-all"
    echo "   ./fs-dev-all.sh --logs-all"
    ;;
esac
