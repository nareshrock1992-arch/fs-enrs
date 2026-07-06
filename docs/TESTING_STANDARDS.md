# TESTING STANDARDS — fs-enrs

## Philosophy

- Test behavior, not implementation
- Integration tests over unit tests for controllers (real DB, not mocks)
- Unit tests for pure logic: Zod schemas, utility functions, channel formatters
- No mocking PostgreSQL — use a dedicated test database `fs_enrs_test`

## Test Stack

- `vitest` for all tests (compatible with ES Modules)
- `supertest` for HTTP integration tests
- `pg` for direct DB assertions
- Test DB seeded before each test file, rolled back after

## Directory Structure

```
backend/src/__tests__/
  unit/
    schemas/
      organizationSchema.test.js
      contactSchema.test.js
      ensSchema.test.js
    utils/
      emptyToNull.test.js
  integration/
    auth.test.js
    organizations.test.js
    contacts.test.js
    groups.test.js
    ens.test.js
    ers.test.js
    internal-api.test.js   (B1)
    ivr.test.js            (B3)
    dids.test.js           (B7)
```

## Integration Test Pattern

```js
import request from 'supertest';
import app from '../../app.js';
import { query } from '../../db/pool.js';

let adminToken;
let orgId;

beforeAll(async () => {
  // Seed: create tenant + admin user + org
  adminToken = await getTestToken('ADMIN');
  const { rows } = await query(
    `INSERT INTO organizations (tenant_id, name, code) VALUES (1, 'Test Org', 'TST') RETURNING id`
  );
  orgId = rows[0].id;
});

afterAll(async () => {
  await query(`DELETE FROM organizations WHERE code = 'TST'`);
});

describe('GET /api/v1/organizations', () => {
  it('returns organizations list with named key', async () => {
    const res = await request(app)
      .get('/api/v1/organizations')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toHaveProperty('organizations');
    expect(Array.isArray(res.body.organizations)).toBe(true);
  });

  it('returns 401 without token', async () => {
    await request(app).get('/api/v1/organizations').expect(401);
  });

  it('returns 403 for VIEWER role on admin endpoint', async () => {
    const viewerToken = await getTestToken('VIEWER');
    await request(app)
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'x', code: 'x' })
      .expect(403);
  });
});
```

## What Must Be Tested Per Module

### Every CRUD Controller
- [ ] GET list: returns named key, pagination works, tenant filter works
- [ ] GET single: 200 with data, 404 on missing
- [ ] POST create: 201 + created row returned, Zod rejects invalid body
- [ ] PUT update: 200 + updated, COALESCE preserves untouched fields
- [ ] DELETE: 204, subsequent GET returns 404
- [ ] RBAC: VIEWER blocked, OPERATOR blocked from admin-only, ADMIN succeeds

### ENS Specific
- [ ] Trigger blast: inserts ens_notifications row, returns notification_uuid
- [ ] Delivery update: updates ens_deliveries status

### ERS Specific
- [ ] Incident creation: returns conference_name
- [ ] Queue operations: QUEUED → PROCESSING → COMPLETED

### Internal API (B1)
- [ ] Lookup with valid destination_number → 200
- [ ] Lookup with unknown number → 404
- [ ] Missing X-Internal-Key → 403
- [ ] Wrong X-Internal-Key → 403

## Zod Schema Unit Tests

```js
import { OrganizationSchema } from '../controllers/organizationController.js';

describe('OrganizationSchema', () => {
  it('accepts valid payload', () => {
    expect(() => OrganizationSchema.parse({ name: 'Org', code: 'O1' })).not.toThrow();
  });

  it('accepts empty email as null', () => {
    const r = OrganizationSchema.parse({ name: 'x', code: 'x', email: '' });
    expect(r.email).toBeNull();
  });

  it('rejects invalid email', () => {
    expect(() => OrganizationSchema.parse({ name: 'x', code: 'x', email: 'not-email' }))
      .toThrow();
  });

  it('rejects missing name', () => {
    expect(() => OrganizationSchema.parse({ code: 'x' })).toThrow();
  });
});
```

## Coverage Targets

| Layer | Target |
|---|---|
| Controllers (integration) | ≥ 80% line coverage |
| Zod schemas (unit) | 100% — all edge cases |
| Internal API | 100% — every route |
| Auth flows | 100% — login, refresh, logout |

## CI Gate

Tests must pass before any merge to `main`. Run with:
```bash
npm test --workspace=backend
```
