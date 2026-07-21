# Audio Path Guide

**Product:** fs-enrs Emergency Notification and Response System
**Applies to:** IVR node audio fields, ENS/ERS hold music, deployment audio library

---

## Overview

Audio files referenced in IVR flows must be deployed to the FreeSWITCH host's sound directory before a call can play them. The fs-enrs backend manages audio files through the `media_files` table and the Deployment → Audio Library interface. This guide covers the full lifecycle: upload → database record → deploy to FreeSWITCH → reference in IVR nodes → playback.

---

## Media File URI Format

All audio references in IVR node configuration fields use a `/media/` URI prefix. This is a logical URI, not a filesystem path. The IVR executor's `resolve_audio()` helper maps it to the absolute filesystem path at runtime.

| URI format | Resolved to |
|---|---|
| `/media/welcome.wav` | `${FS_SOUND_DIR}/enrs/welcome.wav` |
| `/media/goodbye_en.wav` | `${FS_SOUND_DIR}/enrs/goodbye_en.wav` |
| `/media/hold_music.wav` | `${FS_SOUND_DIR}/enrs/hold_music.wav` |

### Why `/media/` Only

The Zod schema enforces that `audio_url` fields start with `/media/` (enforced by the `localAudioUrl` refinement in `ivrValidator.js`):

```
audio_url must start with /media/ (no external URLs)
```

This restriction prevents SSRF attacks (the Lua executor would call `streamFile()` with the URL and an attacker-controlled path could access internal files or external servers). External URLs and absolute filesystem paths are rejected at validation time.

### Default `FS_SOUND_DIR`

The `FS_SOUND_DIR` environment variable sets the root sound directory. On Debian/Ubuntu installations of FreeSWITCH:

```
FS_SOUND_DIR=/usr/share/freeswitch/sounds
```

The `resolve_audio()` function appends `/enrs/` and the filename:

```lua
local function resolve_audio(uri)
  if not uri or uri == "" then return nil end
  -- Strip the /media/ prefix and map to absolute path
  local filename = uri:match("^/media/(.+)$")
  if not filename then return nil end
  return FS_SOUND_DIR .. "/enrs/" .. filename
end
```

---

## Supported Audio Formats

FreeSWITCH natively supports decoding the following formats for `streamFile()` and `recordFile()`:

| Format | Notes |
|---|---|
| WAV (8kHz, 8-bit µ-law / A-law) | Native telephony format; smallest file size |
| WAV (8kHz, 16-bit PCM mono) | **Recommended** for new recordings — best compatibility |
| WAV (16kHz, 16-bit PCM mono) | Higher quality; used for wideband codecs (G.722) |
| WAV (48kHz) | Supported but unnecessarily large for telephony use |
| MP3 | Requires `mod_shout` to be loaded in FreeSWITCH |
| G.711 µ-law (`.ul` / `.ulaw`) | Raw codec file; native on PSTN |
| G.711 A-law (`.al` / `.alaw`) | Raw codec file; common in European telephony |
| OGG Vorbis | Requires `mod_ogg` |
| GSM 6.10 (`.gsm`) | Legacy; supported by FreeSWITCH's built-in GSM codec |

### Recommended Format

**8kHz, 16-bit, mono, PCM WAV** — this is the format that FreeSWITCH uses internally and requires the least transcoding overhead. Using this format avoids codec conversion artifacts and reduces CPU load on the FreeSWITCH host.

To convert an existing file to the recommended format using `ffmpeg`:

```bash
ffmpeg -i input.mp3 -ar 8000 -ac 1 -sample_fmt s16 output.wav
```

Or using `sox`:

```bash
sox input.wav -r 8000 -c 1 -b 16 output.wav
```

### File Naming Convention

The audio upload handler sanitizes filenames: non-alphanumeric characters (except `_`, `.`, `-`) are replaced with `_`. A timestamp prefix is added to prevent collisions:

```
1721404800000_welcome_message.wav
```

When referencing the file in IVR nodes, use the sanitized name as stored in `media_files.filename` (available in the Audio Library UI).

---

## Uploading Audio Files

### Via the UI

1. Navigate to **Deployment → Audio Library**.
2. Click **Upload Audio**.
3. Select a WAV, MP3, OGG, GSM, or µ-law file.
4. (Optional) Enter a display name and category.
5. Click **Upload**.

The file is stored in `config.uploads.dir` (configurable via `UPLOAD_DIR` env var, default: `uploads/audio/`) and a record is inserted into the `media_files` table.

### Via the API

`POST /api/v1/deployment/audio/upload`

