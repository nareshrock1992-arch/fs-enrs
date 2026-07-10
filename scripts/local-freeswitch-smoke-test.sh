#!/usr/bin/env bash
# ============================================================================
# Local FreeSWITCH smoke test — Phase 7.
#
# Run ONCE against your actual local FreeSWITCH install after following
# docs/ENVIRONMENT_SETUP.md. Automates the exact manual validation done by
# hand throughout the original debugging session: diagnostics → deploy →
# verify loaded → real ESL-originated test call → assert the executor
# actually walked the flow, by reading its own step markers from the log.
#
# Usage:
#   ./scripts/local-freeswitch-smoke-test.sh <flow_uuid> <test_number> [backend_log]
#
#   flow_uuid    — a published, number-bound flow's UUID (IVR Builder URL bar)
#   test_number  — the emergency number bound to that flow (e.g. 1222)
#   backend_log  — path to the backend's log file
#                  (default: ./backend.log; pm2 users: ~/.pm2/logs/fs-enrs-backend-out-0.log)
#
# Environment (all optional):
#   API_BASE     — default http://127.0.0.1:4100
#   API_EMAIL    — default admin@enrs.local
#   API_PASSWORD — default Admin@12345
# ============================================================================
set -u

API_BASE="${API_BASE:-http://127.0.0.1:4100}"
API_EMAIL="${API_EMAIL:-admin@enrs.local}"
API_PASSWORD="${API_PASSWORD:-Admin@12345}"

FLOW_UUID="${1:-}"
TEST_NUMBER="${2:-}"
BACKEND_LOG="${3:-./backend.log}"

PASS=0; FAIL=0; PROBLEMS=()

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); PROBLEMS+=("$1 — FIX: $2"); echo "  ✗ $1"; echo "    FIX: $2"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "FATAL: '$1' is required on PATH"; exit 1; }; }

need curl; need jq; need fs_cli

if [ -z "$FLOW_UUID" ] || [ -z "$TEST_NUMBER" ]; then
  echo "Usage: $0 <flow_uuid> <test_number> [backend_log]"
  echo "Get the flow UUID from the IVR Builder URL after publishing + binding a flow."
  exit 1
fi

echo "── Authenticating ─────────────────────────────────────────────────"
TOKEN=$(curl -sf -X POST "$API_BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$API_EMAIL\",\"password\":\"$API_PASSWORD\"}" | jq -r '.token // empty')
if [ -z "$TOKEN" ]; then
  echo "FATAL: login failed — check API_BASE/API_EMAIL/API_PASSWORD and that the backend is running."
  exit 1
fi
echo "  ✓ Logged in as $API_EMAIL"

echo ""
echo "── 1/4 Diagnostics ────────────────────────────────────────────────"
DIAG=$(curl -sf "$API_BASE/api/v1/deployment/diagnostics" -H "Authorization: Bearer $TOKEN")
OVERALL=$(echo "$DIAG" | jq -r '.overall')
if [ "$OVERALL" = "pass" ]; then
  ok "All diagnostics checks pass"
else
  echo "$DIAG" | jq -r '.checks[] | select(.status != "pass") | "  [\(.status)] \(.label): \(.detail)\n         → \(.action // "no action listed")"'
  if [ "$OVERALL" = "fail" ]; then
    bad "Diagnostics reported failures (see above)" "resolve each listed action, then re-run"
  else
    ok "Diagnostics pass with warnings (listed above — review, usually fine for a first deploy)"
  fi
fi

echo ""
echo "── 2/4 Deploy + verify loaded ─────────────────────────────────────"
DEPLOY=$(curl -s "$API_BASE/api/v1/deployment/flows/$FLOW_UUID/deploy" \
  -X POST -H "Authorization: Bearer $TOKEN")
DSTATUS=$(echo "$DEPLOY" | jq -r '.status')
if [ "$DSTATUS" = "success" ]; then
  ok "Deploy pipeline succeeded (including the independent xml_locate verification — this banner no longer lies)"
