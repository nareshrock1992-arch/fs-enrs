# Media Library Guide

## Overview

The media library manages audio files used for IVR prompts, hold music, announcements, and ENS recordings. Audio files are stored on the filesystem and catalogued in the database. Before an audio file can be referenced by IVR nodes or Lua scripts, it must be both uploaded and deployed to the FreeSWITCH sound directory.

---

## Storage Tables

The media library uses two tables:

| Table | Purpose | Notes |
|---|---|---|
| `media_files` | Primary table for IVR and system audio | Includes rich metadata: codec, bitrate, checksum, version, tags, `usage_count` |
| `audio_library` | Legacy / additional table for organization audio | Category-based: `general` / `announcement` / `hold_music` / `ivr_prompt` / `recording` |

---

## Upload Audio

**Endpoint:** `POST /deployment/audio/upload`

**Content-Type:** `multipart/form-data`

**Form field:** `file` — the audio file to upload

| Parameter | Value |
|---|---|
| Maximum file size | `UPLOAD_MAX_MB` env var (default: 50 MB) |
| Recommended format | WAV — 8 kHz, 16-bit, mono PCM |
| Storage location | `UPLOAD_DIR/audio/` |
| DB record | Created in `media_files` with `type = PROMPT` |

After upload the file is staged in `UPLOAD_DIR/audio/` but is not yet accessible to FreeSWITCH. Deploy the file (see next section) before referencing it in an IVR flow.

---

## Deploy Audio to FreeSWITCH

**Endpoint:** `POST /deployment/audio/:id/deploy`

- Copies the file from `UPLOAD_DIR/audio/` to `${FS_SOUND_DIR}/enrs/` (default: `/usr/share/freeswitch/sounds/enrs/`)
- Updates `media_files.path_or_uri` with the deployed filesystem path
- The file is now referenceable in IVR nodes as `/media/{filename}.wav`

---

## Browse and Stream

| Endpoint | Description |
|---|---|
| `GET /deployment/audio` | List all audio files for the current tenant |
| `GET /deployment/audio?category=ivr_prompt` | Filter by category |
| `GET /deployment/audio/:id/stream` | Stream the audio file for in-browser playback |
| `DELETE /deployment/audio/:id` | Soft-delete (sets `deleted_at`; file remains on disk) |

---

## Audio Scanning

**Endpoint:** `POST /deployment/audio/scan`

Scans `${FS_SOUND_DIR}/enrs/` for WAV files that exist on disk but do not yet have a record in `media_files`. A new record is created for each untracked file found. Use this after manually placing files in the sound directory outside of the upload workflow.

---

## IVR Usage

After a file has been deployed, reference it in an IVR node using either of the following approaches:

**By path:**
```json
{
  "audio_url": "/media/filename.wav"
}
```

**By ID** (path resolved at Lua generation time):
```json
{
  "audio_file_id": "uuid-from-media-files"
}
```

Using `audio_file_id` is preferred because the path is resolved dynamically at deployment time and will remain correct if the file is redeployed to a different path.

---

## Recommended Audio Specifications

FreeSWITCH processes audio most efficiently when files conform to the following specifications. Non-conforming files are accepted but may be transcoded at playback time, which increases CPU load.

| Parameter | Recommended Value |
|---|---|
| Format | WAV |
| Sample rate | 8000 Hz |
| Bit depth | 16-bit |
| Channels | Mono (1) |
| Codec | PCM (uncompressed) |
| Maximum file size | 50 MB |
| Maximum duration | ~300 seconds for IVR prompts |

**Conversion example (FFmpeg):**
```bash
ffmpeg -i input.mp3 -ar 8000 -ac 1 -acodec pcm_s16le output.wav
```

---

## FreeSWITCH Sound Path

| Configuration | Value |
|---|---|
| Default path | `/usr/share/freeswitch/sounds/enrs/` |
| Override | Set `FS_SOUND_DIR` env var — deployed files go to `${FS_SOUND_DIR}/enrs/` |

Ensure the `freeswitch` system user has read access to this directory:

```bash
mkdir -p /usr/share/freeswitch/sounds/enrs
chown freeswitch:freeswitch /usr/share/freeswitch/sounds/enrs
```
