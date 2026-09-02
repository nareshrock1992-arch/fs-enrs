#!/usr/bin/env bash
# start-dev.sh — Source-level development startup for the Piper TTS service.
#
# Usage:
#   cd services/piper
#   bash start-dev.sh
#
# Required configuration (set in .env.dev or as environment variables before running):
#   PIPER_MODEL_DIR  — absolute path to the directory containing .onnx voice model files
#
# Optional overrides:
#   PIPER_HOST            (default: 127.0.0.1)
#   PIPER_PORT            (default: 5002)
#   PIPER_DEFAULT_VOICE   (default: en_US-lessac-medium)
#   PIPER_SAMPLE_RATE     (default: 8000)
#   PIPER_MAX_CONCURRENT  (default: 2)
#   LOG_LEVEL             (default: INFO)
#
# The virtualenv must already be set up: python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
# The venv is looked for as .venv/ relative to the script's directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source .env.dev if present (DEV-specific, gitignored)
ENV_FILE="${SCRIPT_DIR}/.env.dev"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
  echo "[piper-start-dev] Loaded ${ENV_FILE}"
fi

# Validate required configuration
if [[ -z "${PIPER_MODEL_DIR:-}" ]]; then
  echo "[piper-start-dev] ERROR: PIPER_MODEL_DIR is not set." >&2
  echo "[piper-start-dev]        Set it in .env.dev or export it before running this script." >&2
  echo "[piper-start-dev]        Example: PIPER_MODEL_DIR=/opt/freeswitch-ui/enrs-tools/voices bash start-dev.sh" >&2
  exit 1
fi

if [[ ! -d "${PIPER_MODEL_DIR}" ]]; then
  echo "[piper-start-dev] ERROR: PIPER_MODEL_DIR does not exist: ${PIPER_MODEL_DIR}" >&2
  exit 1
fi

# Check for .onnx files
onnx_count=$(find "${PIPER_MODEL_DIR}" -maxdepth 1 -name '*.onnx' | wc -l)
if [[ "${onnx_count}" -eq 0 ]]; then
  echo "[piper-start-dev] WARNING: No .onnx files found in PIPER_MODEL_DIR=${PIPER_MODEL_DIR}" >&2
  echo "[piper-start-dev]          Service will start but /ready will return 503." >&2
fi

export PIPER_MODEL_DIR

VENV="${SCRIPT_DIR}/.venv"
if [[ ! -x "${VENV}/bin/python3" ]]; then
  echo "[piper-start-dev] ERROR: virtualenv not found at ${VENV}" >&2
  echo "[piper-start-dev]        Run: python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

HOST="${PIPER_HOST:-127.0.0.1}"
PORT="${PIPER_PORT:-5002}"

echo "[piper-start-dev] PIPER_MODEL_DIR=${PIPER_MODEL_DIR} (${onnx_count} model(s))"
echo "[piper-start-dev] Starting uvicorn on ${HOST}:${PORT}"

cd "${SCRIPT_DIR}"
exec "${VENV}/bin/uvicorn" src.server:app \
  --host "${HOST}" \
  --port "${PORT}" \
  --workers 1
