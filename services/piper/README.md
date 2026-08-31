# Piper TTS Service

Internal HTTP service that provides text-to-speech synthesis for fs-enrs.
Uses the [Piper TTS engine](https://github.com/rhasspy/piper) (piper-tts Python package).

## Architecture

```
React UI
   ↓
fs-enrs backend API  (ttsService / piperService — Phase 2)
   ↓
POST http://piper:5000/synthesize
   ↓
Piper TTS service  (this service)
   ↓
piper-tts Python package (ONNX inference)
   ↓
sox resample → WAV at target sample rate
   ↓
WAV bytes returned to backend
   ↓
Media Library storage → FreeSWITCH playback
```

The browser and FreeSWITCH Lua scripts NEVER call this service directly.
Only the fs-enrs backend calls it.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe — 200 if process is running |
| `GET` | `/ready` | Readiness probe — 200 only if voice model(s) loaded |
| `GET` | `/voices` | List available voice models |
| `POST` | `/synthesize` | Synthesize text to WAV audio |

### POST /synthesize

**Request body (JSON):**

```json
{
  "text":        "Hello, this is a test.",
  "voice":       "en_US-lessac-medium",
  "sample_rate": 8000,
  "channels":    1
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `text` | string | (required) | 1–5000 chars; alphanumeric + punctuation |
| `voice` | string | `en_US-lessac-medium` | Must be a registered, enabled voice |
| `sample_rate` | int | `8000` | Allowed: 8000, 16000, 22050, 44100, 48000 |
| `channels` | int | `1` | 1 (mono) or 2 (stereo) |

**Response:** `audio/wav` bytes with response headers:

| Header | Example | Notes |
|---|---|---|
| `X-Audio-Duration-Sec` | `2.340` | Duration of the generated audio |
| `X-Audio-Sample-Rate` | `8000` | Actual output sample rate |
| `X-Audio-Channels` | `1` | Actual output channels |
| `X-Voice` | `en_US-lessac-medium` | Voice used for synthesis |
| `X-Synthesis-Latency-Ms` | `1234.5` | Total latency including resampling |

## Configuration

Set via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PIPER_MODEL_DIR` | `/app/models` | Directory containing ONNX model files |
| `PIPER_DEFAULT_VOICE` | `en_US-lessac-medium` | Default voice if not specified in request |
| `PIPER_SAMPLE_RATE` | `8000` | Default output sample rate |
| `PIPER_MAX_CONCURRENT` | `2` | Max simultaneous synthesis requests |
| `PIPER_SYNTHESIS_TIMEOUT_SEC` | `30` | Per-request timeout |
| `PIPER_MAX_TEXT_LENGTH` | `5000` | Max input text characters |
| `LOG_LEVEL` | `INFO` | Logging level (DEBUG/INFO/WARNING/ERROR) |

## Models

See `models/README.md` for model download, checksum verification, and the
voice registry. Models are mounted via Docker volume — not baked into the image.

## Running in Docker (standalone test)

```bash
# From repo root
docker build -t fs-enrs-piper:latest services/piper/

docker run --rm -p 5000:5000 \
  -v /opt/freeswitch-ui/enrs-tools/voices:/app/models:ro \
  -e PIPER_SAMPLE_RATE=8000 \
  fs-enrs-piper:latest

# Test
curl http://localhost:5000/health
curl http://localhost:5000/ready
curl http://localhost:5000/voices

curl -s -X POST http://localhost:5000/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello from Piper.","sample_rate":8000}' \
  -o /tmp/test.wav

# Verify WAV format
soxi /tmp/test.wav 2>/dev/null || file /tmp/test.wav
```

## Running tests

```bash
cd services/piper

# Quick tests (no model required)
pip install -r requirements.txt
pytest tests/ -m "not requires_model" -v

# Full tests (model files must be present in models/)
pytest tests/ -v
```

## Security

- This service is an **internal-only** Docker service — never expose port 5000 externally.
- All input is validated against strict allowlists.
- No shell=True subprocess calls (sox is invoked via exec array).
- Voice names are validated against `[A-Za-z0-9_\-\.]+` pattern only.
- Arbitrary file paths from callers are rejected.
