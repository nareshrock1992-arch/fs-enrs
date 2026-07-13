BEGIN;

-- Extend the media_files.type CHECK constraint to include IVR_PROMPT.
-- Root cause: the IVR builder allows uploading audio files scoped to an IVR
-- flow; those files are categorised as 'IVR_PROMPT' in the UI, but the original
-- constraint only listed ('RECORDING','PROMPT','MUSIC','OTHER').

ALTER TABLE media_files DROP CONSTRAINT IF EXISTS media_files_type_check;
ALTER TABLE media_files
  ADD CONSTRAINT media_files_type_check
    CHECK (type IN ('RECORDING','PROMPT','IVR_PROMPT','MUSIC','OTHER'));

COMMIT;
