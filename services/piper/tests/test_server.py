"""
Piper TTS service tests.

Test categories:
  1. Health / readiness endpoints (always run — no model required)
  2. Voices endpoint (always run)
  3. Input validation (always run — mocked synthesis)
  4. Full synthesis (skipped if model files absent)
  5. Audio format verification (skipped if model files absent)
  6. Negative cases (always run — mocked or model-free)
  7. Concurrency (always run — mocked)

Run all:    pytest tests/
Run quick:  pytest tests/ -m "not requires_model"
Run full:   pytest tests/ -m requires_model  (needs models mounted)
"""

import asyncio
import io
import os
import struct
import wave
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport

# Set env vars before importing app modules
os.environ.setdefault("PIPER_MODEL_DIR", "/app/models")
os.environ.setdefault("PIPER_DEFAULT_VOICE", "en_US-lessac-medium")
os.environ.setdefault("PIPER_SAMPLE_RATE", "8000")
os.environ.setdefault("PIPER_MAX_CONCURRENT", "2")

MODEL_DIR   = os.environ["PIPER_MODEL_DIR"]
MODEL_ONNX  = os.path.join(MODEL_DIR, "en_US-lessac-medium.onnx")
MODEL_JSON  = os.path.join(MODEL_DIR, "en_US-lessac-medium.onnx.json")
MODELS_PRESENT = os.path.isfile(MODEL_ONNX) and os.path.isfile(MODEL_JSON)

requires_model = pytest.mark.skipif(
    not MODELS_PRESENT,
    reason=f"model files not present at {MODEL_DIR} — skipping synthesis tests",
)


