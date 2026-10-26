# Media Library — "Undeploy" design (proposal, NOT implemented)

Status: design only (mission Phase 4). Nothing in this document is implemented,
and no live media has been undeployed. Implementation needs explicit approval.

## 1. Problem

"Deploy" copies an uploaded file into the ENRS sound directory
(`fsPathService.getEnrsSoundDir()`, e.g. `<sounds>/enrs/<leaf>`) and records it in
`media_files.fs_path` / `is_deployed = true`. Call flows (IVR play nodes, ERS/ENS
configurations, campaigns, platform config) then reference the file by name.

There is no way to take a file **out of service without deleting the library
record**. Today the only path is `DELETE` (soft-delete + move the deployed copy to
`.deleted/`), which also hides the record and its metadata from the library.

## 2. Current behaviour this design must keep

- Delete is guarded (`deleteMediaSafely`): per-filename session advisory lock
  (`MEDIA_LOCK_NS`, `hashtext(lower(leaf))`), dependency scan (`findMediaReferences`)
  inside the transaction, re-check after commit, and the file is **moved, never
  unlinked**. Reference writers take the same lock (`guardMediaReferences`).
- Restore (`restoreMediaSafely`, Phase 4) moves the newest quarantined copy back.
- Deploy (`deployMediaLocked`) copies under the lock and re-reads the row.
- The sound directory is shared by all tenants; filenames are the identity.

## 3. Proposed behaviour

`POST /api/v1/media-library/:id/undeploy` — `adminOnly`, tenant-scoped (other
tenant → 404), Bearer only.

1. Validate `id`; read the live row in scope; 404 if absent or `fs_path IS NULL`
   (`409 NOT_DEPLOYED` would also be acceptable — decision D-U1).
2. Take the same per-filename session locks as delete (sorted keys).
3. Transaction:
   - `SELECT … FOR UPDATE`; filenames must be unchanged (else `503 MEDIA_CHANGED`).
   - `findMediaReferences` — **any blocking reference ⇒ 409 `MEDIA_IN_USE`** with
     the same body as a blocked delete (other tenants' references only counted).
     An undeployed file referenced by a live flow is a call failure, so this is not
     optional.
   - Shared holders (`findSharedFileHolders`: another live record deployed to the
     same file) ⇒ keep the file, only clear this record (`file_action: 'retained'`).
   - `UPDATE media_files SET fs_path = NULL, is_deployed = false, deployed_at = NULL`.
   - `audit_logs` row `media_undeployed` (user, tenant, leaf, file_action).
   - COMMIT.
4. After commit, still under the locks: re-check references + holders (fail closed:
   keep the file on any doubt), then **move** the deployed file to
   `<sound>/.undeployed/<id>_<ts>_<leaf>` (separate from `.deleted/` so restore of a
   deleted record never picks an undeployed copy). Only files whose directory is
   exactly the ENRS sound directory are moved.
5. Unlock in `finally`; destroy the connection if an unlock fails (same as delete).

Redeploy needs no new code: `deployMedia` copies from `fs_path || path_or_uri`; with
`fs_path` NULL it uses the upload copy (`path_or_uri`).

## 4. Live-call safety

- FreeSWITCH opens a sound file when playback starts. A call already playing it
  keeps its open file descriptor (Linux `rename` within one filesystem does not
  affect open handles), so in-progress playback is not cut.
- New playbacks of a referenced file would fail — which is why step 3 blocks on
  any reference, including published IVR versions, ERS/ENS configs, campaigns
  inside the callback/retention window and platform config.
- Not covered by the scan: files referenced only by hand-written dialplan/Lua
  outside fs-enrs. Same limitation as delete; document it in the UI confirmation.

## 5. UI (when implemented)

- Row/drawer action "Undeploy" for ADMIN, beside "Deploy"; confirmation dialog that
  shows the "where used" result (`GET /:id/references`) first.
- On 409 reuse the existing "in use" dialog.
- Status chip changes to "Pending" (not deployed); bulk action optional (D-U2).
- No change to the accepted Media Library layout beyond the new action.

## 6. Tests required before release

- Unit (fake client/fs, like `mediaRestore.test.js`): blocked by each reference
  kind; shared holder keeps the file; outside-dir path never moved; lock timeout →
  `MEDIA_BUSY`; commit failure leaves the file in place; re-check after commit.
- Isolated e2e (disposable PostgreSQL + private netns, `iso/run.sh`): undeploy →
  file moved to `.undeployed/`, row pending; referenced → 409 and file untouched;
  redeploy afterwards works from the upload copy; other tenant 404; SUPERVISOR 403;
  concurrent IVR save vs undeploy in both orders (same harness as stage 2a).

## 7. Open decisions

- D-U1: undeploy of a not-deployed file → 404 or 409 `NOT_DEPLOYED`?
- D-U2: bulk undeploy in the toolbar (needs per-item results like bulk delete)?
- D-U3: retention of `.undeployed/` copies (keep forever vs. cleanup job). A cleanup
  job permanently deletes data and needs its own approval.
- D-U4: should SUPER_ADMIN be able to undeploy shared (tenant-less) system audio?
