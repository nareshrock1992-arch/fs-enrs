/**
 * Emergency Contacts — enterprise table (search / filter / sort / paging, export,
 * bulk delete, create/update validation, CSV import).
 *
 *  CE-1  default list is unchanged (shape, order, 200 cap) and tenant-scoped
 *  CE-2  paging
 *  CE-3  sorting (whitelisted keys, both directions, invalid → 400)
 *  CE-4  filters (organization, department, location, status, role) + invalid parameters → 400
 *  CE-5  search (name, full name, mobile, extension, email, role; LIKE wildcards literal)
 *  CE-6  tenant isolation of list / filters / search / roles / export
 *  CE-7  SUPER_ADMIN: All Tenants vs a selected tenant
 *  CE-8  CSV export (all matching rows, escaping, role access)
 *  CE-9  bulk delete (tenant-scoped, unknown / foreign ids never deleted)
 *  CE-10 create / update validation (department, location, organization change, clearing fields)
 *  CE-11 CSV import (documented columns, legacy header, readable errors, duplicate detection)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { parse } from 'csv-parse/sync';

process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-32chars-padding!';

import server from '../../../server.js';
import { query, pool } from '../../db/pool.js';

const TS = Date.now();
let tenantA, tenantB, orgA1, orgA2, orgB, deptA1, deptA2, deptB, locA1, locA2, locB;
let adminA = '', operatorA = '', supervisorA = '', adminB = '', superAdmin = '';
const userIds = [];
const extraOrgs = [];   // organizations created by later tests (cleaned up in afterAll)
const c = {};   // contacts by key

async function makeUser(email, role, tenantId) {
  const hash = await bcrypt.hash('Test1234!', 4);
  const { rows: [u] } = await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, is_active, full_name)
     VALUES ($1,$2,$3,$4,true,'Contacts Test') RETURNING id`,
    [email, hash, role, tenantId]
  );
  userIds.push(u.id);
  const res = await request(server).post('/api/v1/auth/login').send({ email, password: 'Test1234!' });
  return res.body.token;
}

async function makeContact(key, f) {
  const { rows: [r] } = await query(
    `INSERT INTO emergency_contacts
       (organization_id, department_id, location_id, first_name, last_name, role,
        mobile_number, extension_number, email, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [f.org, f.dept ?? null, f.loc ?? null, f.first, f.last, f.role ?? null,
     f.mobile ?? null, f.ext ?? null, f.email ?? null, f.active ?? true]
  );
  c[key] = r.id;
  return r.id;
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const list = (token, q = {}) => request(server).get('/api/v1/contacts').query(q).set(auth(token));
const ids = (res) => res.body.contacts.map(r => r.id);
const live = async (id) => (await query(`SELECT deleted_at IS NULL AS live FROM emergency_contacts WHERE id=$1`, [id])).rows[0]?.live;

beforeAll(async () => {
  ({ rows: [{ id: tenantA }] } = await query(`INSERT INTO tenants (name, code) VALUES ($1,$2) RETURNING id`, [`CE-A-${TS}`, `ce-a-${TS}`]));
  ({ rows: [{ id: tenantB }] } = await query(`INSERT INTO tenants (name, code) VALUES ($1,$2) RETURNING id`, [`CE-B-${TS}`, `ce-b-${TS}`]));
  ({ rows: [{ id: orgA1 }] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ('CE Org A1',$1) RETURNING id`, [tenantA]));
  ({ rows: [{ id: orgA2 }] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ('CE Org A2',$1) RETURNING id`, [tenantA]));
  ({ rows: [{ id: orgB }] }  = await query(`INSERT INTO organizations (name, tenant_id) VALUES ('CE Org B',$1) RETURNING id`, [tenantB]));
  ({ rows: [{ id: deptA1 }] } = await query(`INSERT INTO departments (organization_id, name) VALUES ($1,'Dept A1') RETURNING id`, [orgA1]));
  ({ rows: [{ id: deptA2 }] } = await query(`INSERT INTO departments (organization_id, name) VALUES ($1,'Dept A2') RETURNING id`, [orgA2]));
  ({ rows: [{ id: deptB }] }  = await query(`INSERT INTO departments (organization_id, name) VALUES ($1,'Dept B') RETURNING id`, [orgB]));
  ({ rows: [{ id: locA1 }] } = await query(`INSERT INTO locations (organization_id, name) VALUES ($1,'Loc A1') RETURNING id`, [orgA1]));
  ({ rows: [{ id: locA2 }] } = await query(`INSERT INTO locations (organization_id, name) VALUES ($1,'Loc A2') RETURNING id`, [orgA2]));
  ({ rows: [{ id: locB }] }  = await query(`INSERT INTO locations (organization_id, name) VALUES ($1,'Loc B') RETURNING id`, [orgB]));

  // Tenant A — 7 contacts across two organizations
  await makeContact('ann', { org: orgA1, dept: deptA1, loc: locA1, first: 'Ann', last: 'Zed',   role: 'Security', mobile: '+966500000001', ext: '1001', email: 'ann@a.test' });
  await makeContact('bob', { org: orgA1, dept: deptA1,              first: 'Bob', last: 'Young', role: 'security', mobile: '+966500000002', ext: '1002', email: 'bob_x@a.test' });
  await makeContact('cy',  { org: orgA1,                            first: 'Cy',  last: 'Xu',    role: 'Manager',  mobile: '0500000003',                email: 'cy@a.test', active: false });
  await makeContact('dee', { org: orgA2, dept: deptA2, loc: locA2, first: 'Dee', last: 'Wolfe', role: 'Medic',    ext: '2004' });
  await makeContact('eve', { org: orgA2,                            first: 'Eve', last: 'Vance', role: '=HYPERLINK("x")', mobile: '+966 50 000 0005', email: 'eve%pct@a.test' });
  await makeContact('fay', { org: orgA2,                            first: 'Fay', last: 'O"Brien, Jr', role: 'Line1\nLine2', mobile: '-12' });
  await makeContact('gus', { org: orgA1,                            first: 'Gus', last: 'Abbot',  mobile: '0500000007' });
  // Tenant B
  await makeContact('bz1', { org: orgB, dept: deptB, loc: locB, first: 'Bea', last: 'Foreign', role: 'Secret Role B', mobile: '+15550000001', ext: '9001' });
  await makeContact('bz2', { org: orgB,                         first: 'Ben', last: 'Foreign', mobile: '+15550000002' });

  adminA      = await makeUser(`ce-admin-a-${TS}@test.local`, 'ADMIN', tenantA);
  operatorA   = await makeUser(`ce-op-a-${TS}@test.local`, 'OPERATOR', tenantA);
  supervisorA = await makeUser(`ce-sup-a-${TS}@test.local`, 'SUPERVISOR', tenantA);
  adminB      = await makeUser(`ce-admin-b-${TS}@test.local`, 'ADMIN', tenantB);
  superAdmin  = await makeUser(`ce-super-${TS}@test.local`, 'SUPER_ADMIN', null);
});

afterAll(async () => {
  const orgs = [orgA1, orgA2, orgB, ...extraOrgs].filter(Boolean);
  await query(`DELETE FROM emergency_contacts WHERE organization_id = ANY($1::int[])`, [orgs]);
  await query(`DELETE FROM departments WHERE organization_id = ANY($1::int[])`, [orgs]);
  await query(`DELETE FROM locations WHERE organization_id = ANY($1::int[])`, [orgs]);
  await query(`DELETE FROM organizations WHERE id = ANY($1::int[])`, [orgs]);
  if (userIds.length) await query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  await query(`DELETE FROM tenants WHERE id = ANY($1::int[])`, [[tenantA, tenantB].filter(Boolean)]);
});

describe('CE-1: default list is unchanged and tenant-scoped', () => {
  it('returns { contacts, total, page, limit } in last-name order with only the tenant\'s contacts', async () => {
    const res = await list(adminA);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['contacts', 'limit', 'page', 'total']);
    expect(res.body.total).toBe(7);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(50);
    expect(res.body.contacts.map(r => r.last_name)).toEqual(['Abbot', 'O"Brien, Jr', 'Vance', 'Wolfe', 'Xu', 'Young', 'Zed']);
    expect(res.body.contacts[0]).toHaveProperty('organization_name', 'CE Org A1');
  });

  it('keeps the 200-row cap the pickers rely on (limit=1000 → 200)', async () => {
    const res = await list(adminA, { limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
  });

  it('carries each contact\'s tenant (additive)', async () => {
    const res = await list(adminA);
    expect(res.body.contacts.every(r => r.tenant_id === tenantA)).toBe(true);
  });
});

describe('CE-2: paging', () => {
  it('returns consecutive, non-overlapping pages with a stable total', async () => {
    const p1 = await list(adminA, { limit: 3, page: 1 });
    const p2 = await list(adminA, { limit: 3, page: 2 });
    const p3 = await list(adminA, { limit: 3, page: 3 });
    expect([p1, p2, p3].map(r => r.body.total)).toEqual([7, 7, 7]);
    const all = [...ids(p1), ...ids(p2), ...ids(p3)];
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
  });
});

describe('CE-3: sorting', () => {
  it('sorts by each whitelisted key in both directions', async () => {
    const byName = await list(adminA, { sort: 'name', dir: 'desc' });
    expect(byName.body.contacts.map(r => r.last_name)[0]).toBe('Zed');
    const org = await list(adminA, { sort: 'organization', dir: 'asc' });
    expect(org.body.contacts.map(r => r.organization_name)).toEqual([...org.body.contacts.map(r => r.organization_name)].sort());
    const roleAsc = await list(adminA, { sort: 'role', dir: 'asc' });
    expect(roleAsc.body.contacts.at(-1).id).toBe(c.gus);            // empty role last
    const roleDesc = await list(adminA, { sort: 'role', dir: 'desc' });
    expect(roleDesc.body.contacts.at(-1).id).toBe(c.gus);           // empty role last both ways
    const status = await list(adminA, { sort: 'status', dir: 'asc' });
    expect(status.body.contacts[0].id).toBe(c.cy);                  // inactive first
    for (const key of ['mobile', 'extension', 'email', 'department', 'location', 'updated_at', 'created_at', 'tenant']) {
      const r = await list(adminA, { sort: key, dir: 'desc' });
      expect(r.status, key).toBe(200);
      expect(r.body.total, key).toBe(7);
    }
  });

  it('rejects an unknown sort key or direction with 400', async () => {
    expect((await list(adminA, { sort: 'password_hash' })).status).toBe(400);
    expect((await list(adminA, { sort: 'name', dir: 'sideways' })).status).toBe(400);
    expect((await list(adminA, { sort: 'c.id; DROP TABLE x' })).status).toBe(400);
  });
});

describe('CE-4: filters and parameter validation', () => {
  it('filters by organization, department, location, status and role', async () => {
    expect(ids(await list(adminA, { organization_id: orgA2 })).sort()).toEqual([c.dee, c.eve, c.fay].sort());
    expect(ids(await list(adminA, { department_id: deptA1 })).sort()).toEqual([c.ann, c.bob].sort());
    expect(ids(await list(adminA, { location_id: locA2 }))).toEqual([c.dee]);
    expect(ids(await list(adminA, { is_active: 'false' }))).toEqual([c.cy]);
    expect((await list(adminA, { is_active: 'true' })).body.total).toBe(6);
    expect(ids(await list(adminA, { role: 'SECURITY' })).sort()).toEqual([c.ann, c.bob].sort());
    const both = await list(adminA, { organization_id: orgA1, role: 'security', department_id: deptA1, location_id: locA1 });
    expect(ids(both)).toEqual([c.ann]);
  });

  it('rejects malformed numeric and boolean parameters with 400 (was 500)', async () => {
    for (const q of [{ organization_id: 'abc' }, { department_id: '0' }, { location_id: '-1' },
                     { organization_id: '1.5' }, { is_active: 'maybe' }]) {
      const res = await list(adminA, q);
      expect(res.status, JSON.stringify(q)).toBe(400);
    }
  });

  it('rejects a malformed contact id with 400 (was 500)', async () => {
    expect((await request(server).get('/api/v1/contacts/abc').set(auth(adminA))).status).toBe(400);
    expect((await request(server).put('/api/v1/contacts/abc').set(auth(adminA)).send({ role: 'x' })).status).toBe(400);
    expect((await request(server).delete('/api/v1/contacts/1x').set(auth(adminA))).status).toBe(400);
  });
});

describe('CE-5: search', () => {
  it('matches first, last and full name, mobile, extension, email and role', async () => {
    expect(ids(await list(adminA, { search: 'ann zed' }))).toEqual([c.ann]);
    expect(ids(await list(adminA, { search: '2004' }))).toEqual([c.dee]);
    expect(ids(await list(adminA, { search: 'medic' }))).toEqual([c.dee]);
    expect(ids(await list(adminA, { search: '500000003' }))).toEqual([c.cy]);
    expect(ids(await list(adminA, { search: 'cy@a.test' }))).toEqual([c.cy]);
  });

  it('treats % and _ as literal characters', async () => {
    expect(ids(await list(adminA, { search: '_' }))).toEqual([c.bob]);
    expect(ids(await list(adminA, { search: '%' }))).toEqual([c.eve]);
  });
});

describe('CE-6: tenant isolation', () => {
  it('a forged ?tenant_id, foreign filters and foreign search terms reveal nothing', async () => {
    expect((await list(adminA, { tenant_id: tenantB })).body.total).toBe(7);
    expect((await list(adminA, { organization_id: orgB })).body.total).toBe(0);
    expect((await list(adminA, { department_id: deptB })).body.total).toBe(0);
    expect((await list(adminA, { location_id: locB })).body.total).toBe(0);
    expect((await list(adminA, { search: 'Foreign' })).body.total).toBe(0);
    expect((await list(adminA, { role: 'Secret Role B' })).body.total).toBe(0);
    expect((await list(adminA, { sort: 'tenant', limit: 200 })).body.contacts.every(r => r.tenant_id === tenantA)).toBe(true);
  });

  it('the roles list contains only the tenant\'s roles', async () => {
    const res = await request(server).get('/api/v1/contacts/roles').set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('Medic');
    expect(res.body.roles).not.toContain('Secret Role B');
    const b = await request(server).get('/api/v1/contacts/roles').set(auth(adminB));
    expect(b.body.roles).toEqual(['Secret Role B']);
  });

  it('a tenant admin cannot read another tenant\'s contact by id', async () => {
    expect((await request(server).get(`/api/v1/contacts/${c.bz1}`).set(auth(adminA))).status).toBe(404);
  });
});

describe('CE-7: SUPER_ADMIN scope', () => {
  it('All Tenants lists both tenants with tenant names; a selected tenant restricts', async () => {
    const all = await list(superAdmin, { search: 'Foreign' });
    expect(all.body.total).toBe(2);
    expect(all.body.contacts[0].tenant_name).toBe(`CE-B-${TS}`);
    const onlyA = await list(superAdmin, { tenant_id: tenantA, search: 'Foreign' });
    expect(onlyA.body.total).toBe(0);
    expect((await list(superAdmin, { tenant_id: tenantA })).body.total).toBe(7);
  });
});

describe('CE-8: CSV export', () => {
  const exportCsv = (token, q = {}) => request(server).get('/api/v1/contacts/export').query(q).set(auth(token))
    .buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', x => { d += x; }); res.on('end', () => cb(null, d)); });

  it('exports every matching row regardless of page / limit, with correct escaping', async () => {
    const res = await exportCsv(adminA, { page: 2, limit: 1 });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="contacts-.*\.csv"/);
    const text = res.body;
    expect(text.charCodeAt(0)).toBe(0xFEFF);
    const rows = parse(text, { columns: true, bom: true });
    expect(rows).toHaveLength(7);
    expect(Object.keys(rows[0]).slice(0, 6)).toEqual(['first_name', 'last_name', 'mobile_number', 'extension_number', 'email', 'role']);
    expect(Object.keys(rows[0])).not.toContain('tenant');
    const fay = rows.find(r => r.first_name === 'Fay');
    expect(fay.last_name).toBe('O"Brien, Jr');
    expect(fay.role).toBe('Line1\nLine2');
    expect(fay.mobile_number).toBe("'-12");                         // leading minus neutralised
    const eve = rows.find(r => r.first_name === 'Eve');
    expect(eve.role).toBe(`'=HYPERLINK("x")`);                       // formula neutralised
    expect(eve.mobile_number).toBe('+966 50 000 0005');              // phone numbers untouched
  });

  it('applies the same filters, search and tenant scope as the list', async () => {
    const res = await exportCsv(adminA, { organization_id: orgA2, tenant_id: tenantB });
    const rows = parse(res.body, { columns: true, bom: true });
    expect(rows.map(r => r.first_name).sort()).toEqual(['Dee', 'Eve', 'Fay']);
    const foreign = parse((await exportCsv(adminA, { search: 'Foreign' })).body, { columns: true, bom: true });
    expect(foreign).toHaveLength(0);
  });

  it('includes the tenant column for SUPER_ADMIN under All Tenants only', async () => {
    const all = parse((await exportCsv(superAdmin, { search: 'Foreign' })).body, { columns: true, bom: true });
    expect(all).toHaveLength(2);
    expect(all[0].tenant).toBe(`CE-B-${TS}`);
    const one = parse((await exportCsv(superAdmin, { tenant_id: tenantA })).body, { columns: true, bom: true });
    expect(one).toHaveLength(7);
    expect(Object.keys(one[0])).not.toContain('tenant');
  });

  it('is allowed to the roles that may list (OPERATOR yes, SUPERVISOR no)', async () => {
    expect((await exportCsv(operatorA)).status).toBe(200);
    expect((await exportCsv(supervisorA)).status).toBe(403);
  });
});

describe('CE-9: bulk delete', () => {
  const bulk = (token, body) => request(server).post('/api/v1/contacts/bulk-delete').set(auth(token)).send(body);

  it('validates the request', async () => {
    expect((await bulk(adminA, {})).status).toBe(400);
    expect((await bulk(adminA, { ids: [] })).status).toBe(400);
    expect((await bulk(adminA, { ids: ['1'] })).status).toBe(400);
    expect((await bulk(adminA, { ids: [0] })).status).toBe(400);
    expect((await bulk(adminA, { ids: Array.from({ length: 501 }, (_, i) => i + 1) })).status).toBe(400);
    expect((await bulk(operatorA, { ids: [c.gus] })).status).toBe(403);
  });

  it('deletes only the caller\'s contacts; foreign, unknown and repeated ids are never deleted', async () => {
    const x1 = await makeContact('x1', { org: orgA1, first: 'Del', last: 'One', mobile: '1' });
    const x2 = await makeContact('x2', { org: orgA2, first: 'Del', last: 'Two', mobile: '2' });
    const res = await bulk(adminA, { ids: [x1, x2, c.bz1, 2147483000, x1], tenant_id: tenantB });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(res.body.deleted_ids.sort()).toEqual([x1, x2].sort());
    expect(res.body.not_found.sort((a, b) => a - b)).toEqual([c.bz1, 2147483000].sort((a, b) => a - b));
    expect(await live(x1)).toBe(false);
    expect(await live(x2)).toBe(false);
    expect(await live(c.bz1)).toBe(true);
    const again = await bulk(adminA, { ids: [x1] });
    expect(again.body).toMatchObject({ deleted: 0, not_found: [x1] });
  });

  it('SUPER_ADMIN: a selected tenant restricts; All Tenants may delete any tenant\'s contact', async () => {
    const y = await makeContact('y', { org: orgB, first: 'Del', last: 'B', mobile: '3' });
    const scoped = await bulk(superAdmin, { ids: [y], tenant_id: tenantA });
    expect(scoped.body).toMatchObject({ deleted: 0, not_found: [y] });
    expect(await live(y)).toBe(true);
    const all = await bulk(superAdmin, { ids: [y] });
    expect(all.body).toMatchObject({ deleted: 1, deleted_ids: [y] });
  });
});

describe('CE-10: create / update validation', () => {
  const create = (token, body) => request(server).post('/api/v1/contacts').set(auth(token)).send(body);
  const update = (token, id, body) => request(server).put(`/api/v1/contacts/${id}`).set(auth(token)).send(body);
  const row = async (id) => (await query(`SELECT * FROM emergency_contacts WHERE id=$1`, [id])).rows[0];
  const base = { first_name: 'New', last_name: 'Person', mobile_number: '0500' };

  it('create: department / location must belong to the organization', async () => {
    expect((await create(adminA, { ...base, organization_id: orgA1, department_id: deptB })).status).toBe(400);
    expect((await create(adminA, { ...base, organization_id: orgA1, department_id: deptA2 })).status).toBe(400);
    expect((await create(adminA, { ...base, organization_id: orgA1, location_id: locB })).status).toBe(400);
    expect((await create(adminA, { ...base, organization_id: orgB })).status).toBe(404);
    const ok = await create(adminA, { ...base, organization_id: orgA1, department_id: deptA1, location_id: locA1 });
    expect(ok.status).toBe(201);
    c.created = ok.body.id;
  });

  it('update: organization change is applied within the tenant, refused across tenants', async () => {
    const moved = await update(adminA, c.created, { organization_id: orgA2, department_id: deptA2, location_id: null });
    expect(moved.status).toBe(200);
    expect((await row(c.created)).organization_id).toBe(orgA2);
    expect((await row(c.created)).department_id).toBe(deptA2);
    const cross = await update(adminA, c.created, { organization_id: orgB, department_id: null });
    expect(cross.status).toBe(400);
    expect((await row(c.created)).organization_id).toBe(orgA2);
    const saCross = await update(superAdmin, c.created, { organization_id: orgB, department_id: null });
    expect(saCross.status).toBe(400);
    expect((await row(c.created)).organization_id).toBe(orgA2);
  });

  it('update: department / location are checked against the (new) organization', async () => {
    expect((await update(adminA, c.created, { department_id: deptA1 })).status).toBe(400);
    expect((await update(adminA, c.created, { department_id: deptB })).status).toBe(400);
    expect((await update(adminA, c.created, { location_id: locB })).status).toBe(400);
    expect((await update(adminA, c.created, { organization_id: orgA1 })).status).toBe(400); // keeps deptA2 of orgA2
    expect((await row(c.created)).department_id).toBe(deptA2);
  });

  it('update: optional fields can be cleared; mobile-or-extension is still required', async () => {
    await update(adminA, c.created, { email: 'p@a.test', role: 'Temp', extension_number: '77' });
    const cleared = await update(adminA, c.created, { email: null, role: null, department_id: null });
    expect(cleared.status).toBe(200);
    const r = await row(c.created);
    expect([r.email, r.role, r.department_id]).toEqual([null, null, null]);
    expect((await update(adminA, c.created, { mobile_number: null, extension_number: null })).status).toBe(400);
    expect((await update(adminA, c.created, { mobile_number: null })).status).toBe(200);   // extension 77 remains
    expect((await row(c.created)).extension_number).toBe('77');
  });

  it('update of another tenant\'s contact is 404 and changes nothing', async () => {
    expect((await update(adminA, c.bz1, { role: 'hacked' })).status).toBe(404);
    expect((await row(c.bz1)).role).toBe('Secret Role B');
  });
});

describe('CE-11: CSV import', () => {
  const upload = (token, orgId, csv) => request(server).post('/api/v1/contacts/bulk-upload').set(auth(token))
    .field('organization_id', String(orgId)).attach('file', Buffer.from(csv, 'utf8'), 'contacts.csv');
  const countOrg = async (orgId) => (await query(
    `SELECT COUNT(*)::int n FROM emergency_contacts WHERE organization_id=$1 AND deleted_at IS NULL`, [orgId])).rows[0].n;

  const DOC = 'first_name,last_name,mobile_number,extension_number,email,role\n'
            + 'Imp,One,+966 50 111 0001,,imp1@a.test,Guard\n'
            + 'Imp,Two,,3002,,\n'
            + 'Imp,Bad,,,,\n';

  it('the documented columns import; failing rows report "line N" with a readable message', async () => {
    const before = await countOrg(orgA1);
    const res = await upload(adminA, orgA1, DOC);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inserted: 2, total: 3, skipped: 0 });
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].line).toBe(4);
    expect(typeof res.body.errors[0].error).toBe('string');
    expect(res.body.errors[0].error).toBe('Both mobile number and extension number are empty');
    expect(res.body.errors[0].error).not.toMatch(/^\[/);           // not a raw JSON dump
    expect(await countOrg(orgA1)).toBe(before + 2);
  });

  it('re-importing the same file inserts nothing (duplicates reported)', async () => {
    const before = await countOrg(orgA1);
    const res = await upload(adminA, orgA1, DOC);
    expect(res.body).toMatchObject({ inserted: 0, skipped: 2, total: 3 });
    expect(res.body.duplicates.map(d => d.line)).toEqual([2, 3]);
    expect(await countOrg(orgA1)).toBe(before);
  });

  it('a known number (any punctuation) updates its contact with the latest values; a repeat in the file updates the contact it created', async () => {
    const csv = 'first_name,last_name,mobile_number,extension_number\n'
              + '  imp , ONE ,+96650-111-0001,\n'           // the mobile of Imp One
              + 'Imp,Three,0500 3,\n'
              + 'imp,three,05003,\n'                         // the same number as the line above
              + 'imp,three,05003,\n';                        // identical repeat: nothing left to change
    const res = await upload(adminA, orgA1, csv);
    expect(res.body).toMatchObject({ inserted: 1, created: 1, updated: 2, unchanged: 1, skipped: 1, duplicates_prevented: 3 });
    expect(res.body.updates.map(d => d.line)).toEqual([2, 4]);
    expect(res.body.duplicates.map(d => d.line)).toEqual([5]);
    const { rows } = await query(`SELECT first_name, last_name FROM emergency_contacts WHERE organization_id=$1 AND mobile_norm=ANY($2)`,
      [orgA1, ['+966501110001', '05003']]);
    expect(rows.map(r => `${r.first_name} ${r.last_name}`).sort()).toEqual(['imp ONE', 'imp three']);
  });

  it('a number held in another organization is refused (nothing created, no contact moved)', async () => {
    const res = await upload(adminA, orgA2, 'first_name,last_name,mobile_number\nImp,One,+966501110001\n');
    expect(res.body).toMatchObject({ inserted: 0, conflicts: 1 });
    expect(res.body.errors).toEqual([{ line: 2, error: 'This mobile number is already assigned to a contact in another organization' }]);
  });

  it('accepts the legacy "phone" header, a UTF-8 BOM and is_active words', async () => {
    const csv = '﻿first_name,last_name,phone,email,pin,is_active\nLeg,Acy,0509999,,1234,no\n';
    const res = await upload(adminA, orgA1, csv);
    expect(res.body).toMatchObject({ inserted: 1, errors: [] });
    const { rows: [r] } = await query(`SELECT mobile_number, is_active FROM emergency_contacts WHERE organization_id=$1 AND last_name='Acy'`, [orgA1]);
    expect(r).toEqual({ mobile_number: '0509999', is_active: false });
  });

  it('upload into another tenant\'s organization is refused; OPERATOR may not upload', async () => {
    expect((await upload(adminA, orgB, DOC)).status).toBe(404);
    expect((await upload(operatorA, orgA1, DOC)).status).toBe(403);
  });
});

describe('CE-12: search, filters, sort and paging together', () => {
  it('combined query: consistent totals, disjoint pages, export in the same order', async () => {
    const q = { organization_id: orgA1, is_active: 'true', search: 'imp', sort: 'name', dir: 'desc', limit: 2 };
    const p1 = await list(adminA, { ...q, page: 1 });
    const p2 = await list(adminA, { ...q, page: 2 });
    const all = await list(adminA, { ...q, limit: 200 });
    expect(p1.status).toBe(200);
    expect(p1.body.total).toBe(all.body.total);
    expect(all.body.total).toBeGreaterThanOrEqual(3);                 // CE-11 imports into orgA1
    expect([...ids(p1), ...ids(p2)]).toEqual(ids(all).slice(0, 4));
    expect(all.body.contacts.every(r => r.organization_id === orgA1 && r.is_active)).toBe(true);
    const names = all.body.contacts.map(r => r.last_name);
    expect(names).toEqual([...names].sort().reverse());
    const csv = await request(server).get('/api/v1/contacts/export').query(q).set(auth(adminA))
      .buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', x => { d += x; }); res.on('end', () => cb(null, d)); });
    expect(parse(csv.body, { columns: true, bom: true }).map(r => r.last_name)).toEqual(names);
  });

  it('a page past the end is empty with the real total', async () => {
    const res = await list(adminA, { organization_id: orgA1, limit: 200, page: 99 });
    expect(res.body.contacts).toEqual([]);
    expect(res.body.total).toBeGreaterThan(0);
  });
});

describe('CE-13: individual delete and CSV edge cases', () => {
  it('single delete of another tenant\'s contact is 404 and leaves it live', async () => {
    const res = await request(server).delete(`/api/v1/contacts/${c.bz2}`).set(auth(adminA));
    expect(res.status).toBe(404);
    expect(await live(c.bz2)).toBe(true);
    const own = await makeContact('del1', { org: orgA1, first: 'Single', last: 'Delete', mobile: '9' });
    expect((await request(server).delete(`/api/v1/contacts/${own}`).set(auth(adminA))).status).toBe(204);
    expect(await live(own)).toBe(false);
  });

  it('an unreadable CSV is a 400 with a message; a header-only file inserts nothing', async () => {
    const up = (csv) => request(server).post('/api/v1/contacts/bulk-upload').set(auth(adminA))
      .field('organization_id', String(orgA1)).attach('file', Buffer.from(csv, 'utf8'), 'x.csv');
    const bad = await up('first_name,last_name\n"unterminated,quote\n');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/could not be read/);
    const empty = await up('first_name,last_name,mobile_number\n');
    expect(empty.body).toMatchObject({ inserted: 0, total: 0, errors: [], duplicates: [] });
  });

  it('invalid rows give one readable message per row (email, lengths)', async () => {
    const csv = 'first_name,last_name,mobile_number,email\n'
              + `Ok,Row,0599,\nBad,Mail,0598,not-an-email\n${'x'.repeat(65)},Long,0597,\n`;
    const res = await request(server).post('/api/v1/contacts/bulk-upload').set(auth(adminA))
      .field('organization_id', String(orgA2)).attach('file', Buffer.from(csv, 'utf8'), 'x.csv');
    expect(res.body.inserted).toBe(1);
    expect(res.body.errors.map(e => e.line)).toEqual([3, 4]);
    expect(res.body.errors[0].error).toBe('Email is not a valid email address');
    expect(res.body.errors[1].error).toBe('First name is longer than 64 characters');
  });
});

// ── Final audit: SUPER_ADMIN governance, concurrency, export injection, scale ──────────

const csvText = (req) => req.buffer(true).parse((res, cb) => {
  let d = ''; res.setEncoding('utf8'); res.on('data', x => { d += x; }); res.on('end', () => cb(null, d));
});
const getCsv = (token, q = {}) => csvText(request(server).get('/api/v1/contacts/export').query(q).set(auth(token)));
const uploadAs = (token, orgId, csv, tenantField) => {
  const r = request(server).post('/api/v1/contacts/bulk-upload').set(auth(token)).field('organization_id', String(orgId));
  if (tenantField !== undefined) r.field('tenant_id', String(tenantField));
  return r.attach('file', Buffer.from(csv, 'utf8'), 'contacts.csv');
};
async function makeOrg(name, tenantId) {
  const { rows: [o] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ($1,$2) RETURNING id`, [name, tenantId]);
  extraOrgs.push(o.id);
  return o.id;
}
const countLive = async (orgId) => (await query(
  `SELECT COUNT(*)::int n FROM emergency_contacts WHERE organization_id=$1 AND deleted_at IS NULL`, [orgId])).rows[0].n;

describe('CE-14: SUPER_ADMIN full access (governance rule)', () => {
  it('All Tenants: search, filter, sort and page across tenants; roles of every tenant', async () => {
    const b = await list(superAdmin, { organization_id: orgB });
    expect(b.status).toBe(200);
    expect(b.body.contacts.every(r => r.tenant_id === tenantB && r.tenant_name === `CE-B-${TS}`)).toBe(true);
    expect(ids(await list(superAdmin, { department_id: deptB }))).toEqual([c.bz1]);
    const paged = await list(superAdmin, { search: 'Foreign', sort: 'name', dir: 'desc', limit: 1, page: 2 });
    expect(paged.body.total).toBe(2);
    expect(ids(paged)).toEqual([c.bz1]);                              // Ben, then Bea
    const mixed = await list(superAdmin, { search: 'e', role: 'medic' });
    expect(ids(mixed)).toEqual([c.dee]);
    const roles = (await request(server).get('/api/v1/contacts/roles').set(auth(superAdmin))).body.roles;
    expect(roles).toEqual(expect.arrayContaining(['Medic', 'Secret Role B']));
  });

  it('All Tenants: creates in any tenant through its organization; integrity checks still apply', async () => {
    const ok = await request(server).post('/api/v1/contacts').set(auth(superAdmin))
      .send({ organization_id: orgB, first_name: 'SA', last_name: 'Created', mobile_number: '0511' });
    expect(ok.status).toBe(201);
    expect(ok.body.organization_id).toBe(orgB);
    const badDept = await request(server).post('/api/v1/contacts').set(auth(superAdmin))
      .send({ organization_id: orgB, department_id: deptA1, first_name: 'SA', last_name: 'X', mobile_number: '1' });
    expect(badDept.status).toBe(400);
    const unknownOrg = await request(server).post('/api/v1/contacts').set(auth(superAdmin))
      .send({ organization_id: 2147483000, first_name: 'SA', last_name: 'X', mobile_number: '1' });
    expect(unknownOrg.status).toBe(404);
    expect((await list(superAdmin, { tenant_id: 'abc' })).status).toBe(400);
  });

  it('All Tenants: edits, deletes and bulk-deletes contacts of any tenant; no cross-tenant move', async () => {
    expect((await request(server).put(`/api/v1/contacts/${c.bz1}`).set(auth(superAdmin)).send({ email: 'sa@b.test' })).status).toBe(200);
    expect((await request(server).put(`/api/v1/contacts/${c.bz1}`).set(auth(superAdmin)).send({ organization_id: orgA1, department_id: null, location_id: null })).status).toBe(400);
    const s1 = await makeContact('s1', { org: orgB, first: 'SA', last: 'Single', mobile: '7' });
    expect((await request(server).delete(`/api/v1/contacts/${s1}`).set(auth(superAdmin))).status).toBe(204);
    const a = await makeContact('sa_a', { org: orgA1, first: 'SA', last: 'BulkA', mobile: '8' });
    const b = await makeContact('sa_b', { org: orgB, first: 'SA', last: 'BulkB', mobile: '9' });
    const res = await request(server).post('/api/v1/contacts/bulk-delete').set(auth(superAdmin)).send({ ids: [a, b, a] });
    expect(res.body).toMatchObject({ deleted: 2, not_found: [] });
    expect([await live(a), await live(b)]).toEqual([false, false]);
  });

  it('a selected tenant: full access inside it; other tenants are out of scope and untouched', async () => {
    const inA = await list(superAdmin, { tenant_id: tenantA, limit: 200 });
    expect(inA.body.contacts.every(r => r.tenant_id === tenantA)).toBe(true);
    const created = await request(server).post('/api/v1/contacts').set(auth(superAdmin))
      .send({ tenant_id: tenantA, organization_id: orgA1, first_name: 'Sel', last_name: 'Tenant', mobile_number: '0522' });
    expect(created.status).toBe(201);
    expect((await request(server).put(`/api/v1/contacts/${created.body.id}`).set(auth(superAdmin)).send({ tenant_id: tenantA, role: 'Sel' })).status).toBe(200);
    expect((await request(server).post('/api/v1/contacts').set(auth(superAdmin))
      .send({ tenant_id: tenantA, organization_id: orgB, first_name: 'Sel', last_name: 'X', mobile_number: '1' })).status).toBe(404);
    expect((await request(server).put(`/api/v1/contacts/${c.bz1}`).set(auth(superAdmin)).send({ tenant_id: tenantA, role: 'nope' })).status).toBe(404);
    expect((await request(server).delete(`/api/v1/contacts/${c.bz1}`).query({ tenant_id: tenantA }).set(auth(superAdmin))).status).toBe(404);
    const bulk = await request(server).post('/api/v1/contacts/bulk-delete').set(auth(superAdmin))
      .send({ tenant_id: tenantA, ids: [c.bz1, created.body.id] });
    expect(bulk.body).toMatchObject({ deleted: 1, deleted_ids: [created.body.id], not_found: [c.bz1] });
    expect(await live(c.bz1)).toBe(true);
    const exp = parse((await getCsv(superAdmin, { tenant_id: tenantA })).body, { columns: true, bom: true });
    expect(exp.some(r => r.last_name === 'Foreign')).toBe(false);
    const roles = (await request(server).get('/api/v1/contacts/roles').query({ tenant_id: tenantA }).set(auth(superAdmin))).body.roles;
    expect(roles).not.toContain('Secret Role B');
  });

  it('CSV import: All Tenants into any tenant\'s organization; a selected tenant restricts the target', async () => {
    expect((await uploadAs(superAdmin, orgB, 'first_name,last_name,mobile_number\nSA,ImportB,0533\n')).body.inserted).toBe(1);
    expect((await uploadAs(superAdmin, orgB, 'first_name,last_name,mobile_number\nSA,Blocked,0534\n', tenantA)).status).toBe(404);
    expect((await uploadAs(superAdmin, orgA1, 'first_name,last_name,mobile_number\nSA,ImportA,0535\n', tenantA)).body.inserted).toBe(1);
    expect((await uploadAs(superAdmin, orgA1, 'first_name,last_name,mobile_number\nSA,Bad,0536\n', 'abc')).status).toBe(400);
  });

  it('lower roles keep their restrictions', async () => {
    expect((await list(supervisorA)).status).toBe(403);
    expect((await request(server).post('/api/v1/contacts/bulk-delete').set(auth(supervisorA)).send({ ids: [c.gus] })).status).toBe(403);
    expect((await uploadAs(supervisorA, orgA1, 'first_name,last_name,mobile_number\nX,Y,1\n')).status).toBe(403);
    expect((await request(server).post('/api/v1/contacts').set(auth(operatorA)).send({ organization_id: orgA1, first_name: 'O', last_name: 'P', mobile_number: '1' })).status).toBe(403);
    expect((await request(server).put(`/api/v1/contacts/${c.gus}`).set(auth(operatorA)).send({ role: 'x' })).status).toBe(403);
    expect((await request(server).delete(`/api/v1/contacts/${c.gus}`).set(auth(operatorA))).status).toBe(403);
    const byB = await request(server).post('/api/v1/contacts/bulk-delete').set(auth(adminB)).send({ ids: [c.gus], tenant_id: tenantA });
    expect(byB.body).toMatchObject({ deleted: 0, not_found: [c.gus] });
    expect(await live(c.gus)).toBe(true);
  });
});

describe('CE-15: CSV import concurrency (platform-wide contact identity lock)', () => {
  const rowsCsv = (prefix, n, base = '05') => 'first_name,last_name,mobile_number\n'
    + Array.from({ length: n }, (_, i) => `${prefix},Person${i},${base}${String(i).padStart(6, '0')}`).join('\n') + '\n';

  it('two simultaneous imports of the same file into one organization insert each person once', async () => {
    const org = await makeOrg('CE Conc Same', tenantA);
    const csv = rowsCsv('Same', 20);
    const [r1, r2] = await Promise.all([uploadAs(adminA, org, csv), uploadAs(adminA, org, csv)]);
    expect(r1.body.inserted + r2.body.inserted).toBe(20);
    expect(r1.body.skipped + r2.body.skipped).toBe(20);
    expect(await countLive(org)).toBe(20);
  });

  it('simultaneous imports of different numbers into different organizations both complete', async () => {
    const o1 = await makeOrg('CE Conc One', tenantA);
    const o2 = await makeOrg('CE Conc Two', tenantA);
    const [r1, r2] = await Promise.all([uploadAs(adminA, o1, rowsCsv('Diff', 15, '06')), uploadAs(adminA, o2, rowsCsv('Diff', 15, '07'))]);
    expect([r1.body.inserted, r2.body.inserted]).toEqual([15, 15]);
    expect([await countLive(o1), await countLive(o2)]).toEqual([15, 15]);
  });

  it('simultaneous imports of the same numbers into two organizations: one owns them, the other is refused', async () => {
    const o1 = await makeOrg('CE Conc Race One', tenantA);
    const o2 = await makeOrg('CE Conc Race Two', tenantA);
    const csv = rowsCsv('Race', 10, '04');
    const [r1, r2] = await Promise.all([uploadAs(adminA, o1, csv), uploadAs(adminA, o2, csv)]);
    expect([r1.body.inserted, r2.body.inserted].sort()).toEqual([0, 10]);
    expect([r1.body.conflicts, r2.body.conflicts].sort()).toEqual([0, 10]);
    expect((await countLive(o1)) + (await countLive(o2))).toBe(10);
  });

  it('imports and individual creates wait for the identity lock; the same person ends up once', async () => {
    const org = await makeOrg('CE Conc Lock', tenantA);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('enrs:contact-identity'))`);  // a writer "in progress"
      const imp = uploadAs(adminA, org, 'first_name,last_name,mobile_number\nLock,Person,0555\n').then(r => r);
      const manual = request(server).post('/api/v1/contacts').set(auth(adminA))
        .send({ organization_id: org, first_name: 'Lock', last_name: 'Person', mobile_number: '0555' }).then(r => r);
      const state = await Promise.race([Promise.any([imp, manual]).then(() => 'finished'), new Promise(r => setTimeout(() => r('waiting'), 800))]);
      expect(state).toBe('waiting');
      await client.query('COMMIT');
      const [ri, rm] = await Promise.all([imp, manual]);
      expect(ri.status).toBe(200);
      expect([200, 201]).toContain(rm.status);         // 201 if it ran first; 200 (upserted) if the import did
      expect(ri.body.inserted + (rm.status === 201 ? 1 : 0)).toBe(1);             // exactly one creation
      expect(await countLive(org)).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

describe('CE-16: export formula injection, phone numbers, Unicode and re-import', () => {
  let orgX;
  beforeAll(async () => {
    orgX = await makeOrg('CE Export X', tenantA);
    const rows = [
      ['Formula', 'Equals',  '=1+1',       '+966 50 123 4567', null],
      ['Formula', 'Plus',    '+SUM(A1)',   '+1 (555) 010-0000', null],
      ['Formula', 'Minus',   '-2+3',       null, '100'],
      ['Formula', 'At',      '@cmd',       null, '101'],
      ['Formula', 'Tab',     '\tTabbed',   null, '102'],
      ['Formula', 'CR',      '\rReturn',   null, '103'],
      ['Formula', 'Newline', 'a\r\nb',     null, '104'],
      ['محمد', 'Émile \u{1F600}', null, '+971501234567', null],
      ['Quote',   'He said "hi", ok', '', null, '105'],
    ];
    for (const [first, last, role, mobile, ext] of rows) {
      await makeContact(`x_${last}`, { org: orgX, first, last, role, mobile, ext });
    }
  });
  const UNICODE_LAST = 'Émile \u{1F600}';

  it('neutralises formula starts, keeps phone numbers, quotes commas / quotes / line breaks, keeps Unicode', async () => {
    const res = await getCsv(adminA, { organization_id: orgX });
    const text = res.body;
    expect(text.startsWith('﻿first_name,last_name,mobile_number,extension_number,email,role,')).toBe(true);
    expect(text.split('\r\n').length).toBeGreaterThan(9);                            // CRLF records
    const rows = parse(text, { columns: true, bom: true });
    const by = Object.fromEntries(rows.map(r => [r.last_name, r]));
    expect(by.Equals.role).toBe("'=1+1");
    expect(by.Plus.role).toBe("'+SUM(A1)");
    expect(by.Minus.role).toBe("'-2+3");
    expect(by.At.role).toBe("'@cmd");
    expect(by.Tab.role).toBe("'\tTabbed");
    expect(by.CR.role).toBe("'\rReturn");
    expect(by.Newline.role).toBe('a\r\nb');                                        // quoted, not neutralised
    expect(by.Equals.mobile_number).toBe('+966 50 123 4567');
    expect(by.Plus.mobile_number).toBe('+1 (555) 010-0000');
    expect(by[UNICODE_LAST].first_name).toBe('محمد');
    expect(by[UNICODE_LAST].email).toBe('');
    expect(by['He said "hi", ok'].extension_number).toBe('105');
    expect(text).toContain('"He said ""hi"", ok"');
  });

  it('re-importing the export into the same organization changes nothing; into another organization every row is refused (numbers are platform-wide)', async () => {
    const text = (await getCsv(adminA, { organization_id: orgX })).body;
    // The export has an organization column, so each row goes to the organization it names.
    // Known, documented effect (BEHAVIOUR_COMPATIBILITY_REPORT.md): the export's protective quote on
    // formula-like roles is stored by import (unchanged behaviour), so the first same-organization
    // re-import updates those six roles once; after that a re-import changes nothing.
    const same = await uploadAs(adminA, orgX, text);
    expect(same.body).toMatchObject({ inserted: 0, created: 0, updated: 6, unchanged: 3, conflicts: 0, errors: [] });
    const again = await uploadAs(adminA, orgX, (await getCsv(adminA, { organization_id: orgX })).body);
    expect(again.body).toMatchObject({ inserted: 0, updated: 0, unchanged: 9, errors: [] });
    expect(await query(`SELECT count(*)::int AS n FROM emergency_contacts WHERE organization_id=$1 AND deleted_at IS NULL`, [orgX]))
      .toMatchObject({ rows: [{ n: 9 }] });                                        // no second contact for anyone
    const orgY = await makeOrg('CE Export Y', tenantA);
    const other = await uploadAs(adminA, orgY, text.replaceAll('CE Export X', 'CE Export Y'));
    expect(other.body).toMatchObject({ inserted: 0, updated: 0, conflicts: 9 });
    expect(other.body.errors.every(e => /another organization/.test(e.error))).toBe(true);
    expect(JSON.stringify(other.body)).not.toContain('CE Export X');               // the owner is not disclosed
    const { rows } = await query(`SELECT count(*)::int AS n FROM emergency_contacts WHERE organization_id=$1`, [orgY]);
    expect(rows[0].n).toBe(0);
    const { rows: kept } = await query(`SELECT role FROM emergency_contacts WHERE organization_id=$1 AND last_name='Equals'`, [orgX]);
    expect(kept[0].role).toBe("'=1+1");                                             // the protective quote is kept
  });
});

describe('CE-17: large directory (5,000 contacts)', () => {
  let orgL;
  beforeAll(async () => {
    orgL = await makeOrg('CE Large', tenantA);
    await query(
      `INSERT INTO emergency_contacts (organization_id, first_name, last_name, mobile_number)
       SELECT $1, 'Bulk', 'Person ' || lpad(g::text, 4, '0'), '08' || lpad(g::text, 8, '0')
       FROM generate_series(1, 5000) g`, [orgL]);
  });

  it('every contact is reachable by paging, pages are disjoint, totals are exact', async () => {
    const seen = new Set();
    for (let p = 1; p <= 25; p++) {
      const r = await list(adminA, { organization_id: orgL, limit: 200, page: p });
      expect(r.body.total).toBe(5000);
      r.body.contacts.forEach(x => seen.add(x.id));
      if (p === 25) expect(r.body.contacts.at(-1).last_name).toBe('Person 5000');
    }
    expect(seen.size).toBe(5000);
    expect((await list(adminA, { organization_id: orgL, limit: 200, page: 26 })).body.contacts).toEqual([]);
  });

  it('search, filter, sort and the picker default work at this size', async () => {
    expect(ids(await list(adminA, { organization_id: orgL, search: 'Person 4321' }))).toHaveLength(1);
    expect((await list(adminA, { organization_id: orgL, search: '%' })).body.total).toBe(0);
    expect((await list(adminA, { organization_id: orgL, is_active: 'false' })).body.total).toBe(0);
    const desc = await list(adminA, { organization_id: orgL, sort: 'mobile', dir: 'desc', limit: 1 });
    expect(desc.body.contacts[0].last_name).toBe('Person 5000');
    const picker = await list(adminA, { organization_id: orgL, limit: 1000 });
    expect(picker.body.contacts).toHaveLength(200);                                 // D4 unchanged
  });

  it('export returns all 5,000 matching rows', async () => {
    const t0 = Date.now();
    const rows = parse((await getCsv(adminA, { organization_id: orgL })).body, { columns: true, bom: true });
    expect(rows).toHaveLength(5000);
    console.log(`[CE-17] export of 5000 contacts took ${Date.now() - t0} ms`);
  });
});

describe('CE-18: audit trail of contact administration', () => {
  const userId = async (email) => (await query(`SELECT id FROM users WHERE email=$1`, [email])).rows[0].id;
  const lastAuditId = async () => (await query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM audit_logs`)).rows[0].id;
  const auditsSince = async (since, action) => (await query(
    `SELECT user_id, action, entity_type, entity_id, details, created_at FROM audit_logs
     WHERE id > $1 AND entity_type = 'emergency_contact' AND ($2::text IS NULL OR action = $2) ORDER BY id`,
    [since, action ?? null])).rows;
  // Personal data that must never appear in an audit record.
  const PII = ['Audit', 'Person', '0599123456', 'audit.person@a.test', 'Bea', 'Foreign', '+15550000001', 'Imported', '0577'];
  const noPii = (rows) => { const text = JSON.stringify(rows); for (const s of PII) expect(text, s).not.toContain(s); };

  let adminAId, superId, created;

  beforeAll(async () => {
    adminAId = await userId(`ce-admin-a-${TS}@test.local`);
    superId  = await userId(`ce-super-${TS}@test.local`);
  });

  it('tenant ADMIN: create, update and delete are each recorded with user, role, tenant and ids only', async () => {
    const since = await lastAuditId();
    const res = await request(server).post('/api/v1/contacts').set(auth(adminA)).send({
      organization_id: orgA1, first_name: 'Audit', last_name: 'Person', mobile_number: '0599123456', email: 'audit.person@a.test',
    });
    expect(res.status).toBe(201);
    created = res.body.id;
    expect((await request(server).put(`/api/v1/contacts/${created}`).set(auth(adminA))
      .send({ organization_id: orgA2, department_id: deptA2, role: 'Auditor' })).status).toBe(200);
    expect((await request(server).delete(`/api/v1/contacts/${created}`).set(auth(adminA))).status).toBe(204);

    const rows = await auditsSince(since);
    expect(rows.map(r => r.action)).toEqual(['contact_created', 'contact_updated', 'contact_deleted']);
    for (const r of rows) {
      expect(r.user_id).toBe(adminAId);
      expect(r.entity_id).toBe(String(created));
      expect(r.details).toMatchObject({ role: 'ADMIN', tenant_id: tenantA, scope_tenant_id: tenantA });
      expect(r.created_at).toBeInstanceOf(Date);
    }
    expect(rows[0].details).toMatchObject({ organization_id: orgA1 });
    expect(rows[1].details).toMatchObject({ organization_id: orgA2, previous_organization_id: orgA1 });
    expect(rows[1].details.changed_fields.sort()).toEqual(['department_id', 'organization_id', 'role']);
    expect(rows[2].details).toMatchObject({ organization_id: orgA2 });
    noPii(rows);
  });

  it('refused operations leave no audit record', async () => {
    const since = await lastAuditId();
    expect((await request(server).put(`/api/v1/contacts/${c.bz1}`).set(auth(adminA)).send({ role: 'x' })).status).toBe(404);
    expect((await request(server).delete(`/api/v1/contacts/${c.bz1}`).set(auth(adminA))).status).toBe(404);
    expect((await request(server).post('/api/v1/contacts').set(auth(adminA))
      .send({ organization_id: orgB, first_name: 'X', last_name: 'Y', mobile_number: '1' })).status).toBe(404);
    expect((await request(server).post('/api/v1/contacts').set(auth(operatorA))
      .send({ organization_id: orgA1, first_name: 'X', last_name: 'Y', mobile_number: '1' })).status).toBe(403);
    expect(await auditsSince(since)).toEqual([]);
  });

  it('SUPER_ADMIN under All Tenants: the record carries the contact\'s tenant and a null scope', async () => {
    const since = await lastAuditId();
    expect((await request(server).put(`/api/v1/contacts/${c.bz1}`).set(auth(superAdmin)).send({ role: 'Audited by SA' })).status).toBe(200);
    const [r] = await auditsSince(since);
    expect(r).toMatchObject({ user_id: superId, action: 'contact_updated', entity_id: String(c.bz1) });
    expect(r.details).toMatchObject({ role: 'SUPER_ADMIN', tenant_id: tenantB, scope_tenant_id: null, changed_fields: ['role'] });
    noPii([r]);
  });

  it('bulk delete across tenants: one summary per affected tenant with ids and counts', async () => {
    const a = await makeContact('au_a', { org: orgA1, first: 'Gone', last: 'A', mobile: '9911' });
    const b = await makeContact('au_b', { org: orgB, first: 'Gone', last: 'B', mobile: '9912' });
    const since = await lastAuditId();
    const res = await request(server).post('/api/v1/contacts/bulk-delete').set(auth(superAdmin)).send({ ids: [b, a, 2147483001] });
    expect(res.body.deleted).toBe(2);
    const rows = await auditsSince(since, 'contacts_bulk_deleted');
    expect(rows).toHaveLength(2);
    const byTenant = Object.fromEntries(rows.map(r => [r.details.tenant_id, r.details]));
    expect(byTenant[tenantA]).toMatchObject({ role: 'SUPER_ADMIN', scope_tenant_id: null, requested: 3, deleted: 1, deleted_ids: [a], not_found_count: 1 });
    expect(byTenant[tenantB]).toMatchObject({ deleted: 1, deleted_ids: [b] });
    expect(rows.every(r => r.entity_id === null && r.user_id === superId)).toBe(true);
  });

  it('bulk delete with a tenant selected or by a tenant ADMIN never records other tenants\' contacts as deleted', async () => {
    const a = await makeContact('au_a2', { org: orgA1, first: 'Gone', last: 'A2', mobile: '9913' });
    let since = await lastAuditId();
    await request(server).post('/api/v1/contacts/bulk-delete').set(auth(superAdmin)).send({ tenant_id: tenantA, ids: [a, c.bz1] });
    let rows = await auditsSince(since, 'contacts_bulk_deleted');
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ tenant_id: tenantA, scope_tenant_id: tenantA, deleted: 1, deleted_ids: [a], not_found_count: 1 });

    since = await lastAuditId();
    await request(server).post('/api/v1/contacts/bulk-delete').set(auth(adminA)).send({ ids: [c.bz1] });
    rows = await auditsSince(since, 'contacts_bulk_deleted');
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ role: 'ADMIN', tenant_id: tenantA, deleted: 0, deleted_ids: [], not_found_count: 1 });
    expect(await live(c.bz1)).toBe(true);
  });

  it('CSV import: one summary with counts only (no file contents)', async () => {
    const since = await lastAuditId();
    const csv = 'first_name,last_name,mobile_number\nImported,One,0577000001\nImported,One,0577000001\nImported,,0577000002\n';
    const res = await uploadAs(superAdmin, orgA2, csv, tenantA);
    expect(res.body).toMatchObject({ inserted: 1, skipped: 1 });
    const rows = await auditsSince(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: superId, action: 'contacts_imported', entity_id: null });
    expect(rows[0].details).toEqual({
      role: 'SUPER_ADMIN', scope_tenant_id: tenantA, tenant_id: tenantA, organization_id: orgA2, format: 'csv',
      total_rows: 3, inserted: 1, updated: 0, skipped_duplicates: 1, error_rows: 1, conflicts: 0, file_rows: 3,
    });
    noPii(rows);
  });

  it('the audit log stays a SUPER_ADMIN-only view, filterable by the contact\'s tenant', async () => {
    expect((await request(server).get('/api/v1/audit').set(auth(adminA))).status).toBe(403);
    const res = await request(server).get('/api/v1/audit')
      .query({ entity_type: 'emergency_contact', audit_tenant_id: tenantB, limit: 200 }).set(auth(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.entries.every(e => e.details.tenant_id === tenantB)).toBe(true);
  });
});
