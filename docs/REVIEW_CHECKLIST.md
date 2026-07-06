# REVIEW CHECKLIST — fs-enrs

Use this checklist before marking any sprint as complete or merging to main.

---

## Backend Checklist

### API Layer
- [ ] All new routes registered in correct router file
- [ ] Specific path segments registered BEFORE `/:id` wildcard
- [ ] All routes have appropriate RBAC middleware (adminOnly / adminOrOp / anyAuth)
- [ ] All mutating routes have `auditLog(action)` middleware (Phase B6+)
- [ ] Internal API routes mounted under `/internal/` with `internalAuth` middleware only
- [ ] No JWT middleware on internal routes
- [ ] No internal routes mounted under `/api/v1/`

### Controller Layer
- [ ] All handlers wrapped in `asyncHandler`
- [ ] All request bodies parsed via Zod schema before any DB call
- [ ] Empty string → null handled via `emptyToNull` preprocessor where applicable
- [ ] All list endpoints return named key matching frontend consumer
- [ ] CREATE returns 201 with `RETURNING *` row
- [ ] DELETE returns 204
- [ ] 404 guard: `if (!rows[0]) return res.status(404).json({ error: '...' })`

### Database Layer
- [ ] All queries use `$n` parameterized placeholders
- [ ] All list queries filter `WHERE deleted_at IS NULL`
- [ ] All multi-tenant list queries filter `AND tenant_id = $n`
- [ ] FK columns have indexes
- [ ] Migration file uses `IF NOT EXISTS` for all DDL
- [ ] Migration file is wrapped in `BEGIN; ... COMMIT;`
- [ ] Rollback SQL commented at bottom of migration

### Security
- [ ] No secrets or API keys hardcoded
- [ ] Phone numbers passed to ESL validated with regex before use
- [ ] File paths in media endpoints validated (no path traversal)
- [ ] PBX passwords encrypted before storage
- [ ] Audit log strips password fields from request_payload

---

## Frontend Checklist

### State & Data
- [ ] `EMPTY` constant defines clean initial form state
- [ ] `openEdit` populates all form fields from row data
- [ ] All `<select>` for numeric IDs use `Number(e.target.value) || ''`
- [ ] `handleSave` builds explicit typed payload — never sends raw `form`
- [ ] All optional text fields: `form.field || null` in payload
- [ ] Multi-select IDs: `.map(Number)` before sending

### API Integration
- [ ] All API calls go through `api/client.js`
- [ ] List response destructured by named key: `g.groups`, `o.organizations`, etc.
- [ ] Error caught and shown in form: `setError(e.message)`, not `alert()`
- [ ] `saving` state prevents double-submit
- [ ] `load()` called after successful create/update/delete

### UI Completeness
- [ ] `<EmptyRow cols={N} />` shown when list is empty
- [ ] All icon-only buttons have `title` attribute
- [ ] Modal has Cancel and Save buttons with correct disabled state
- [ ] Error paragraph shown when `error` state is non-empty
- [ ] `Badge` component used for status columns (not raw text)

---

## Telephony / Lua Checklist

### Internal API Changes
- [ ] Any new/changed internal endpoint documented in `docs/API_STANDARDS.md`
- [ ] Corresponding Lua script updated to use new endpoint
- [ ] Lua script tested against real FreeSWITCH instance before marking complete

### ESL Service
- [ ] New ESL event handlers registered in `eslService.js`
- [ ] Socket.IO emit added for each new ESL event
- [ ] ESL reconnection logic unaffected

---

## Pre-deploy Final Check

- [ ] `npm test` passes in backend
- [ ] `npm run build` succeeds in frontend
- [ ] Migration applied to target DB
- [ ] `/health` endpoint returns all services OK
- [ ] ENS blast test: one contact, voice call completes
- [ ] ERS incident test: conference created, Lua joins responder
- [ ] Dashboard shows real-time events
- [ ] Audit log records last 3 operations correctly

---

## Sprint Completion Criteria

A sprint is complete when:
1. All checklist items above pass
2. Code is merged to main
3. Staging deployment is successful
4. User has approved the feature via testing on their server
