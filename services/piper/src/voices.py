"""
Voice registry for the Piper TTS service.

Each entry documents a voice model available to the service.
Models are loaded from PIPER_MODEL_DIR (default: /app/models).

To add a new voice:
  1. Download the .onnx and .onnx.json files from the Piper releases.
  2. Place them in the models directory.
  3. Add an entry to VOICE_REGISTRY below.
  4. Rebuild the container (or re-mount the models directory).

Do NOT add a voice that is not physically present in the models directory.
The service validates model file existence at startup.
"""

import os
import json
import logging

logger = logging.getLogger(__name__)

MODEL_DIR = os.environ.get("PIPER_MODEL_DIR", "/app/models")

# Voice registry — add new voices here.
# Keys are the canonical voice IDs used in API requests.
VOICE_REGISTRY: dict[str, dict] = {
    "en_US-lessac-medium": {
        "model_file":   "en_US-lessac-medium.onnx",
        "config_file":  "en_US-lessac-medium.onnx.json",
        "language":     "en",
        "locale":       "en_US",
        "quality":      "medium",
        "enabled":      True,
        # Native sample rate emitted by this model before any resampling.
        # Read from config_file at load time; this default is the known value
        # for lessac-medium but the loader overwrites it from the JSON config.
        "native_sample_rate": 22050,
        "description":  "US English, medium quality (Lessac)",
    },
}


class VoiceLoader:
    """Loads and caches PiperVoice instances for each enabled voice."""

    def __init__(self):
        self._voices: dict = {}        # voice_id → PiperVoice
        self._metadata: dict = {}      # voice_id → enriched registry entry

    def load_all(self) -> list[str]:
        """
        Load all enabled voices from VOICE_REGISTRY.
        Returns list of successfully loaded voice IDs.
        Raises RuntimeError if no voices load successfully.
        """
        from piper.voice import PiperVoice  # imported here so import errors surface clearly

        loaded = []
        for voice_id, entry in VOICE_REGISTRY.items():
            if not entry.get("enabled", True):
                logger.info("voice %s disabled — skipping", voice_id)
                continue

            model_path  = os.path.join(MODEL_DIR, entry["model_file"])
            config_path = os.path.join(MODEL_DIR, entry["config_file"])

            if not os.path.isfile(model_path):
                logger.error("voice %s — model not found: %s", voice_id, model_path)
                continue
            if not os.path.isfile(config_path):
                logger.error("voice %s — config not found: %s", voice_id, config_path)
                continue

            try:
                piper_voice = PiperVoice.load(model_path, config_path=config_path)
                self._voices[voice_id] = piper_voice

                # Read native sample rate from config
                with open(config_path) as f:
                    cfg = json.load(f)
                native_rate = (
                    cfg.get("audio", {}).get("sample_rate")
                    or cfg.get("sample_rate")
                    or entry["native_sample_rate"]
                )
                meta = {**entry, "native_sample_rate": native_rate, "model_path": model_path}
                self._metadata[voice_id] = meta

                logger.info(
                    "loaded voice %s  model=%s  native_rate=%d",
                    voice_id, entry["model_file"], native_rate,
                )
                loaded.append(voice_id)
            except Exception as exc:
                logger.error("voice %s — load failed: %s", voice_id, exc)

        if not loaded:
            raise RuntimeError(
                f"No voices loaded from {MODEL_DIR}. "
                "Ensure model files are present and PIPER_MODEL_DIR is correct."
            )

        return loaded

    def get(self, voice_id: str):
        """Return PiperVoice for voice_id, or None if not loaded."""
        return self._voices.get(voice_id)

    def metadata(self, voice_id: str) -> dict | None:
        return self._metadata.get(voice_id)

    def list_voices(self) -> list[dict]:
        return [
            {
                "id":          vid,
                "language":    m["language"],
                "locale":      m["locale"],
                "quality":     m["quality"],
                "description": m.get("description", ""),
                "native_sample_rate": m["native_sample_rate"],
            }
            for vid, m in self._metadata.items()
        ]

    def is_ready(self) -> bool:
        return bool(self._voices)


# Module-level singleton — populated by server.py at startup
voice_loader = VoiceLoader()
