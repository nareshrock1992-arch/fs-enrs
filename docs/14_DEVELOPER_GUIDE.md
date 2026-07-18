# 14 — Developer Guide

## Adding a New API Endpoint

### 1. Choose the correct surface

| Use case | Surface | Auth middleware |
|---|---|---|
| UI / browser call | `routes/v1/` | `requireAuth` + RBAC guard |
| Lua / FreeSWITCH call | `routes/internal/` | `internalAuth` |

Never mix the two surfaces. Never add JWT auth to internal routes.

### 2. Add the route

```js
// backend/src/routes/v1/ers.js
import { newHandler } from '../../controllers/ersController.js';

router.post('/configurations/:id/some-action', requireAuth, adminOrOp, newHandler);
```

All route handlers must be wrapped in `asyncHandler` (done at the controller level — import from `asyncHandler.js`).

### 3. Write the controller

```js
// backend/src/controllers/ersController.js
export const newHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { someField } = req.body;
  const tenantId = req.user.tenantId;  // ALWAYS from JWT, never request body

  // Zod validation (inline or via validate() middleware)
  const schema = z.object({ someField: z.string().min(1) });
  const parsed = schema.parse(req.body);

  const { rows } = await query(
    `SELECT * FROM ers_configurations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [id, tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });

  // Do work...
  emitInternal('enrs::some_event', { id });

  return res.json({ success: true });
});
```

**Rules:**
- Always include `AND deleted_at IS NULL` in queries
- Always scope by `tenant_id` from `req.user.tenantId`
- Never trust tenant from request body
- Use `emitInternal()` for any real-time update
- `asyncHandler` handles rejected promises — no try/catch needed

### 4. Run migrations if needed

Add a new file: `backend/src/db/migrations/028_your_change.sql`

```sql
BEGIN;

ALTER TABLE ers_configurations ADD COLUMN IF NOT EXISTS new_col TEXT;

INSERT INTO applied_migrations (id, applied_at) VALUES ('028', NOW())
ON CONFLICT DO NOTHING;

COMMIT;
```

Requirements:
- Self-contained `BEGIN/COMMIT`
- Fully idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`)
- Never modify existing migrations (001–027)
- Number sequentially

### 5. Add frontend API method

```js
// frontend/src/api/client.js
ers: {
  // ...existing...
  someAction: (id, data) => request('POST', `/ers/configurations/${id}/some-action`, data),
}
```

---

## Adding a New IVR Node Type

IVR node types live in `backend/src/nodeTypes/registry.js`. Each node type definition has:

```js
{
  type: 'MY_NODE',
  label: 'My Node',
  description: 'What this node does',
  icon: 'icon-name',
  configSchema: z.object({
    someParam: z.string()
  }),
  generateLua(node, context) {
    return `session:execute("some_app", "${node.config.someParam}")`;
  },
  generateXml(node, context) {
    return `<action application="some_app" data="${node.config.someParam}"/>`;
  }
}
```

After adding a node type, update `nodeTypeSelfCheck.js` if the node calls any internal API endpoints — the self-check verifies those routes exist at boot time.

---

## Adding an ESL Command

All ESL commands go through `eslCommand()` in `eslService.js`.

```js
// In any service or controller:
import { eslCommand } from '../services/eslService.js';

await eslCommand(`conference ${room} play /path/to/file.wav`);
```

Never construct ESL commands with untrusted input — sanitize conference names via `getConferenceProfile()` / `resolveConferenceRoom()` before use.

For conference auto-recording that needs to react to ESL events:
1. Add a hook in `eslService.js` — either in the `conference::maintenance` handler or as a separate event subscription
2. Call your handler via dynamic `import('./yourService.js')` to avoid circular dependencies

---

## Adding a Socket.IO Event

```js
// In any controller or service:
import { emitInternal } from '../services/socketService.js';

emitInternal('enrs::my_new_event', {
  incident_uuid: '...',
  status: 'ACTIVE'
});
```

The `emitInternal()` call broadcasts to all authenticated Socket.IO connections — no room/namespace filtering.

Frontend listener:
```js
// frontend/src/api/socket.js
socket.on('enrs::my_new_event', (data) => {
  // update local state
});
```