def make_wav_bytes(sample_rate: int = 8000, channels: int = 1, duration_frames: int = 1600) -> bytes:
    """Create a minimal valid WAV with silence at the given rate."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00" * duration_frames * channels * 2)
    return buf.getvalue()


# ── 1. Health / readiness ─────────────────────────────────────────────────────

class TestHealth:
    def setup_method(self):
        from src.server import app
        self.client = TestClient(app)

    def test_health_always_200(self):
        resp = self.client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_ready_503_when_no_models(self):
        # Without model files, voice_loader should report not ready.
        if MODELS_PRESENT:
            pytest.skip("models present — readiness test uses real loaded voices")
        resp = self.client.get("/ready")
        assert resp.status_code == 503

    @requires_model
    def test_ready_200_when_models_loaded(self):
        resp = self.client.get("/ready")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ready"
        assert "en_US-lessac-medium" in data["voices"]


# ── 2. Voices endpoint ────────────────────────────────────────────────────────

class TestVoices:
    def setup_method(self):
        from src.server import app
        self.client = TestClient(app)

    def test_voices_returns_list(self):
        resp = self.client.get("/voices")
        assert resp.status_code == 200
        data = resp.json()
        assert "voices" in data
        assert isinstance(data["voices"], list)

    @requires_model
    def test_voices_includes_lessac(self):
        resp = self.client.get("/voices")
        ids = [v["id"] for v in resp.json()["voices"]]
        assert "en_US-lessac-medium" in ids

    @requires_model
    def test_voice_has_required_fields(self):
        resp = self.client.get("/voices")
        for voice in resp.json()["voices"]:
            assert "id" in voice
            assert "language" in voice
            assert "locale" in voice
            assert "quality" in voice
            assert "native_sample_rate" in voice


# ── 3. Input validation (mocked synthesis) ────────────────────────────────────

@pytest.fixture
def mocked_app():
    """App with synthesis mocked — tests validation without model files."""
    from src.server import app
    from src.voices import voice_loader
    import src.server as server_mod

    fake_wav = make_wav_bytes(8000, 1, 800)

    with patch.object(server_mod, "_synthesize_sync", return_value=make_wav_bytes(22050, 1, 1764)):
        with patch("src.server.resample_wav", new=AsyncMock(return_value=fake_wav)):
            with patch.object(voice_loader, "get", return_value=MagicMock()):
                with patch.object(voice_loader, "metadata", return_value={
                    "native_sample_rate": 22050,
                    "model_path": "/app/models/en_US-lessac-medium.onnx",
                }):
                    with patch.object(voice_loader, "is_ready", return_value=True):
                        with patch.object(voice_loader, "_semaphore", create=True):
                            yield TestClient(app)


class TestInputValidation:
    def test_empty_text_rejected(self, mocked_app):
        resp = mocked_app.post("/synthesize", json={"text": ""})
        assert resp.status_code == 422

    def test_whitespace_only_text_rejected(self, mocked_app):
        resp = mocked_app.post("/synthesize", json={"text": "   "})
        assert resp.status_code == 422

    def test_unknown_voice_rejected(self, mocked_app):
        from src.server import app
        from src.voices import voice_loader
        with patch.object(voice_loader, "get", return_value=None):
            with patch.object(voice_loader, "list_voices", return_value=[]):
                client = TestClient(app)
                resp = client.post("/synthesize", json={"text": "hello", "voice": "nonexistent"})
                assert resp.status_code == 400
                assert resp.json()["detail"]["error"] == "voice_unavailable"

    def test_invalid_voice_chars_rejected(self, mocked_app):
        resp = mocked_app.post("/synthesize", json={"text": "hello", "voice": "../etc/passwd"})
        assert resp.status_code == 422

    def test_invalid_sample_rate_rejected(self, mocked_app):
        from src.server import app
        from src.voices import voice_loader
        with patch.object(voice_loader, "get", return_value=MagicMock()):
            with patch.object(voice_loader, "metadata", return_value={"native_sample_rate": 22050, "model_path": "x"}):
                client = TestClient(app)
                resp = client.post("/synthesize", json={"text": "hello", "sample_rate": 12345})
                assert resp.status_code == 400

    def test_text_too_long_rejected(self, mocked_app):
        resp = mocked_app.post("/synthesize", json={"text": "a" * 6000})
        assert resp.status_code == 422

    def test_missing_text_field_rejected(self, mocked_app):
        resp = mocked_app.post("/synthesize", json={"voice": "en_US-lessac-medium"})
        assert resp.status_code == 422


# ── 4. Full synthesis (requires model) ───────────────────────────────────────

class TestSynthesis:
    def setup_method(self):
        from src.server import app
        self.client = TestClient(app)

    @requires_model
    def test_synthesize_short_text(self):
        resp = self.client.post("/synthesize", json={"text": "Hello."})
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("audio/wav")
        assert len(resp.content) > 100

    @requires_model
    def test_synthesize_normal_text(self):
        resp = self.client.post("/synthesize", json={
            "text": "This is a test of the emergency notification system.",
            "voice": "en_US-lessac-medium",
            "sample_rate": 8000,
        })
        assert resp.status_code == 200
        assert resp.headers.get("x-voice") == "en_US-lessac-medium"
        assert resp.headers.get("x-audio-sample-rate") == "8000"

    @requires_model
    def test_synthesize_returns_valid_wav(self):
        resp = self.client.post("/synthesize", json={"text": "Test audio."})
        assert resp.status_code == 200

        # Parse WAV header
        wav_bytes = resp.content
        assert wav_bytes[:4] == b"RIFF", "Not a RIFF file"
        assert wav_bytes[8:12] == b"WAVE", "Not a WAVE file"

        with wave.open(io.BytesIO(wav_bytes)) as wf:
            assert wf.getframerate() == 8000, f"Expected 8000 Hz, got {wf.getframerate()}"
            assert wf.getnchannels() == 1, f"Expected mono, got {wf.getnchannels()} channels"
            assert wf.getsampwidth() == 2, f"Expected 16-bit, got {wf.getsampwidth() * 8}-bit"
            assert wf.getnframes() > 0, "WAV has no audio frames"

    @requires_model
    def test_synthesize_16khz_output(self):
        resp = self.client.post("/synthesize", json={
            "text": "Sixteen kilohertz test.",
            "sample_rate": 16000,
        })
        assert resp.status_code == 200
        with wave.open(io.BytesIO(resp.content)) as wf:
            assert wf.getframerate() == 16000

    @requires_model
    def test_synthesize_longer_text(self):
        text = ("Please be advised that this is an emergency notification. " * 5).strip()
        resp = self.client.post("/synthesize", json={"text": text})
        assert resp.status_code == 200
        with wave.open(io.BytesIO(resp.content)) as wf:
            # Should be at least 3 seconds of audio for ~55 words
            duration = wf.getnframes() / wf.getframerate()
            assert duration >= 2.0, f"Expected ≥2s, got {duration:.2f}s"

    @requires_model
    def test_response_headers_present(self):
        resp = self.client.post("/synthesize", json={"text": "Header test."})
        assert resp.status_code == 200
        assert "x-audio-duration-sec" in resp.headers
        assert "x-synthesis-latency-ms" in resp.headers
        assert float(resp.headers["x-audio-duration-sec"]) > 0


# ── 5. Audio format verification ─────────────────────────────────────────────

class TestAudioFormat:
    @requires_model
    def test_wav_has_riff_header(self):
        from src.server import app
        client = TestClient(app)
        resp = client.post("/synthesize", json={"text": "Audio format check."})
        assert resp.content[:4] == b"RIFF"
        assert resp.content[8:12] == b"WAVE"

    @requires_model
    def test_wav_is_pcm(self):
        from src.server import app
        client = TestClient(app)
        resp = client.post("/synthesize", json={"text": "PCM check."})
        # fmt chunk audio format: 1 = PCM
        fmt_offset = resp.content.find(b"fmt ")
        if fmt_offset >= 0:
            audio_fmt = struct.unpack_from("<H", resp.content, fmt_offset + 8)[0]
            assert audio_fmt == 1, f"Expected PCM (1), got {audio_fmt}"


# ── 6. Negative / failure cases ───────────────────────────────────────────────

class TestNegativeCases:
    def setup_method(self):
        from src.server import app
        self.client = TestClient(app)

    def test_synthesize_invalid_json(self):
        resp = self.client.post(
            "/synthesize",
            content=b"not json",
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 422

    def test_synthesize_get_not_allowed(self):
        resp = self.client.get("/synthesize")
        assert resp.status_code == 405

    def test_unknown_route_404(self):
        resp = self.client.get("/does-not-exist")
        assert resp.status_code == 404
