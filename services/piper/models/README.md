# Piper Voice Models

This directory holds Piper ONNX voice models for the fs-enrs TTS service.

Models are **not committed to Git** (too large, version-controlled separately).
They are mounted into the container via a Docker volume or bind mount.

---

## Currently Registered Voices

| Voice ID | Files | Language | Quality | Native Rate |
|---|---|---|---|---|
| `en_US-lessac-medium` | `en_US-lessac-medium.onnx` + `.onnx.json` | en-US | medium | 22050 Hz |

---

## Downloading Models

Models are published by the Rhasspy project (Piper upstream):
https://github.com/rhasspy/piper/releases

For each voice, download the `.onnx` and `.onnx.json` files.

### en_US-lessac-medium (approved for Phase 1)

**Source:** https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-en-us-lessac-medium.tar.gz  
**Files after extraction:**
- `en_US-lessac-medium.onnx`       (approx. 60 MB)
- `en_US-lessac-medium.onnx.json`  (approx. 5 KB)

**On the dev server**, the model is already present at:
```
/opt/freeswitch-ui/enrs-tools/voices/en_US-lessac-medium.onnx
/opt/freeswitch-ui/enrs-tools/voices/en_US-lessac-medium.onnx.json
```

For Docker deployment, bind-mount that directory:
```yaml
volumes:
  - /opt/freeswitch-ui/enrs-tools/voices:/app/models:ro
```

---

## Adding a New Voice

1. Download the `.onnx` and `.onnx.json` files for the new voice.
2. Verify the checksum of the `.onnx` file and document it below.
3. Place both files in this directory (or update the mount path).
4. Add an entry to `services/piper/src/voices.py` VOICE_REGISTRY.
5. Set `"enabled": True` when the voice is ready for production.
6. Rebuild / restart the Piper container.

---

## Model Checksums

| Voice | File | SHA-256 | Verified |
|---|---|---|---|
| en_US-lessac-medium | en_US-lessac-medium.onnx | (compute with `sha256sum en_US-lessac-medium.onnx`) | Pending dev-server verification |

Compute and record the checksum after first download:
```bash
sha256sum en_US-lessac-medium.onnx
```

---

## Model Version Policy

- Do not silently replace a model file without updating the checksum table above.
- If a model is updated to a newer version, update the VOICE_REGISTRY `description`
  and document the change in the project changelog.
- Never download models automatically at container startup — all models must be
  pre-staged and verified before deployment.