- Method: `multipart/form-data`
- Field name: `file`
- Maximum size: `UPLOAD_MAX_MB` env var (default: 50 MB)
- Accepted extensions: `.wav`, `.mp3`, `.ogg`, `.gsm`, `.ul`

Response:
```json
{
  "media_file": {
    "id": 42,
    "name": "Welcome Message",
    "filename": "1721404800000_welcome_message.wav",
    "is_deployed": false,
    "path_or_uri": null
  }
}
```

After upload, the file is in the database but **not yet accessible to FreeSWITCH**. The deploy step copies it to the sound directory.

---

## Deploying Audio Files to FreeSWITCH

### Via the UI

In the **Audio Library**, locate the file and click **Deploy**. The backend copies the file from `UPLOAD_DIR` to `${FS_SOUND_DIR}/enrs/` on the FreeSWITCH host.

### Via the API

`POST /api/v1/deployment/audio/:id/deploy`

The backend:

1. Reads the `media_files` record by ID.
2. Copies the file from `config.uploads.dir` to `${FS_SOUND_DIR}/enrs/<filename>`.
3. Updates `media_files.is_deployed = true` and `media_files.path_or_uri = <absolute_path>`.

Response:
```json
{
  "media_file": {
    "id": 42,
    "is_deployed": true,
    "path_or_uri": "/usr/share/freeswitch/sounds/enrs/1721404800000_welcome_message.wav"
  }
}
```

After deployment, the file is available for IVR playback. Reference it in IVR nodes as:

```
/media/1721404800000_welcome_message.wav
```

### Deployment Verification

After deploying, verify the file exists on the FreeSWITCH host:

```bash
ls -la /usr/share/freeswitch/sounds/enrs/1721404800000_welcome_message.wav
```

And test playback via the FreeSWITCH CLI:

```
fs_cli -x "originate loopback/1001 &playback(/usr/share/freeswitch/sounds/enrs/1721404800000_welcome_message.wav)"
```

---

## Referencing Audio in IVR Nodes

### `play` Node

```json
{
  "type": "play",
  "audio_url": "/media/1721404800000_welcome_message.wav",
  "next": "gather_node_1"
}
```

Or by database ID (path resolved at deploy time):

```json
{
  "type": "play",
  "audio_file_id": 42,
  "next": "gather_node_1"
}
```

### `gather` Node — Prompt Audio

```json
{
  "type": "gather",
  "prompt_audio_url": "/media/1721404800000_main_menu.wav",
  "variable_name": "menu_choice",
  "max_digits": 1,
  "branches": { "1": "ers_node", "_default": "invalid_node" }
}
```

### `hangup` Node — Goodbye Audio

```json
{
  "type": "hangup",
  "play_audio_url": "/media/1721404800000_goodbye.wav"
}
```

### `record_message` Node — Pre-Record Prompt

```json
{
  "type": "record_message",
  "prompt_audio_url": "/media/1721404800000_record_prompt.wav",
  "variable_name": "recorded_file_path",
  "max_seconds": 60,
  "next": "ens_node"
}
```

---

## Text-to-Speech (TTS)

When recorded audio is not available, the `say` node and prompt text fields on `gather`, `record_message`, `ers_overflow_wait`, and `ens_blast_record` nodes use FreeSWITCH's TTS engine.

### TTS Engine Configuration

Set via `ENRS_TTS_ENGINE` environment variable in the backend `.env`. The value is passed directly to FreeSWITCH's `speak` application:

```
ENRS_TTS_ENGINE=flite
```

The FreeSWITCH `speak` application takes the format: `engine|voice|text`.

The `speak()` Lua helper in `ivr_executor.lua`:

```lua
local function speak(s, text)
  if not text or text == "" then return end
  local engine = TTS_ENGINE or "flite"
  local voice  = TTS_VOICE  or "kal"
  s:execute("speak", engine .. "|" .. voice .. "|" .. text)
end
```

### Available TTS Engines

| Engine | Voice Example | Quality | Network Dependency |
|---|---|---|---|
| `flite` | `kal` (default), `slt`, `awb` | Low (robotic) | None — runs locally |
| `PolyglotTTS` | Configured per install | Medium | May require local service |
| AWS Polly / Google TTS | Configured via FreeSWITCH modules | High | External API |

For production deployments where audio quality matters, pre-record all prompts as WAV files and use the `play` node instead of `say`.

### Language Support

The `say` node's `language` field accepts a BCP-47 tag (`en-US`, `en-AU`, `en-GB`, `es-ES`, `fr-FR`, `de-DE`). The tag is passed to the TTS engine. Support varies by engine — `flite` ignores the language tag and always uses the configured voice.

