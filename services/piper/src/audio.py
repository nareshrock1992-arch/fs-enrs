"""
Audio format utilities for the Piper TTS service.

Resamples WAV data from Piper's native output rate to the requested rate
using sox. sox is the only external dependency for audio processing — it
handles all WAV format conversions reliably without heavy Python deps.
"""

import asyncio
import io
import logging
import subprocess
import wave

logger = logging.getLogger(__name__)

# Allowed output sample rates. This is an allowlist — reject anything else
# to prevent arbitrary sox arguments from being constructed from user input.
ALLOWED_SAMPLE_RATES = {8000, 16000, 22050, 44100, 48000}

# Allowed channel counts
ALLOWED_CHANNELS = {1, 2}

# Allowed bit depths (sox -b flag)
ALLOWED_BIT_DEPTHS = {16, 32}


def validate_audio_params(sample_rate: int, channels: int = 1) -> None:
    """Raise ValueError if audio parameters are outside the allowed set."""
    if sample_rate not in ALLOWED_SAMPLE_RATES:
        raise ValueError(
            f"sample_rate {sample_rate} not allowed. "
            f"Allowed: {sorted(ALLOWED_SAMPLE_RATES)}"
        )
    if channels not in ALLOWED_CHANNELS:
        raise ValueError(f"channels {channels} not allowed. Allowed: {sorted(ALLOWED_CHANNELS)}")


def read_wav_metadata(wav_bytes: bytes) -> dict:
    """Extract sample rate, channels, and frame count from WAV bytes."""
    with wave.open(io.BytesIO(wav_bytes)) as wf:
        return {
            "sample_rate": wf.getframerate(),
            "channels":    wf.getnchannels(),
            "sampwidth":   wf.getsampwidth(),
            "n_frames":    wf.getnframes(),
            "duration_sec": wf.getnframes() / wf.getframerate() if wf.getframerate() else 0,
        }


async def resample_wav(wav_bytes: bytes, target_rate: int, target_channels: int = 1) -> bytes:
    """
    Resample WAV bytes to target_rate / target_channels / 16-bit signed PCM
    using sox. Returns WAV bytes at the target format.

    If the source is already at target_rate and target_channels, returns
    input unchanged (avoids unnecessary sox subprocess + re-encode).
    """
    validate_audio_params(target_rate, target_channels)

    meta = read_wav_metadata(wav_bytes)
    src_rate     = meta["sample_rate"]
    src_channels = meta["channels"]

    if src_rate == target_rate and src_channels == target_channels:
        logger.debug("resample: source already %d Hz %dch — no conversion", target_rate, target_channels)
        return wav_bytes

    logger.debug(
        "resample: %d Hz %dch → %d Hz %dch",
        src_rate, src_channels, target_rate, target_channels,
    )

    # sox reads WAV from stdin, writes WAV to stdout.
    # -t wav  — treat stdin/stdout as WAV
    # -       — stdin / stdout
    # -r      — output sample rate
    # -c      — output channel count
    # -e signed-integer  — PCM signed
    # -b 16   — 16-bit
    sox_cmd = [
        "sox",
        "--no-glob",          # disable filename globbing (security)
        "-t", "wav", "-",     # input: WAV from stdin
        "-t", "wav",          # output: WAV
        "-r", str(target_rate),
        "-c", str(target_channels),
        "-e", "signed-integer",
        "-b", "16",
        "-",                  # output: to stdout
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *sox_cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(input=wav_bytes), timeout=15)
    except asyncio.TimeoutError:
        raise RuntimeError("sox resampling timed out (>15s)")
    except FileNotFoundError:
        raise RuntimeError("sox not found — ensure sox is installed in the container")

    if proc.returncode != 0:
        err_text = stderr.decode(errors="replace").strip()
        raise RuntimeError(f"sox failed (rc={proc.returncode}): {err_text}")

    if not stdout:
        raise RuntimeError("sox produced empty output")

    out_meta = read_wav_metadata(stdout)
    logger.debug(
        "resample done: %d Hz %dch  duration=%.3fs  bytes=%d",
        out_meta["sample_rate"], out_meta["channels"],
        out_meta["duration_sec"], len(stdout),
    )

    return stdout