---

## Adding a DB Migration

```
backend/src/db/migrations/028_my_change.sql
```

**Checklist:**
- [ ] File name starts with the next sequential number
- [ ] Wrapped in `BEGIN; ... COMMIT;`
- [ ] All `ALTER TABLE` use `IF NOT EXISTS`
- [ ] New tables use `ON CONFLICT DO NOTHING` in seed data
- [ ] Final `INSERT INTO applied_migrations` at end
- [ ] Tested on both fresh install and existing DB

Run locally:
```bash
cd backend && node src/db/migrate.js
```

---

## Adding a FreeSWITCH Lua Variable

If a new Lua variable is needed:

1. Add to `backend/src/config/index.js` and/or `fsConfig.js`
2. Document in `10_CONFIGURATION_GUIDE.md` (FS Lua environment section)
3. Return it from the appropriate internal API endpoint (the Lua script reads from API responses, not env directly, for business logic)
4. If it's a FreeSWITCH environment variable, document it in `freeswitch.xml` example

**Never** add hardcoded values to Lua scripts — all business logic comes from API responses.

---

## Testing

### Run all tests
```bash
cd backend && npm test
```

### Run a single test file
```bash
cd backend && npx vitest run src/__tests__/integration/ivr.test.js
```

### Integration tests require
- A running PostgreSQL instance with `fs_enrs` database
- Migrations applied (`node src/db/migrate.js`)
- Environment variables set (DB credentials, JWT secrets)

The integration tests do **not** mock the database — they hit a real DB. This is intentional: `tests/feedback_no_db_mocks` policy.

### Writing a test

```js
// backend/src/__tests__/integration/myFeature.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';

describe('My Feature', () => {
  let token;

  beforeAll(async () => {
    // Login and get token
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@enrs.local', password: 'Admin@12345' });
    token = res.body.token;
  });

  it('should do the thing', async () => {
    const res = await request(app)
      .get('/api/v1/ers/configurations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toBeInstanceOf(Array);
  });
});
```

---

## Multi-Tenancy Rules

Every INSERT that creates a configuration, contact, incident, or recording row **must**:
```js
const tenantId = req.user.tenantId;  // from JWT
await query(`INSERT INTO my_table (tenant_id, ...) VALUES ($1, ...)`, [tenantId, ...]);
```

Every LIST query must filter:
```sql
WHERE tenant_id = $1 AND deleted_at IS NULL
```

The `ivrGraphValidator.js` validates that ERS/ENS nodes in a flow reference configurations belonging to the same tenant. When adding new node types that reference DB entities, add the same tenant cross-check to the validator.

---

## Soft-Delete Rules

All user-facing entities use soft-delete. Never use `DELETE FROM` — use:

```sql
UPDATE my_table SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2;
```

All read queries must include `AND deleted_at IS NULL`. Missing this filter is a common bug — check every new query.

---

## Error Handling

The global `errorHandler` middleware in `asyncHandler.js` maps:

| PG Error Code | HTTP Status |
|---|---|
| `23505` (unique violation) | `409 Conflict` |
| `23503` (FK violation) | `409 Conflict` |
| All other DB errors | `500 Internal Server Error` (with `._sql` and `._params` logged) |

For application-level errors, throw:
```js
const err = new Error('Configuration not found');
err.status = 404;
throw err;
```

Or return directly:
```js
return res.status(404).json({ error: 'Configuration not found' });
```

---

## RBAC — Adding a New Role Check

Named middleware exports are in `backend/src/middleware/rbac.js`. If you need a new combination:

```js
export const myNewGuard = (req, res, next) => {
  if (!['ADMIN', 'SUPERVISOR'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};
```

Prefer reusing existing guards (`adminOnly`, `adminOrSuper`, `adminOrOp`, `anyRole`) over inline role checks in route handlers.

---

## Logging

No dedicated logger library — `console.log` / `console.error` are used throughout.

Convention:
```js
console.log(`[ers-ring] wave ${wave} — ringing ${n} responders into ${room}`);
console.error(`[esl] command failed: ${err.message}`);
```

Use `[module-name]` prefix so logs are grep-able in PM2 output.