---

## Audio in Conference Calls

### ERS Hold Queue Music

When callers queue in the ERS overflow wait, hold music or an announcement plays between occupancy polls. Configure via:

- `ers_overflow_wait.hold_audio_url` — local `/media/` URI for audio file.
- `ers_overflow_wait.hold_prompt_text` — TTS text as fallback.

If neither is set, the node plays a 3-second silence stream between polls.

### ERS Conference Hold Music

When the caller is in a conference room waiting for a responder, FreeSWITCH plays the conference's configured MOH (Music on Hold). This is configured in the FreeSWITCH `conference.conf.xml` profile, not in fs-enrs.

### Conference Live Audio Injection

Supervisors can inject audio into a live ERS conference room via the monitoring UI:

`POST /api/v1/monitoring/conferences/:room/play`

```json
{ "audio_url": "/media/all_clear.wav" }
```

This calls `bgapi conference <room> play <path>` via ESL.

---

## Environment Variables Affecting Audio

| Variable | Default | Description |
|---|---|---|
| `FS_SOUND_DIR` | `/usr/share/freeswitch/sounds` | Root FreeSWITCH sound directory. Audio is deployed to `${FS_SOUND_DIR}/enrs/`. |
| `UPLOAD_DIR` | `uploads/audio/` | Directory where uploaded audio is staged before deployment. Relative to backend working directory. |
| `UPLOAD_MAX_MB` | `50` | Maximum upload size in megabytes. |
| `ENRS_TTS_ENGINE` | `flite` | TTS engine name passed to FreeSWITCH `speak` application. |
| `ENRS_TTS_VOICE` | `kal` | TTS voice name. |
| `ENRS_REC_DIR` | `${recordings_dir}` | FreeSWITCH global variable used as the base for ENS recordings. |
| `FS_RECORDING_DIR` | (global `recordings_dir`) | Base directory for IVR `record_message` recordings. Resolved at runtime from FreeSWITCH global vars if not set. |

---

## Troubleshooting Audio

### Caller Hears Silence During Play Node

1. Verify the file is deployed: check `media_files.is_deployed = true` in the database.
2. Verify the file exists on the FreeSWITCH host:
   ```bash
   ls -la ${FS_SOUND_DIR}/enrs/<filename>
   ```
3. Check FreeSWITCH logs for `streamFile` errors:
   ```
   fs_cli -x "log 7" | grep -i "streamfile\|failed to open"
   ```
4. Verify the `FS_SOUND_DIR` env var matches the actual FreeSWITCH sound path.
5. Check file permissions — the FreeSWITCH process user must have read access:
   ```bash
   ls -la ${FS_SOUND_DIR}/enrs/
   ```

### Audio File Rejected at Upload

- Check the file extension: only `.wav`, `.mp3`, `.ogg`, `.gsm`, `.ul` are accepted.
- Check the file size: must be under `UPLOAD_MAX_MB` (default 50 MB).
- Check that the `UPLOAD_DIR` exists and the backend process has write access.

### TTS Produces No Audio

1. Verify `ENRS_TTS_ENGINE` is set to a FreeSWITCH module that is loaded:
   ```
   fs_cli -x "module_exists mod_flite"
   ```
2. Check FreeSWITCH logs for `speak` application errors.
3. Test TTS from the CLI:
   ```
   fs_cli -x "originate loopback/1001 &speak(flite|kal|Hello World)"
   ```

### Recording File Not Created

1. Verify the recording directory exists and is writable:
   ```bash
   mkdir -p /var/lib/freeswitch/recordings/ivr
   chown freeswitch:freeswitch /var/lib/freeswitch/recordings/ivr
   ```
2. Check FreeSWITCH global variable:
   ```
   fs_cli -x "global_getvar recordings_dir"
   ```
3. Review FreeSWITCH logs for `record` application errors.

---

## Audio File Checklist

Use this checklist before deploying a flow to production:

- [ ] All audio files referenced in the flow have been uploaded to the Audio Library.
- [ ] All audio files have `is_deployed = true` (deployed to FreeSWITCH).
- [ ] Audio files are 8kHz 16-bit mono PCM WAV format.
- [ ] Each `play` or `gather` node references a file with a `/media/` prefix (not an absolute path).
- [ ] No audio URL references a file that belongs to a different tenant or organization.
- [ ] Flow validation passes with no errors for audio-related FK checks.
- [ ] A test call has been placed to verify audio plays correctly end-to-end.
