# Piper TTS service for fs-enrs
#
# Build:  docker build -t fs-enrs-piper:latest services/piper/
# Run:    docker run -p 5000:5000 \
#           -v /path/to/models:/app/models:ro \
#           -e PIPER_DEFAULT_VOICE=en_US-lessac-medium \
#           -e PIPER_SAMPLE_RATE=8000 \
#           fs-enrs-piper:latest
#
# Models are NOT baked into this image — mount them via a Docker volume.
# See services/piper/models/README.md for model download and checksum info.

FROM python:3.11-slim AS base

# System dependencies:
#   sox     — audio format conversion / resampling
#   libsndfile1 — audio I/O (used by piper-tts / soundfile dep)
RUN apt-get update && apt-get install -y --no-install-recommends \
        sox \
        libsox-fmt-all \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# ── Install Python dependencies ───────────────────────────────────────────────

WORKDIR /app

COPY requirements.txt .

# piper-tts requires onnxruntime which has a large native dep.
# Install in a separate layer so code changes don't re-download it.
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# ── Copy application source ───────────────────────────────────────────────────

COPY src/ ./src/

# ── Runtime config ────────────────────────────────────────────────────────────

# Models are mounted at runtime — this is the default mount point.
ENV PIPER_MODEL_DIR=/app/models

# Default voice (must match a key in voices.py VOICE_REGISTRY)
ENV PIPER_DEFAULT_VOICE=en_US-lessac-medium

# Target output sample rate for FreeSWITCH telephony (configurable)
ENV PIPER_SAMPLE_RATE=8000

# Max simultaneous synthesis requests (CPU-bound; tune to host core count)
ENV PIPER_MAX_CONCURRENT=2

# Per-request synthesis timeout in seconds
ENV PIPER_SYNTHESIS_TIMEOUT_SEC=30

# Max input text length (characters)
ENV PIPER_MAX_TEXT_LENGTH=5000

ENV LOG_LEVEL=INFO

# Non-root user
RUN groupadd --gid 1001 piper && useradd --uid 1001 --gid piper --no-create-home piper
USER piper

EXPOSE 5000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:5000/health')" || exit 1

CMD ["python3", "-m", "uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "5000", "--workers", "1"]
