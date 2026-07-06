# CODING STANDARDS — fs-enrs

## General

- Node.js 20 LTS, ES Modules (`"type": "module"` in package.json)
- No TypeScript — plain JS with JSDoc where helpful
- `prettier` + `eslint` enforced. No commits with lint errors.
- Max file length: 400 lines. Split by concern if exceeded.
- No `console.log` in production paths — use structured logger (Winston or Pino)

## Backend (Express)

### Controller Pattern

Every controller file follows this structure:

```js
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

// Preprocessors (define once at top of file)
const emptyToNull = z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional());
const emptyToNullEmail = z.preprocess(v => (v === '' ? null : v), z.string().email().nullable().optional());

// Schema (Zod)
const EntitySchema = z.object({ ... });

// Handlers (named exports, wrapped in asyncHandler)
export const listEntities  = asyncHandler(async (req, res) => { ... });
export const createEntity  = asyncHandler(async (req, res) => { ... });
export const updateEntity  = asyncHandler(async (req, res) => { ... });
export const deleteEntity  = asyncHandler(async (req, res) => { ... });
```

### Response Shape Contract

**Every list endpoint must return a named key matching the frontend consumer:**

| Endpoint | Response shape |
|---|---|
| GET /users | `{ users, total, page, limit }` |
| GET /organizations | `{ organizations, total, page, limit }` |
| GET /contacts | `{ contacts, total, page, limit }` |
| GET /groups | `{ groups }` |
| GET /locations | `{ locations }` |
| GET /departments | `{ departments }` |
| GET /ens | `{ configurations, total, page, limit }` |
| GET /ers | `{ configurations, total, page, limit }` |

**Single resource**: return the row directly (no wrapper): `res.json(rows[0])`

**Create**: `res.status(201).json(rows[0])`

**Delete**: `res.status(204).end()`

**Error**: `res.status(4xx).json({ error: 'Human-readable message' })`

### Route Ordering Rule

CRITICAL: Specific path segments must be registered BEFORE wildcard `/:id` routes.

```js
// ✅ CORRECT
router.get('/locations',   ctrl.listLocations);   // specific first
router.get('/:id',         ctrl.getOrganization); // wildcard last

// ❌ WRONG — Express matches /:id before /locations
router.get('/:id',         ctrl.getOrganization);
router.get('/locations',   ctrl.listLocations);
```

### Zod Validation Rules

- All `<select>` inputs return strings — always use `z.number().int()` with `Number()` coercion on frontend
- Empty string from optional text input: use `emptyToNull` preprocessor
- Empty email: use `emptyToNullEmail` preprocessor
- Never use `z.string().email().optional()` alone — it rejects `''`

### SQL Rules

- Always use `$n` parameterized queries — never string interpolation
- Always filter `WHERE deleted_at IS NULL` on soft-deleted tables
- Always scope by `tenant_id` on list queries in multi-tenant controllers
- Use `COALESCE($n, column_name)` in UPDATE to allow partial updates
- Use `RETURNING *` on INSERT/UPDATE to avoid a second SELECT
- Transactions via `withTransaction(pool, async client => { ... })`

### Error Handling

- All route handlers wrapped in `asyncHandler` — never try/catch in controllers
- Zod parse errors caught by global error middleware → 422 + error details
- PostgreSQL constraint violations → 409 Conflict with human message
- 404 pattern: `if (!rows[0]) return res.status(404).json({ error: 'X not found' })`

## Frontend (React)

### Component Structure

```jsx
// 1. Imports (React, lucide, api, ui components)
// 2. Constants (EMPTY state, static arrays)
// 3. Default export function
//    a. useState hooks
//    b. load() + useEffect
//    c. Event handlers (handleSave, openEdit, del)
//    d. Render (JSX)
```

### Form State Rules

- `EMPTY` constant defines the shape of a clean form
- `f(key, value)` shorthand: `setForm(p => ({ ...p, [key]: value }))`
- `<select>` for numeric IDs: `onChange={e => f('field', Number(e.target.value) || '')}`
- `handleSave` builds a clean typed payload — never sends raw `form` object

### API Client Rules

- All API calls go through `api/client.js` — never raw fetch/axios in components
- Error messages: `catch (e) { setError(e.message) }` — display in form, never alert()
- Use `alert()` only for destructive confirmations (`confirm()` for deletes)

### Naming

- Pages: `PascalCase.jsx` in `pages/<entity>/`
- Shared UI: `components/ui/` — Modal, Table, Badge, Spinner
- No inline styles — all Tailwind utility classes

## Security Coding Rules

- Never log JWT tokens, passwords, or API keys
- Never return password hashes in API responses
- Sanitize all file paths in media upload handlers
- `X-Internal-Key` must only be read from `process.env.INTERNAL_API_KEY` — never hardcoded
- Never use `eval()`, `Function()`, or dynamic `require()` with user input
