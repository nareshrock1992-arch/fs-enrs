"""
Piper TTS service tests.

Test categories:
  1. Health / readiness endpoints
  2. Voices endpoint
  3. Input validation (always run — mocked synthesis, no model required)
  4. Full synthesis (skipped if model files absent)
  5. Audio format verification (skipped if model files absent)
  6. Resampling path (skipped if sox absent or model absent)
  7. Negative / failure cases
  8. Concurrency
  9. Error handling — controlled HTTP responses

Run all available:   pytest tests/
Skip model-required: pytest tests/ -m "not requires_model"
Run model tests only: pytest tests/ -m requires_model  (needs models + sox)
"""

import asyncio
import io
import os
import shutil
import struct
import wave
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# Set env vars before importing app modules
os.environ.setdefault("PIPER_MODEL_DIR", "models")
os.environ.setdefault("PIPER_DEFAULT_VOICE", "en_US-lessac-medium")
os.environ.setdefault("PIPER_SAMPLE_RATE", "8000")
os.environ.setdefault("PIPER_MAX_CONCURRENT", "2")
os.environ.setdefault("PIPER_MAX_TEXT_LENGTH", "5000")

MODEL_DIR  = os.environ["PIPER_MODEL_DIR"]
MODEL_ONNX = os.path.join(MODEL_DIR, "en_US-lessac-medium.onnx")
MODEL_JSON = os.path.join(MODEL_DIR, "en_US-lessac-medium.onnx.json")
MODELS_PRESENT = os.path.isfile(MODEL_ONNX) and os.path.isfile(MODEL_JSON)
SOX_PRESENT    = shutil.which("sox") is not None

