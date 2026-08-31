"""
Piper TTS HTTP service for fs-enrs.

Exposes a simple HTTP API over the Piper TTS engine:
  POST /synthesize  — synthesize text to WAV audio
  GET  /health      — liveness probe (always 200 if process is running)
  GET  /ready       — readiness probe (200 only if voice model(s) are loaded)
  GET  /voices      — list available voice models

Architecture:
  - FastAPI + uvicorn (async HTTP)
  - piper-tts Python package for synthesis (synchronous/CPU-bound)
  - Synthesis runs in a thread executor to avoid blocking the event loop
  - Bounded concurrency via asyncio.Semaphore (PIPER_MAX_CONCURRENT)
  - sox for audio resampling when target ≠ native sample rate

Security:
  - Input validation on all fields (text length, voice allowlist, rate allowlist)
  - No arbitrary file paths accepted from callers
  - No shell=True subprocess calls
  - Service should be reachable only from the fs-enrs backend (private Docker network)
"""

import asyncio
import io
import logging
import os
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from src.voices import voice_loader
from src.audio import resample_wav, validate_audio_params

# ── Logging ───────────────────────────────────────────────────────────────────

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("piper.server")

# ── Configuration ─────────────────────────────────────────────────────────────

DEFAULT_VOICE        = os.environ.get("PIPER_DEFAULT_VOICE", "en_US-lessac-medium")
DEFAULT_SAMPLE_RATE  = int(os.environ.get("PIPER_SAMPLE_RATE", "8000"))
MAX_CONCURRENT       = int(os.environ.get("PIPER_MAX_CONCURRENT", "2"))
SYNTHESIS_TIMEOUT    = float(os.environ.get("PIPER_SYNTHESIS_TIMEOUT_SEC", "30"))
MAX_TEXT_LENGTH      = int(os.environ.get("PIPER_MAX_TEXT_LENGTH", "5000"))

# ── App and shared state ──────────────────────────────────────────────────────

_semaphore: asyncio.Semaphore | None = None
_executor:  ThreadPoolExecutor | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _semaphore, _executor

    logger.info("Piper TTS service starting — loading voices from %s",
                os.environ.get("PIPER_MODEL_DIR", "/app/models"))

    try:
        loaded = voice_loader.load_all()
        logger.info("Voices loaded: %s", loaded)
    except RuntimeError as exc:
        logger.critical("Startup failed: %s", exc)
        # Don't crash — /health will return 200 but /ready returns 503
        # so orchestrators can detect the degraded state.

    _semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    _executor  = ThreadPoolExecutor(max_workers=MAX_CONCURRENT, thread_name_prefix="piper")

    logger.info(
        "Piper TTS ready  default_voice=%s  default_rate=%d  max_concurrent=%d",
        DEFAULT_VOICE, DEFAULT_SAMPLE_RATE, MAX_CONCURRENT,
    )

    yield

    if _executor:
        _executor.shutdown(wait=True)
    logger.info("Piper TTS service stopped")


app = FastAPI(title="Piper TTS", version="1.0.0", docs_url=None, redoc_url=None, lifespan=lifespan)


# ── Request / response models ─────────────────────────────────────────────────

class SynthesizeRequest(BaseModel):
    text:        str   = Field(..., min_length=1, max_length=MAX_TEXT_LENGTH)
    voice:       str   = Field(DEFAULT_VOICE)
    sample_rate: int   = Field(DEFAULT_SAMPLE_RATE, ge=8000, le=48000)
    channels:    int   = Field(1, ge=1, le=2)

    @field_validator("text")
    @classmethod
    def text_not_blank(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("text must not be blank or whitespace-only")
        return stripped

    @field_validator("voice")
    @classmethod
    def voice_safe(cls, v: str) -> str:
        # Allowlist: only alphanumeric, hyphens, underscores, dots
        import re
        if not re.fullmatch(r"[A-Za-z0-9_\-\.]+", v):
            raise ValueError("voice contains invalid characters")
        return v


# ── Synthesis ─────────────────────────────────────────────────────────────────

def _synthesize_sync(text: str, voice_id: str) -> bytes:
    """
    Synchronous synthesis — runs in a thread executor.
    Returns WAV bytes at the model's native sample rate.
    """
    piper_voice = voice_loader.get(voice_id)
    if piper_voice is None:
        raise ValueError(f"Voice not loaded: {voice_id}")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        # synthesize_wav sets WAV format from model config (set_wav_format=True default)
        # and writes all audio frames. The native rate is whatever the model emits
        # (22050 Hz for lessac-medium); sox resamples to the requested rate afterward.
        piper_voice.synthesize_wav(text, wav_file)

    return buf.getvalue()


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    if not voice_loader.is_ready():
        return JSONResponse(status_code=503, content={"status": "not_ready", "reason": "no voices loaded"})
    return {"status": "ready", "voices": [v["id"] for v in voice_loader.list_voices()]}


@app.get("/voices")
async def list_voices():
    return {"voices": voice_loader.list_voices()}


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest, http_request: Request):
    # Check voice is available
    if voice_loader.get(req.voice) is None:
        available = [v["id"] for v in voice_loader.list_voices()]
        raise HTTPException(
            status_code=400,
            detail={"error": "voice_unavailable", "voice": req.voice, "available": available},
        )

    # Validate target audio params (allowlist check)
    try:
        validate_audio_params(req.sample_rate, req.channels)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid_audio_params", "detail": str(exc)})

    start = time.monotonic()
    request_id = http_request.headers.get("x-request-id", "-")

    logger.info(
        "synthesize  req=%s  voice=%s  rate=%d  text_len=%d",
        request_id, req.voice, req.sample_rate, len(req.text),
    )

    async with _semaphore:
        loop = asyncio.get_event_loop()
        try:
            wav_bytes = await asyncio.wait_for(
                loop.run_in_executor(_executor, _synthesize_sync, req.text, req.voice),
                timeout=SYNTHESIS_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.error("synthesize  req=%s  timeout after %.1fs", request_id, SYNTHESIS_TIMEOUT)
            raise HTTPException(status_code=504, detail={"error": "synthesis_timeout"})
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": "synthesis_error", "detail": str(exc)})
        except Exception as exc:
            logger.error("synthesize  req=%s  error: %s", request_id, exc, exc_info=True)
            raise HTTPException(status_code=500, detail={"error": "synthesis_failed"})

        # Resample if needed
        try:
            wav_bytes = await resample_wav(wav_bytes, req.sample_rate, req.channels)
        except Exception as exc:
            logger.error("synthesize  req=%s  resample error: %s", request_id, exc)
            raise HTTPException(status_code=500, detail={"error": "resample_failed", "detail": str(exc)})

    elapsed = time.monotonic() - start

    # Read final WAV metadata for response headers
    import struct
    duration_sec = 0.0
    try:
        with wave.open(io.BytesIO(wav_bytes)) as wf:
            duration_sec = wf.getnframes() / wf.getframerate()
    except Exception:
        pass

    logger.info(
        "synthesize  req=%s  voice=%s  rate=%d  duration=%.3fs  bytes=%d  latency=%.3fs",
        request_id, req.voice, req.sample_rate, duration_sec, len(wav_bytes), elapsed,
    )

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Audio-Duration-Sec":  f"{duration_sec:.3f}",
            "X-Audio-Sample-Rate":   str(req.sample_rate),
            "X-Audio-Channels":      str(req.channels),
            "X-Voice":               req.voice,
            "X-Synthesis-Latency-Ms": f"{elapsed * 1000:.1f}",
        },
    )
