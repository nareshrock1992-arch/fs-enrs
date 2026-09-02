-- Migration 048: ENS announcement audio support
-- Adds source_type + audio_url columns for each of the three configurable
-- ENS playback announcements so administrators can choose Audio File or TTS.
-- source_type: 'tts' (default — backward-compatible) | 'audio'
-- audio_url:   /media/<filename> path served by the media library

BEGIN;

ALTER TABLE ens_configurations
  ADD COLUMN IF NOT EXISTS no_pending_source_type   VARCHAR(5)   NOT NULL DEFAULT 'tts'
      CHECK (no_pending_source_type IN ('tts','audio')),
  ADD COLUMN IF NOT EXISTS no_pending_audio_url     VARCHAR(512),

  ADD COLUMN IF NOT EXISTS expiry_source_type       VARCHAR(5)   NOT NULL DEFAULT 'tts'
      CHECK (expiry_source_type IN ('tts','audio')),
  ADD COLUMN IF NOT EXISTS expiry_audio_url         VARCHAR(512),

  ADD COLUMN IF NOT EXISTS unauthorized_source_type VARCHAR(5)   NOT NULL DEFAULT 'tts'
      CHECK (unauthorized_source_type IN ('tts','audio')),
  ADD COLUMN IF NOT EXISTS unauthorized_audio_url   VARCHAR(512);

COMMIT;
