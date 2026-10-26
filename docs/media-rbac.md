# Media Library & Recordings — Role / Capability Matrix

Authoritative enforcement is server-side (`backend/src/middleware/rbac.js`,
`backend/src/routes/v1/mediaLibrary.js`, `backend/src/routes/v1/recordings.js`).
The UI mirrors it in `frontend/src/auth/permissions.js` so it only offers actions
the API accepts. Both are pinned by tests:
`backend/src/__tests__/unit/mediaRecordingsRbac.test.js` and
`frontend/src/__tests__/permissions.test.js`.

## Media Library (`/api/v1/media-library`)

| Capability | SUPER_ADMIN | ADMIN | SUPERVISOR | OPERATOR | VIEWER |
|---|---|---|---|---|---|
| List / detail / categories (`media.view`) | ✓ | ✓ | ✓ | ✓ | — |
| Stream / download / waveform | any authenticated user, tenant-scoped | | | | |
| Upload (`media.upload`) | ✓ | ✓ | ✓ | — | — |
| Scan, deploy / re-deploy, edit metadata, delete (`media.manage`) | ✓ | ✓ | — | — | — |

## Conference Recordings (`/api/v1/recordings`)

| Capability | SUPER_ADMIN | ADMIN | SUPERVISOR | OPERATOR | VIEWER |
|---|---|---|---|---|---|
| List / detail (`recordings.view`) | ✓ | ✓ | — | ✓ | — |
| Notes / tags, archive (`recordings.annotate`) | ✓ | ✓ | — | ✓ | — |
| Delete (`recordings.delete`) | ✓ | ✓ | — | — | — |
| Stream / download / waveform | any authenticated user, tenant-scoped | | | | |

## Changes made in Phase B (2026-10-22)

| Change | Before | After | Why |
|---|---|---|---|
| Media list/detail/categories | ADMIN, OPERATOR | **+ SUPERVISOR** | Supervisors author IVR flows (`ivr` routes allow ADMIN/SUPERVISOR) and the IVR/ENS media pickers call the list; supervisors could already **upload** but could not see the library. This is a read permission; no write permission was added. |
| Recording delete | ADMIN, OPERATOR | **ADMIN only** | The UI never offered delete to operators, so the API was the only way an operator could remove ERS/ENS recordings (evidence). Tightened to the intersection of what the UI and the API allowed. |
| UI action visibility | ADMIN or SUPERVISOR saw scan/deploy/delete and recording archive/delete | Matches the table above | Removes buttons that only ever returned 403. |

## Playback and download links

`<audio src>` and downloads cannot send an `Authorization` header. The UI used to
put the full session JWT in the URL (`?token=`), where it was written to access
logs, browser history and `Referer` headers and granted the whole API.

The UI now calls `GET /<resource>/:id/access?purpose=stream|download` (Bearer
auth; tenant-scoped existence check; `Cache-Control: no-store`) and uses the
returned `sig` as `…/:id/stream?sig=…` or `…/:id/download?sig=…`
(`backend/src/middleware/mediaAccess.js`, `frontend/src/api/mediaAccess.js`).

- A signature is valid for **one** resource (media or recording), **one** id and
  **one** purpose, for 1 hour.
- It is signed with a key **derived** from the access secret. It is never
  accepted as an API bearer token, and a session JWT is never accepted as a `sig`.
- Issuing a recording link requires `recordings.view`. Issuing a media link
  requires any authenticated user, the same as the existing stream policy.
- **Compatibility:** `Authorization: Bearer` and the documented `?token=` form
  (`docs/03_API_REFERENCE.md`) are still accepted on stream/download/waveform.
  `?token=` is **deprecated** and no longer used by the UI. Removing it is an
  API-contract change and needs a separate approval.

## Stream / download hardening

| Change | Before | After |
|---|---|---|
| Range header | Parsed by hand; a malformed or out-of-bounds header produced `NaN` or past-EOF `Content-Range`/`Content-Length` | `req.range()` (RFC 7233). An unsatisfiable range returns **416** `bytes */size`. Ends past EOF are clamped. Unsupported forms (multi-range, non-`bytes`) get the full 200 body. Downloads also honour Range. |
| `Content-Disposition` | `filename="${name}"` with no escaping, so a stored name with `"` or CR/LF could break the header | Uses an ASCII fallback plus RFC 5987 `filename*=UTF-8''…` (`backend/src/utils/mediaHttp.js`) |
| Per-request logging | Every media stream request logged 3–5 lines, including server paths | Successful requests are not logged. Failures still are. |
| 404 bodies | Media returned `tried: [server paths]` and recordings returned `recording_path` | `{ error }` only. Paths go to the server log. |
| File read errors | A stream error could leave the response hanging or crash the process | Answers 500, or destroys the socket if headers were already sent |

## Open decision

`rbac.js` defines `canViewRecordings` = SUPER_ADMIN, ADMIN, **SUPERVISOR**, but it
has never been used; the recordings routes have used `adminOrOp` (SUPER_ADMIN,
ADMIN, **OPERATOR**) since they were created. Phase B deliberately leaves
recordings **view** access unchanged. Decide whether supervisors should see
recordings (and whether operators should keep seeing them) before changing it.

**Resolved for byte access (feature/media-reporting-hardening, 2026-10-26):**
recording **stream/download/waveform** now enforce `recordings.view` (`adminOrOp`)
like the list and the signed-link issuance; media **access/stream/download/waveform**
enforce `media.view`; `/uploads` is no longer public (auth + `media.view` + the
file's media row must be in the caller's tenant or shared). A request without
tenant context is 403. The SUPERVISOR-vs-OPERATOR question for recordings
**viewing** remains open as described above. See `docs/MEDIA_REPORTING_MISSION.md`.