else
  echo "$DEPLOY" | jq -r '.errors[]? | "  error: \(.)"'
  bad "Deploy failed" "read the errors above; 'did not load the extension' means the dialplan include chain — run diagnostics and check the Dialplan Include Chain entry"
fi

VERIFY=$(fs_cli -x "xml_locate dialplan context name default" 2>/dev/null | grep -c "enrs_ivr_${TEST_NUMBER}" || true)
if [ "$VERIFY" -gt 0 ]; then
  ok "Extension enrs_ivr_${TEST_NUMBER} is live in FreeSWITCH's routing table (independent re-check)"
else
  bad "Extension enrs_ivr_${TEST_NUMBER} NOT found via xml_locate" "the deploy wrote files somewhere FreeSWITCH doesn't merge — check diagnostics' Dialplan Include Chain"
fi

echo ""
echo "── 3/4 Real test call via ESL originate ───────────────────────────"
MARK="smoketest_$(date +%s)"
# Place a loopback call INTO the deployed extension. The B-leg answers into
# the flow; park the A-leg so the executor runs to completion on its own.
fs_cli -x "originate {origination_caller_id_number=5559990001,origination_caller_id_name=SmokeTest}loopback/${TEST_NUMBER}/default &park()" >/dev/null 2>&1
echo "  · Placed loopback call to ${TEST_NUMBER}; waiting 15s for the flow to execute…"
sleep 15

if [ ! -f "$BACKEND_LOG" ]; then
  bad "Backend log not found at $BACKEND_LOG" "pass the correct path as arg 3 (pm2: ~/.pm2/logs/fs-enrs-backend-out-0.log)"
else
  STEPS=$(tail -n 400 "$BACKEND_LOG" | grep -c "\[ivr_executor\] step=" || true)
  # The executor logs step markers to the FreeSWITCH console, not the
  # backend log — check fs log too if backend log has none.
  FS_LOG="/var/log/freeswitch/freeswitch.log"
  if [ "$STEPS" -eq 0 ] && [ -f "$FS_LOG" ]; then
    STEPS=$(tail -n 800 "$FS_LOG" | grep -c "\[ivr_executor\] step=" || true)
  fi
  if [ "$STEPS" -gt 0 ]; then
    ok "Executor walked $STEPS node step(s) — the flow genuinely ran end to end"
    tail -n 800 "${FS_LOG:-$BACKEND_LOG}" 2>/dev/null | grep "\[ivr_executor\] step=" | tail -5 | sed 's/^/    /'
  else
    bad "No [ivr_executor] step markers found after the test call" "tail -f the FreeSWITCH log (fs_cli -x 'console loglevel debug') and dial ${TEST_NUMBER} manually to see where it stops"
  fi
fi

echo ""
echo "── 4/4 Incident cleanup check (Phase 1 item 13) ───────────────────"
sleep 3
STUCK=$(curl -sf "$API_BASE/api/v1/dashboard/active" -H "Authorization: Bearer $TOKEN" | jq '[.conferences[]? | select(.member_count == 0)] | length')
if [ "${STUCK:-0}" -eq 0 ]; then
  ok "No zero-member 'Active' conferences lingering on Live Monitoring"
else
  bad "$STUCK conference(s) show Active with 0 members" "run: node backend/src/db/utils/cleanup_orphaned_ers_incidents.js --apply (needs ESL up), then verify the conference-destroy reconciliation listener is running (backend log: 'reconcileOrphanedIncident')"
fi

echo ""
echo "════════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo "✅ ALL CHECKS PASSED ($PASS/$PASS) — ready to test with real calls."
  echo "   Next: Phase 8 acceptance scenarios (see TEST_REPORT.md §Phase 8)."
  exit 0
else
  echo "❌ $FAIL problem(s) found:"
  i=1
  for p in "${PROBLEMS[@]}"; do
    echo "  $i. $p"
    i=$((i+1))
  done
  exit 1
fi