requires_model = pytest.mark.skipif(
    not MODELS_PRESENT,
    reason=f"model files not present at {MODEL_DIR} — mark as NOT TESTABLE LOCALLY",
)
requires_model_and_sox = pytest.mark.skipif(
    not (MODELS_PRESENT and SOX_PRESENT),
    reason="requires both model files and sox — mark as NOT TESTABLE LOCALLY",
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


def assert_valid_wav(data: bytes, *, rate: int = 8000, channels: int = 1, bits: int = 16):
    """Assert WAV bytes have correct RIFF/WAVE structure and audio params."""
    assert data[:4] == b"RIFF", "Not a RIFF file"
    assert data[8:12] == b"WAVE", "Not a WAVE file"
    fmt_offset = data.find(b"fmt ")
    assert fmt_offset >= 0, "No fmt chunk"
    audio_fmt = struct.unpack_from("<H", data, fmt_offset + 8)[0]
    assert audio_fmt == 1, f"Expected PCM (1), got {audio_fmt}"
    with wave.open(io.BytesIO(data)) as wf:
        assert wf.getframerate() == rate, f"Expected {rate} Hz, got {wf.getframerate()}"
        assert wf.getnchannels() == channels, f"Expected {channels}ch, got {wf.getnchannels()}"
        assert wf.getsampwidth() * 8 == bits, f"Expected {bits}-bit, got {wf.getsampwidth()*8}-bit"
        assert wf.getnframes() > 0, "WAV has no audio frames"
        return wf.getnframes() / wf.getframerate()  # duration


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    from src.server import app
    with TestClient(app) as c:
        yield c


@pytest.fixture
def mocked_client():
    """Client with synthesis mocked — validates API layer without model or sox."""
    from src.server import app
    from src.voices import voice_loader
    import src.server as server_mod

    fake_native_wav = make_wav_bytes(22050, 1, 3528)   # ~0.1s at 22050
    fake_resampled  = make_wav_bytes(8000,  1, 800)    # ~0.1s at 8000

    with patch.object(server_mod, "_synthesize_sync", return_value=fake_native_wav):
        with patch("src.server.resample_wav", new=AsyncMock(return_value=fake_resampled)):
            with patch.object(voice_loader, "get", return_value=MagicMock()):
                with patch.object(voice_loader, "is_ready", return_value=True):
                    with TestClient(app) as c:
                        yield c


# ── 1. Health / readiness ─────────────────────────────────────────────────────

class TestHealth:
    def test_health_always_200(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_ready_503_when_no_models(self, client):
        if MODELS_PRESENT:
            pytest.skip("models present — covered by test_ready_200_when_models_loaded")
        resp = client.get("/ready")
        assert resp.status_code == 503
        assert resp.json()["status"] == "not_ready"

    @requires_model
    def test_ready_200_when_models_loaded(self, client):
        resp = client.get("/ready")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ready"
        assert "en_US-lessac-medium" in data["voices"]


# ── 2. Voices endpoint ────────────────────────────────────────────────────────

class TestVoices:
    def test_voices_returns_list(self, client):
        resp = client.get("/voices")
        assert resp.status_code == 200
        data = resp.json()
        assert "voices" in data
        assert isinstance(data["voices"], list)

    @requires_model
    def test_voices_includes_lessac(self, client):
        resp = client.get("/voices")
        ids = [v["id"] for v in resp.json()["voices"]]
        assert "en_US-lessac-medium" in ids

    @requires_model
    def test_voice_has_required_fields(self, client):
        resp = client.get("/voices")
        for voice in resp.json()["voices"]:
            assert "id" in voice
            assert "language" in voice
            assert "locale" in voice
            assert "quality" in voice
            assert "native_sample_rate" in voice


# ── 3. Input validation ───────────────────────────────────────────────────────

class TestInputValidation:
    def test_empty_text_rejected(self, mocked_client):
        resp = mocked_client.post("/synthesize", json={"text": ""})
        assert resp.status_code == 422

    def test_whitespace_only_text_rejected(self, mocked_client):
        resp = mocked_client.post("/synthesize", json={"text": "   "})
        assert resp.status_code == 422

    def test_missing_text_field_rejected(self, mocked_client):
        resp = mocked_client.post("/synthesize", json={"voice": "en_US-lessac-medium"})
        assert resp.status_code == 422

    def test_text_too_long_rejected(self, mocked_client):
        # MAX_TEXT_LENGTH = 5000; send 6000
        resp = mocked_client.post("/synthesize", json={"text": "a" * 6000})
        assert resp.status_code == 422

    def test_unknown_voice_rejected(self, client):
        from src.voices import voice_loader
        with patch.object(voice_loader, "get", return_value=None):
            with patch.object(voice_loader, "list_voices", return_value=[]):
                resp = client.post("/synthesize", json={"text": "hello", "voice": "nonexistent"})
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"] == "voice_unavailable"

    def test_path_traversal_voice_rejected(self, mocked_client):
        # voice allowlist: [A-Za-z0-9_\-.] — slash must be rejected
        resp = mocked_client.post("/synthesize", json={"text": "hello", "voice": "../../etc/passwd"})
        assert resp.status_code == 422

    def test_voice_with_special_chars_rejected(self, mocked_client):
        resp = mocked_client.post("/synthesize", json={"text": "hello", "voice": "voice;rm -rf /"})
        assert resp.status_code == 422

    def test_sample_rate_below_minimum_rejected(self, mocked_client):
        # Pydantic Field(ge=8000) — 1234 < 8000 → 422
        resp = mocked_client.post("/synthesize", json={"text": "hello", "sample_rate": 1234})
        assert resp.status_code == 422

    def test_sample_rate_above_maximum_rejected(self, mocked_client):
        # Pydantic Field(le=48000) — 96000 > 48000 → 422
        resp = mocked_client.post("/synthesize", json={"text": "hello", "sample_rate": 96000})
        assert resp.status_code == 422

    def test_sample_rate_not_in_allowlist_rejected(self, mocked_client):
        # 12000 is within [8000, 48000] but not in ALLOWED_SAMPLE_RATES → 400
        from src.voices import voice_loader
        with patch.object(voice_loader, "get", return_value=MagicMock()):
            resp = mocked_client.post("/synthesize", json={"text": "hello", "sample_rate": 12000})
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"] == "invalid_audio_params"

    def test_invalid_json_rejected(self, client):
        resp = client.post(
            "/synthesize",
            content=b"not json",
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 422


# ── 4. Full synthesis (requires model + sox) ──────────────────────────────────

class TestSynthesis:
    @requires_model_and_sox
    def test_synthesize_short_text(self, client):
        resp = client.post("/synthesize", json={"text": "Hello."})
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("audio/wav")
        assert len(resp.content) > 100

    @requires_model_and_sox
    def test_synthesize_normal_text(self, client):
        resp = client.post("/synthesize", json={
            "text": "This is a test of the emergency notification system.",
            "voice": "en_US-lessac-medium",
            "sample_rate": 8000,
        })
        assert resp.status_code == 200
        assert resp.headers.get("x-voice") == "en_US-lessac-medium"
        assert resp.headers.get("x-audio-sample-rate") == "8000"

    @requires_model_and_sox
    def test_synthesize_returns_valid_wav_8000hz(self, client):
        resp = client.post("/synthesize", json={"text": "Test audio.", "sample_rate": 8000})
        assert resp.status_code == 200
        dur = assert_valid_wav(resp.content, rate=8000, channels=1, bits=16)
        assert dur > 0, "WAV has zero duration"

    @requires_model_and_sox
    def test_synthesize_16khz_output(self, client):
        resp = client.post("/synthesize", json={"text": "Sixteen kilohertz test.", "sample_rate": 16000})
        assert resp.status_code == 200
        assert_valid_wav(resp.content, rate=16000, channels=1, bits=16)

    @requires_model_and_sox
    def test_synthesize_longer_text_produces_longer_audio(self, client):
        text = ("Please be advised that this is an emergency notification. " * 5).strip()
        resp = client.post("/synthesize", json={"text": text})
        assert resp.status_code == 200
        with wave.open(io.BytesIO(resp.content)) as wf:
            duration = wf.getnframes() / wf.getframerate()
        assert duration >= 2.0, f"Expected ≥2s for ~55 words, got {duration:.2f}s"

    @requires_model_and_sox
    def test_response_headers_present_and_valid(self, client):
        resp = client.post("/synthesize", json={"text": "Header test."})
        assert resp.status_code == 200
        assert "x-audio-duration-sec" in resp.headers
        assert "x-synthesis-latency-ms" in resp.headers
        assert "x-audio-sample-rate" in resp.headers
        assert "x-voice" in resp.headers
        assert float(resp.headers["x-audio-duration-sec"]) > 0
        assert float(resp.headers["x-synthesis-latency-ms"]) > 0


# ── 5. Audio format — conversion path verification ────────────────────────────

class TestAudioFormat:
    """
    Verify the full conversion path:
      piper native (22050 Hz) → sox resample → 8000 Hz mono 16-bit PCM WAV
    """

    @requires_model_and_sox
    def test_output_is_riff_wave(self, client):
        resp = client.post("/synthesize", json={"text": "Audio format check."})
        assert resp.content[:4] == b"RIFF"
        assert resp.content[8:12] == b"WAVE"

    @requires_model_and_sox
    def test_output_is_pcm_linear(self, client):
        resp = client.post("/synthesize", json={"text": "PCM check."})
        fmt_offset = resp.content.find(b"fmt ")
        assert fmt_offset >= 0
        audio_fmt = struct.unpack_from("<H", resp.content, fmt_offset + 8)[0]
        assert audio_fmt == 1, f"Expected PCM (1), got {audio_fmt}"

    @requires_model_and_sox
    def test_output_is_mono(self, client):
        resp = client.post("/synthesize", json={"text": "Mono check.", "sample_rate": 8000})
        with wave.open(io.BytesIO(resp.content)) as wf:
            assert wf.getnchannels() == 1

    @requires_model_and_sox
    def test_output_is_16bit(self, client):
        resp = client.post("/synthesize", json={"text": "Bit depth check."})
        with wave.open(io.BytesIO(resp.content)) as wf:
            assert wf.getsampwidth() == 2  # 16-bit

    @requires_model_and_sox
    def test_output_rate_matches_request(self, client):
        for rate in [8000, 16000]:
            resp = client.post("/synthesize", json={"text": "Rate check.", "sample_rate": rate})
            assert resp.status_code == 200
            with wave.open(io.BytesIO(resp.content)) as wf:
                assert wf.getframerate() == rate, f"Requested {rate}, got {wf.getframerate()}"

    async def test_resample_passthrough_when_rate_matches(self):
        """resample_wav must return input unchanged when src == target rate."""
        from src.audio import resample_wav
        wav = make_wav_bytes(8000, 1, 800)
        result = await resample_wav(wav, 8000, 1)
        assert result == wav, "resample_wav should short-circuit when src == target rate"

    async def test_resample_raises_on_sox_missing(self):
        """resample_wav must raise RuntimeError (not crash) when sox is absent."""
        from src.audio import resample_wav
        if SOX_PRESENT:
            pytest.skip("sox is present — this test requires sox to be absent")
        wav = make_wav_bytes(22050, 1, 2205)
        with pytest.raises(RuntimeError, match="sox not found"):
            await resample_wav(wav, 8000, 1)


# ── 6. Negative / failure cases ───────────────────────────────────────────────

class TestNegativeCases:
    def test_synthesize_get_not_allowed(self, client):
        resp = client.get("/synthesize")
        assert resp.status_code == 405

    def test_unknown_route_404(self, client):
        resp = client.get("/does-not-exist")
        assert resp.status_code == 404

    def test_synthesis_error_returns_500_not_crash(self, mocked_client):
        """A synthesis failure must produce a controlled 500, not a stack trace in response."""
        import src.server as server_mod
        with patch.object(server_mod, "_synthesize_sync", side_effect=RuntimeError("deliberate failure")):
            resp = mocked_client.post("/synthesize", json={"text": "fail this"})
        assert resp.status_code == 500
        body = resp.json()
        assert "detail" in body
        assert "synthesis_failed" in body["detail"].get("error", "")
        # Must not expose the raw exception message in the response
        assert "deliberate failure" not in resp.text

    def test_resample_error_returns_500_not_crash(self, mocked_client):
        with patch("src.server.resample_wav", new=AsyncMock(side_effect=RuntimeError("sox crash"))):
            resp = mocked_client.post("/synthesize", json={"text": "resample fail"})
        assert resp.status_code == 500
        assert "resample_failed" in resp.json()["detail"].get("error", "")


# ── 7. Concurrency ────────────────────────────────────────────────────────────

class TestConcurrency:
    def _make_parallel_requests(self, client, n: int) -> list:
        """Send n requests concurrently via threads and collect responses."""
        import concurrent.futures
        body = {"text": "Concurrency test.", "sample_rate": 8000}
        with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
            futures = [pool.submit(client.post, "/synthesize", json=body) for _ in range(n)]
            return [f.result() for f in concurrent.futures.as_completed(futures)]

    def test_single_request(self, mocked_client):
        resps = self._make_parallel_requests(mocked_client, 1)
        assert all(r.status_code == 200 for r in resps)

    def test_two_concurrent_requests(self, mocked_client):
        resps = self._make_parallel_requests(mocked_client, 2)
        assert all(r.status_code == 200 for r in resps)

    def test_four_concurrent_requests(self, mocked_client):
        # MAX_CONCURRENT=2, so 2 will be queued — all should still succeed
        resps = self._make_parallel_requests(mocked_client, 4)
        assert all(r.status_code == 200 for r in resps)


# ── 8. Audio utilities unit tests ─────────────────────────────────────────────

class TestAudioUtils:
    def test_validate_audio_params_accepts_allowed_rates(self):
        from src.audio import validate_audio_params
        for rate in [8000, 16000, 22050, 44100, 48000]:
            validate_audio_params(rate, 1)  # must not raise

    def test_validate_audio_params_rejects_unallowed_rate(self):
        from src.audio import validate_audio_params
        with pytest.raises(ValueError, match="not allowed"):
            validate_audio_params(12000, 1)

    def test_validate_audio_params_rejects_unallowed_channels(self):
        from src.audio import validate_audio_params
        with pytest.raises(ValueError, match="not allowed"):
            validate_audio_params(8000, 3)

    def test_read_wav_metadata(self):
        from src.audio import read_wav_metadata
        wav = make_wav_bytes(8000, 1, 800)
        meta = read_wav_metadata(wav)
        assert meta["sample_rate"] == 8000
        assert meta["channels"] == 1
        assert meta["n_frames"] == 800
        assert abs(meta["duration_sec"] - 0.1) < 0.001
