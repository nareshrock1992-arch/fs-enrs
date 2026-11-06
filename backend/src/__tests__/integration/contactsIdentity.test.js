/**
 * Contact identity: one extension / one mobile number = one contact, platform-wide.
 * (docs/enterprise/CONTACT_UPSERT_DESIGN.md)
 *
 *  CI-1  Add Contact: new → 201; same organization → the existing contact is updated (200, upserted)
 *  CI-2  latest values: supplied fields win, omitted fields are kept, explicit empty clears
 *  CI-3  normalisation: whitespace, punctuation, case, 00 → +; local ≠ international; NULL / empty never collide
 *  CI-4  another organization / another tenant → 409, nothing written, nothing disclosed
 *  CI-5  extension of one contact + mobile of another → 409, never merged
 *  CI-6  Edit: an identifier of another contact is refused; the contact's own identifiers are fine
 *  CI-7  identity-check endpoint (frontend feedback; tenant-scoped; ADMIN only)
 *  CI-8  concurrency: simultaneous creates of one person → exactly one contact
 *  CI-9  database backstop: unique indexes, soft-deleted contacts, SQL ↔ JS normalisation parity
 *  CI-10 audit events (counts / field names / ids only — no numbers)
 *  CI-11 ERS broadcast-users API: same rules; legacy last-9-digit match kept within the organization
 *  CI-12 recipient safeguard: ERS ring-all and the ENS / ERS Lua lookups call each number once
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-32chars-padding!';

import server from '../../../server.js';
import { query } from '../../db/pool.js';
import { normalizeExtension, normalizeMobile } from '../../services/contactIdentity.js';
import { __test as ring } from '../../services/ersRingService.js';

const TS = Date.now();
const SFX = String(TS).slice(-6);                 // keeps numbers unique per run
const num = (p) => `${p}${SFX}`;
let tenantA, tenantB, orgA1, orgA2, orgB, deptA1;
let adminA = '', adminB = '', operatorA = '', superAdmin = '';
const userIds = [];
const extraConfigs = { ers: [], ens: [], numbers: [], groups: [] };

async function makeUser(email, role, tenantId) {
  const hash = await bcrypt.hash('Test1234!', 4);
  const { rows: [u] } = await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, is_active, full_name)
     VALUES ($1,$2,$3,$4,true,'Identity Test') RETURNING id`, [email, hash, role, tenantId]);
  userIds.push(u.id);
  const res = await request(server).post('/api/v1/auth/login').send({ email, password: 'Test1234!' });
  return res.body.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const create = (token, body) => request(server).post('/api/v1/contacts').set(auth(token)).send(body);
const edit = (token, id, body) => request(server).put(`/api/v1/contacts/${id}`).set(auth(token)).send(body);
const check = (token, q) => request(server).get('/api/v1/contacts/identity-check').query(q).set(auth(token));
const row = async (id) => (await query(`SELECT * FROM emergency_contacts WHERE id=$1`, [id])).rows[0];
const liveCount = async (where, params) =>
  (await query(`SELECT count(*)::int AS n FROM emergency_contacts WHERE deleted_at IS NULL AND ${where}`, params)).rows[0].n;
const lastAuditId = async () => (await query(`SELECT COALESCE(MAX(id),0)::int AS id FROM audit_logs`)).rows[0].id;
const auditsSince = async (id, action) => (await query(
  `SELECT user_id, action, entity_id, details FROM audit_logs WHERE id > $1 AND entity_type='emergency_contact'
   ${action ? 'AND action = $2' : ''} ORDER BY id`, action ? [id, action] : [id])).rows;
async function insertContact(f) {
  const { rows: [r] } = await query(
    `INSERT INTO emergency_contacts (organization_id, first_name, last_name, mobile_number, extension_number, email, role)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [f.org, f.first ?? 'Seed', f.last ?? 'Person', f.mobile ?? null, f.ext ?? null, f.email ?? null, f.role ?? null]);
  return r.id;
}

beforeAll(async () => {
  ({ rows: [{ id: tenantA }] } = await query(`INSERT INTO tenants (name, code) VALUES ($1,$2) RETURNING id`, [`CI-A-${TS}`, `ci-a-${TS}`]));
  ({ rows: [{ id: tenantB }] } = await query(`INSERT INTO tenants (name, code) VALUES ($1,$2) RETURNING id`, [`CI-B-${TS}`, `ci-b-${TS}`]));
  ({ rows: [{ id: orgA1 }] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ('CI Org A1',$1) RETURNING id`, [tenantA]));
  ({ rows: [{ id: orgA2 }] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ('CI Org A2',$1) RETURNING id`, [tenantA]));
  ({ rows: [{ id: orgB }] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ('CI Secret Org B',$1) RETURNING id`, [tenantB]));
  ({ rows: [{ id: deptA1 }] } = await query(`INSERT INTO departments (organization_id, name) VALUES ($1,'CI Dept') RETURNING id`, [orgA1]));
  adminA = await makeUser(`ci-admin-a-${TS}@test.local`, 'ADMIN', tenantA);
  adminB = await makeUser(`ci-admin-b-${TS}@test.local`, 'ADMIN', tenantB);
  operatorA = await makeUser(`ci-op-a-${TS}@test.local`, 'OPERATOR', tenantA);
  superAdmin = await makeUser(`ci-super-${TS}@test.local`, 'SUPER_ADMIN', null);
});

afterAll(async () => {
  const orgs = [orgA1, orgA2, orgB].filter(Boolean);
  if (extraConfigs.numbers.length) await query(`DELETE FROM emergency_numbers WHERE id = ANY($1::int[])`, [extraConfigs.numbers]);
  if (extraConfigs.ers.length) await query(`DELETE FROM ers_configurations WHERE id = ANY($1::int[])`, [extraConfigs.ers]);
  if (extraConfigs.ens.length) await query(`DELETE FROM ens_configurations WHERE id = ANY($1::int[])`, [extraConfigs.ens]);
  await query(`DELETE FROM responder_group_members WHERE responder_group_id IN (SELECT id FROM responder_groups WHERE organization_id = ANY($1::int[]))`, [orgs]);
  await query(`DELETE FROM responder_groups WHERE organization_id = ANY($1::int[])`, [orgs]);
  await query(`DELETE FROM emergency_contacts WHERE organization_id = ANY($1::int[])`, [orgs]);
  await query(`DELETE FROM departments WHERE organization_id = ANY($1::int[])`, [orgs]);
  await query(`DELETE FROM organizations WHERE id = ANY($1::int[])`, [orgs]);
  if (userIds.length) await query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  await query(`DELETE FROM tenants WHERE id = ANY($1::int[])`, [[tenantA, tenantB].filter(Boolean)]);
});

describe('CI-1: Add Contact creates once, then updates the same organization\'s contact', () => {
  it('scenario A: a new extension / mobile → 201', async () => {
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Nia', last_name: 'New', extension_number: num('31'), mobile_number: num('+96650') });
    expect(res.status).toBe(201);
    expect(res.body.upserted).toBeUndefined();
  });

  it('scenarios B/C/D: matching by extension, by mobile, or by both updates the existing contact (same id)', async () => {
    const id = await insertContact({ org: orgA1, first: 'Old', last: 'Name', ext: num('32'), mobile: num('0532') });
    const byExt = await create(adminA, { organization_id: orgA1, first_name: 'Ext', last_name: 'Match', extension_number: num('32') });
    expect(byExt.status).toBe(200);
    expect(byExt.body).toMatchObject({ id, upserted: true, matched_by: 'extension', first_name: 'Ext', mobile_number: num('0532') });
    const byMob = await create(adminA, { organization_id: orgA1, first_name: 'Mob', last_name: 'Match', mobile_number: num('0532') });
    expect(byMob.body).toMatchObject({ id, upserted: true, matched_by: 'mobile', first_name: 'Mob', extension_number: num('32') });
    const both = await create(adminA, { organization_id: orgA1, first_name: 'Both', last_name: 'Match', mobile_number: num('0532'), extension_number: num('32') });
    expect(both.body).toMatchObject({ id, upserted: true, matched_by: 'both', first_name: 'Both' });
    expect(await liveCount('(extension_norm=$1 OR mobile_norm=$2)', [num('32'), num('0532')])).toBe(1);
  });

  it('scenario E: a new mobile for a known extension replaces the mobile on the same contact', async () => {
    const id = await insertContact({ org: orgA1, ext: num('33'), mobile: num('0533') });
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Seed', last_name: 'Person', extension_number: num('33'), mobile_number: num('0633') });
    expect(res.body).toMatchObject({ id, upserted: true, mobile_number: num('0633') });
    expect(await liveCount('mobile_norm=$1', [num('0533')])).toBe(0);
  });

  it('a new extension for a known mobile is set on the same contact (extension changed)', async () => {
    const id = await insertContact({ org: orgA1, mobile: num('0530'), ext: num('30') });
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Seed', last_name: 'Person', mobile_number: num('0530'), extension_number: num('300') });
    expect(res.body).toMatchObject({ id, upserted: true, matched_by: 'mobile', extension_number: num('300') });
    expect(await liveCount('extension_norm=$1', [num('30')])).toBe(0);
  });

  it('group memberships and ERS / ENS assignments survive an upsert (the id never changes)', async () => {
    const id = await insertContact({ org: orgA1, mobile: num('0534') });
    const { rows: [g] } = await query(`INSERT INTO responder_groups (organization_id, name, is_active) VALUES ($1,$2,true) RETURNING id`, [orgA1, `CI Group ${TS}`]);
    await query(`INSERT INTO responder_group_members (responder_group_id, emergency_contact_id) VALUES ($1,$2)`, [g.id, id]);
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Kept', last_name: 'Member', mobile_number: num('0534') });
    expect(res.body.id).toBe(id);
    const { rows } = await query(`SELECT emergency_contact_id FROM responder_group_members WHERE responder_group_id=$1`, [g.id]);
    expect(rows).toEqual([{ emergency_contact_id: id }]);
  });

  it('an upsert never moves a contact to another organization (the request\'s department must fit the contact\'s org)', async () => {
    const id = await insertContact({ org: orgA1, mobile: num('0535') });
    const res = await create(adminA, { organization_id: orgA1, department_id: deptA1, first_name: 'Dept', last_name: 'Set', mobile_number: num('0535') });
    expect(res.body).toMatchObject({ id, organization_id: orgA1, department_id: deptA1 });
  });
});

describe('CI-2: latest values', () => {
  it('supplied fields win, omitted fields are kept, an explicit empty value clears (as PUT does)', async () => {
    const id = await insertContact({ org: orgA1, first: 'Lat', last: 'Est', mobile: num('0536'), ext: num('36'), email: 'keep@ci.test', role: 'Guard' });
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Lat', last_name: 'Est', mobile_number: num('0536'), role: '' });
    expect(res.status).toBe(200);
    const r = await row(id);
    expect(r).toMatchObject({ email: 'keep@ci.test', extension_number: num('36'), role: null, is_active: true });
  });

  it('is_active is only changed when sent', async () => {
    const id = await insertContact({ org: orgA1, mobile: num('0537') });
    await query(`UPDATE emergency_contacts SET is_active=false WHERE id=$1`, [id]);
    await create(adminA, { organization_id: orgA1, first_name: 'In', last_name: 'Active', mobile_number: num('0537') });
    expect((await row(id)).is_active).toBe(false);
    await create(adminA, { organization_id: orgA1, first_name: 'In', last_name: 'Active', mobile_number: num('0537'), is_active: true });
    expect((await row(id)).is_active).toBe(true);
  });

  it('an explicitly empty mobile on a contact matched by extension keeps the contact valid (extension unchanged)', async () => {
    const id = await insertContact({ org: orgA1, ext: num('38') });
    const res = await create(adminA, { organization_id: orgA1, first_name: 'X', last_name: 'Y', extension_number: num('38'), mobile_number: '' });
    expect(res.status).toBe(200);                                  // mobile was already empty
    expect((await row(id)).extension_number).toBe(num('38'));
  });
});

describe('CI-3: normalisation', () => {
  it('whitespace, punctuation, case and 00 / + forms of one number find the same contact', async () => {
    const id = await insertContact({ org: orgA1, mobile: `+966 51 ${SFX}`, ext: `Ab-${SFX}` });
    // Only the identifier under test is sent (an explicit null would clear the other one).
    for (const ids of [{ mobile_number: `+96651${SFX}` }, { mobile_number: `00966-51-${SFX}` }, { extension_number: `ab${SFX}` }, { extension_number: ` AB ${SFX} ` }]) {
      const res = await create(adminA, { organization_id: orgA1, first_name: 'Norm', last_name: 'Alised', ...ids });
      expect(res.body).toMatchObject({ id, upserted: true });
    }
    expect(await row(id)).toMatchObject({ extension_norm: `ab${SFX}`, mobile_norm: `+96651${SFX}` });
  });

  it('an explicit null for the other identifier clears it (the same semantics as PUT)', async () => {
    const id = await insertContact({ org: orgA1, mobile: num('0539'), ext: num('39') });
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Clr', last_name: 'Ext', mobile_number: num('0539'), extension_number: null });
    expect(res.body).toMatchObject({ id, upserted: true, extension_number: null });
  });

  it('local and international forms are different numbers (no country-code guessing)', async () => {
    await insertContact({ org: orgA1, mobile: `05${SFX}9` });
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Intl', last_name: 'Form', mobile_number: `+9665${SFX}9` });
    expect(res.status).toBe(201);
  });

  it('the same subscriber number under two country codes is two identities; 00 and + are one', async () => {
    const ksa = await create(adminA, { organization_id: orgA1, first_name: 'Cc', last_name: 'Ksa', mobile_number: `+966 51 ${SFX}8` });
    const uae = await create(adminA, { organization_id: orgA1, first_name: 'Cc', last_name: 'Uae', mobile_number: `+971 51 ${SFX}8` });
    expect([ksa.status, uae.status]).toEqual([201, 201]);
    const again = await create(adminA, { organization_id: orgA1, first_name: 'Cc', last_name: 'Ksa2', mobile_number: `00966-51-${SFX}8` });
    expect(again.body).toMatchObject({ id: ksa.body.id, upserted: true });
    const other = await create(adminB, { organization_id: orgB, first_name: 'Cc', last_name: 'Other', mobile_number: `+971-51-${SFX}8` });
    expect(other.status).toBe(409);                                            // international form held in another tenant
  });

  it('missing, empty and whitespace-only identifiers never collide', async () => {
    const a = await create(adminA, { organization_id: orgA1, first_name: 'Only', last_name: 'Ext1', extension_number: num('41'), mobile_number: '' });
    const b = await create(adminA, { organization_id: orgA1, first_name: 'Only', last_name: 'Ext2', extension_number: num('42'), mobile_number: null });
    const c = await create(adminA, { organization_id: orgA1, first_name: 'Only', last_name: 'Ext3', extension_number: num('43') });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    const d = await create(adminA, { organization_id: orgA1, first_name: 'Only', last_name: 'Mob', mobile_number: num('0544'), extension_number: '   ' });
    expect(d.status).toBe(201);
  });
});

describe('CI-4: another organization or tenant', () => {
  let held;
  beforeAll(async () => { held = await insertContact({ org: orgB, first: 'Secret', last: 'Holder', mobile: num('0551'), ext: num('51') }); });

  it.each([
    ['mobile', { mobile_number: num('0551') }],
    ['extension', { extension_number: num('51') }],
    ['both', { mobile_number: num('0551'), extension_number: num('51') }],
  ])('scenario F (%s): 409 with a safe message; nothing created or changed', async (field, ids) => {
    const before = await row(held);
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Take', last_name: 'Over', ...ids });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'IDENTIFIER_IN_OTHER_ORGANIZATION', field });
    const text = JSON.stringify(res.body);
    for (const s of ['Secret', 'Holder', 'CI Secret Org B', String(held), String(orgB), String(tenantB)]) expect(text).not.toContain(s);
    expect(await row(held)).toEqual(before);
    expect(await liveCount('organization_id=$1 AND last_name=$2', [orgA1, 'Over'])).toBe(0);
  });

  it('a different organization of the same tenant is also "another organization" (contacts never move)', async () => {
    const id = await insertContact({ org: orgA2, mobile: num('0552') });
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Move', last_name: 'Me', mobile_number: num('0552') });
    expect(res.status).toBe(409);
    expect((await row(id)).organization_id).toBe(orgA2);
  });

  it('SUPER_ADMIN follows the same rule', async () => {
    const res = await create(superAdmin, { tenant_id: tenantA, organization_id: orgA1, first_name: 'Sup', last_name: 'Er', mobile_number: num('0551') });
    expect(res.status).toBe(409);
  });
});

describe('CI-5: extension of one contact, mobile of another (scenario G)', () => {
  it('same organization: 409 naming both contacts; neither is changed', async () => {
    const x = await insertContact({ org: orgA1, first: 'Xa', last: 'Ext', ext: num('61') });
    const y = await insertContact({ org: orgA1, first: 'Yb', last: 'Mob', mobile: num('0561') });
    const [bx, by] = [await row(x), await row(y)];
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Mer', last_name: 'Ge', extension_number: num('61'), mobile_number: num('0561') });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'IDENTIFIER_CONFLICT' });
    expect(res.body.contacts).toEqual([{ matched: 'extension', id: x, name: 'Xa Ext' }, { matched: 'mobile', id: y, name: 'Yb Mob' }]);
    expect([await row(x), await row(y)]).toEqual([bx, by]);
  });

  it('involving another organization: 409 without naming anyone', async () => {
    await insertContact({ org: orgA1, ext: num('62') });
    await insertContact({ org: orgB, mobile: num('0562') });
    const res = await create(adminA, { organization_id: orgA1, first_name: 'Mer', last_name: 'Ge', extension_number: num('62'), mobile_number: num('0562') });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDENTIFIER_CONFLICT');
    expect(res.body.contacts).toBeUndefined();
  });
});

describe('CI-6: Edit Contact', () => {
  it('keeping or reformatting the contact\'s own identifiers is fine', async () => {
    const id = await insertContact({ org: orgA1, mobile: num('0571'), ext: num('71') });
    expect((await edit(adminA, id, { first_name: 'Same', mobile_number: num('0571') })).status).toBe(200);
    expect((await edit(adminA, id, { mobile_number: `057 1${SFX}` })).status).toBe(200);   // = num('0571') reformatted
    expect((await row(id)).mobile_norm).toBe(num('0571'));
  });

  it('an identifier of another contact in the organization → 409 naming it; of another organization → 409 safe', async () => {
    const mine = await insertContact({ org: orgA1, mobile: num('0572') });
    const other = await insertContact({ org: orgA1, first: 'Ot', last: 'Her', ext: num('72') });
    const foreign = await insertContact({ org: orgB, first: 'For', last: 'Eign', ext: num('73') });
    const r1 = await edit(adminA, mine, { extension_number: num('72') });
    expect(r1.status).toBe(409);
    expect(r1.body).toMatchObject({ code: 'IDENTIFIER_IN_USE', field: 'extension', contact: { id: other, name: 'Ot Her' } });
    const r2 = await edit(adminA, mine, { extension_number: num('73') });
    expect(r2.status).toBe(409);
    expect(r2.body).toMatchObject({ code: 'IDENTIFIER_IN_OTHER_ORGANIZATION', field: 'extension' });
    expect(JSON.stringify(r2.body)).not.toContain('Eign');
    expect(JSON.stringify(r2.body)).not.toContain(String(foreign));
    expect((await row(mine)).extension_number).toBeNull();
  });
});

describe('CI-7: identity-check endpoint', () => {
  it('reports new / update / other_organization / conflict', async () => {
    const id = await insertContact({ org: orgA1, first: 'Chk', last: 'One', mobile: num('0581'), ext: num('81') });
    await insertContact({ org: orgA1, ext: num('82') });
    await insertContact({ org: orgB, mobile: num('0583') });
    expect((await check(adminA, { organization_id: orgA1, mobile_number: num('0589') })).body).toEqual({ status: 'new' });
    expect((await check(adminA, { organization_id: orgA1, mobile_number: num('0581') })).body)
      .toEqual({ status: 'update', matched_by: 'mobile', contact: { id, name: 'Chk One' } });
    const other = await check(adminA, { organization_id: orgA1, mobile_number: num('0583') });
    expect(other.body).toEqual({ status: 'other_organization', field: 'mobile', message: 'This mobile number is already assigned to a contact in another organization' });
    expect((await check(adminA, { organization_id: orgA1, mobile_number: num('0581'), extension_number: num('82') })).body.status).toBe('conflict');
    expect((await check(adminA, { organization_id: orgA1, mobile_number: num('0581'), exclude_id: id })).body).toEqual({ status: 'new' });
    expect((await check(adminA, { organization_id: orgA1 })).body).toEqual({ status: 'new' });
  });

  it('is tenant-scoped and ADMIN-only; bad input is a 400', async () => {
    expect((await check(adminB, { organization_id: orgA1, mobile_number: '1' })).status).toBe(404);
    expect((await check(operatorA, { organization_id: orgA1, mobile_number: '1' })).status).toBe(403);
    expect((await check(adminA, { mobile_number: '1' })).status).toBe(400);
    expect((await check(adminA, { organization_id: 'x' })).status).toBe(400);
  });

  it('writes nothing', async () => {
    const since = await lastAuditId();
    await check(adminA, { organization_id: orgA1, mobile_number: num('0581') });
    expect(await auditsSince(since)).toEqual([]);
  });
});

describe('CI-8: concurrency', () => {
  it('eight simultaneous creates of one person → exactly one contact (one 201, the rest 200 upserted)', async () => {
    const body = (i) => ({ organization_id: orgA1, first_name: 'Race', last_name: `R${i}`, mobile_number: num('0591'), extension_number: num('91') });
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => create(adminA, body(i))));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(res.map((r) => r.body.id)).size).toBe(1);
    expect(await liveCount('(mobile_norm=$1 OR extension_norm=$2)', [num('0591'), num('91')])).toBe(1);
  });

  it('simultaneous creates into two organizations → one owner, the other refused', async () => {
    const [r1, r2] = await Promise.all([
      create(adminA, { organization_id: orgA1, first_name: 'Two', last_name: 'Orgs', mobile_number: num('0592') }),
      create(adminB, { organization_id: orgB, first_name: 'Two', last_name: 'Orgs', mobile_number: num('0592') }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(await liveCount('mobile_norm=$1', [num('0592')])).toBe(1);
  });
});

describe('CI-9: database backstop', () => {
  it('a direct second insert of a normalised duplicate is refused by the unique indexes', async () => {
    await insertContact({ org: orgA1, mobile: `+966 52 ${SFX}`, ext: `E-${SFX}` });
    await expect(insertContact({ org: orgB, mobile: `00966-52-${SFX}` })).rejects.toMatchObject({ code: '23505', constraint: 'uq_contacts_mobile_norm' });
    await expect(insertContact({ org: orgB, ext: ` e${SFX} ` })).rejects.toMatchObject({ code: '23505', constraint: 'uq_contacts_extension_norm' });
  });

  it('soft-deleted contacts free their identifiers; NULL / empty identifiers never collide', async () => {
    const id = await insertContact({ org: orgA1, mobile: num('0593') });
    await query(`UPDATE emergency_contacts SET deleted_at=now() WHERE id=$1`, [id]);
    expect((await create(adminA, { organization_id: orgA1, first_name: 'Re', last_name: 'Used', mobile_number: num('0593') })).status).toBe(201);
    await insertContact({ org: orgA1, ext: num('94'), mobile: '' });
    await insertContact({ org: orgA1, ext: num('95'), mobile: '   ' });
    await insertContact({ org: orgA1, mobile: num('0596'), ext: '' });
    await insertContact({ org: orgA1, mobile: num('0597'), ext: ' - ' });
  });

  it('the generated columns and the service normalise identically', async () => {
    const samples = ['', ' ', '+', '++1', '0050', '00 1 (2) 3', '+00 12', '1+2', 'abc', '05-1.2 3', '+966 (50) 123-4567', 'Ab.C-1', ' X Y ', '(1)-(2)', '\t9\n'];
    const { rows } = await query(
      `WITH s(v) AS (SELECT unnest($1::text[]))
       SELECT v,
         NULLIF(lower(regexp_replace(COALESCE(v, ''), '[[:space:]().-]', '', 'g')), '') AS ext,
         NULLIF(NULLIF(CASE WHEN left(regexp_replace(regexp_replace(COALESCE(v, ''), '[^0-9+]', '', 'g'), '^00', '+'), 1) = '+'
              THEN '+' || regexp_replace(regexp_replace(regexp_replace(COALESCE(v, ''), '[^0-9+]', '', 'g'), '^00', '+'), '[^0-9]', '', 'g')
              ELSE regexp_replace(regexp_replace(COALESCE(v, ''), '[^0-9+]', '', 'g'), '[^0-9]', '', 'g') END, ''), '+') AS mob
       FROM s`, [samples]);
    for (const r of rows) {
      expect([r.v, r.ext]).toEqual([r.v, normalizeExtension(r.v)]);
      expect([r.v, r.mob]).toEqual([r.v, normalizeMobile(r.v)]);
    }
    // ... and the stored columns use exactly that expression
    const id = await insertContact({ org: orgA1, mobile: `+00 ${SFX}9`, ext: `Q.${SFX}` });
    const r = await row(id);
    expect([r.mobile_norm, r.extension_norm]).toEqual([normalizeMobile(`+00 ${SFX}9`), normalizeExtension(`Q.${SFX}`)]);
  });
});

describe('CI-10: audit events', () => {
  const noNumbers = (rows, ...values) => { const t = JSON.stringify(rows); for (const v of values) expect(t).not.toContain(v); };

  it('create → contact_created; upsert → contact_duplicate_prevented (matched_by, field names)', async () => {
    let since = await lastAuditId();
    const c = await create(adminA, { organization_id: orgA1, first_name: 'Aud', last_name: 'It', mobile_number: num('0601') });
    let rows = await auditsSince(since);
    expect(rows).toEqual([expect.objectContaining({ action: 'contact_created', entity_id: String(c.body.id) })]);
    expect(rows[0].details).toMatchObject({ tenant_id: tenantA, organization_id: orgA1, source: 'manual' });

    since = await lastAuditId();
    await create(adminA, { organization_id: orgA1, first_name: 'Aud2', last_name: 'It', mobile_number: num('0601') });
    rows = await auditsSince(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'contact_duplicate_prevented', entity_id: String(c.body.id) });
    expect(rows[0].details).toMatchObject({ tenant_id: tenantA, matched_by: 'mobile', changed_fields: ['first_name'] });
    noNumbers(rows, num('0601'), 'Aud2');
  });

  it('a refusal → contact_identifier_conflict recorded under the caller\'s tenant, without the other contact', async () => {
    const foreign = await insertContact({ org: orgB, mobile: num('0602') });
    const since = await lastAuditId();
    await create(adminA, { organization_id: orgA1, first_name: 'No', last_name: 'Pe', mobile_number: num('0602') });
    const rows = await auditsSince(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'contact_identifier_conflict', entity_id: null });
    expect(rows[0].details).toMatchObject({ tenant_id: tenantA, organization_id: orgA1, kind: 'other_organization', field: 'mobile' });
    noNumbers(rows, num('0602'), String(foreign));
  });

  it('a split match records contact ids only when both contacts are in the caller\'s organization', async () => {
    const x = await insertContact({ org: orgA1, ext: num('64') });
    const y = await insertContact({ org: orgA1, mobile: num('0564') });
    const z = await insertContact({ org: orgB, mobile: num('0565') });
    let since = await lastAuditId();
    await create(adminA, { organization_id: orgA1, first_name: 'S', last_name: 'M', extension_number: num('64'), mobile_number: num('0564') });
    let rows = await auditsSince(since, 'contact_identifier_conflict');
    expect(rows[0].details).toMatchObject({ kind: 'conflict', conflicting_contact_ids: [x, y] });
    since = await lastAuditId();
    await create(adminA, { organization_id: orgA1, first_name: 'S', last_name: 'M', extension_number: num('64'), mobile_number: num('0565') });
    rows = await auditsSince(since, 'contact_identifier_conflict');
    expect(rows[0].details.kind).toBe('conflict');
    expect(rows[0].details.conflicting_contact_ids).toBeUndefined();
    noNumbers(rows, String(z));
  });

  it('an import → one contacts_imported summary with created / updated / conflict counts', async () => {
    const since = await lastAuditId();
    const csv = `first_name,last_name,mobile_number\nImp,New,${num('0603')}\nAud3,It,${num('0601')}\nX,Y,${num('0602')}\n`;
    const res = await request(server).post('/api/v1/contacts/bulk-upload').set(auth(adminA))
      .field('organization_id', String(orgA1)).attach('file', Buffer.from(csv), 'c.csv');
    expect(res.body).toMatchObject({ total: 3, created: 1, updated: 1, conflicts: 1, invalid: 1, duplicates_prevented: 1 });
    const rows = await auditsSince(since, 'contacts_imported');
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ inserted: 1, updated: 1, conflicts: 1, error_rows: 1, total_rows: 3 });
    noNumbers(rows, num('0603'), num('0601'));
  });
});

describe('CI-11: ERS broadcast-users API', () => {
  const post = (token, body) => request(server).post('/api/v1/ers/broadcast-users').set(auth(token)).send(body);

  it('creates, updates the same organization\'s contact, rejects another organization\'s numbers', async () => {
    const mine = await insertContact({ org: orgA1, first: 'Brd', last: 'Cast', mobile: num('0611') });
    await insertContact({ org: orgB, mobile: num('0612') });
    const res = await post(adminA, { organization_id: orgA1, group_name: `CI Broadcast ${TS}`, users: [
      { name: 'New User', mobile: num('0613'), extension: num('613') },
      { name: 'Brd Updated', mobile: num('0611') },
      { name: 'Other Org', mobile: num('0612') },
    ] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, updated: 1, total: 3,
      rejected: [{ index: 2, error: 'This mobile number is already assigned to a contact in another organization' }] });
    expect((await row(mine)).last_name).toBe('Updated');
    const { rows } = await query(`SELECT emergency_contact_id FROM responder_group_members WHERE responder_group_id=$1 ORDER BY 1`, [res.body.group_id]);
    expect(rows).toHaveLength(2);
    expect(await liveCount('mobile_norm=$1', [num('0612')])).toBe(1);
  });

  it('keeps its original match key inside the organization: 0501… and +966501… are the same user', async () => {
    const id = await insertContact({ org: orgA1, first: 'Leg', last: 'Acy', mobile: `05${SFX}123` });
    const res = await post(adminA, { organization_id: orgA1, group_name: `CI Broadcast L ${TS}`, users: [{ name: 'Leg Acy', mobile: `+9665${SFX}123` }] });
    expect(res.body).toMatchObject({ created: 0, updated: 1, rejected: [] });
    expect((await row(id)).mobile_number).toBe(`+9665${SFX}123`);
    expect(await liveCount('organization_id=$1 AND last_name=$2', [orgA1, 'Acy'])).toBe(1);
  });

  it('the legacy match never overwrites a different international number (country codes stay significant)', async () => {
    const uae = await insertContact({ org: orgA1, first: 'Uae', last: 'Number', mobile: `+97150${SFX}124` });
    const before = await row(uae);
    const res = await post(adminA, { organization_id: orgA1, group_name: `CI Broadcast I ${TS}`, users: [{ name: 'Ksa Number', mobile: `+96650${SFX}124` }] });
    expect(res.body).toMatchObject({ created: 1, updated: 0, rejected: [] });
    expect(await row(uae)).toEqual(before);                                       // untouched
    expect(await liveCount('mobile_norm = ANY($1)', [[`+97150${SFX}124`, `+96650${SFX}124`]])).toBe(2);
  });

  it('the legacy match still pairs a number written with and without "+" (same digits)', async () => {
    const id = await insertContact({ org: orgA1, first: 'Plus', last: 'Less', mobile: `96650${SFX}125` });
    const res = await post(adminA, { organization_id: orgA1, group_name: `CI Broadcast P ${TS}`, users: [{ name: 'Plus Less', mobile: `+96650${SFX}125` }] });
    expect(res.body).toMatchObject({ created: 0, updated: 1 });
    expect((await row(id)).mobile_norm).toBe(`+96650${SFX}125`);
  });

  it('a repeated user inside one request is one contact', async () => {
    const res = await post(adminA, { organization_id: orgA1, group_name: `CI Broadcast R ${TS}`, users: [
      { name: 'Rep Eat', mobile: num('0614') }, { name: 'Rep Eat', mobile: `06-14 ${SFX}` },
    ] });
    expect(res.body).toMatchObject({ created: 1, updated: 1 });
    expect(await liveCount('mobile_norm=$1', [num('0614')])).toBe(1);
  });
});

describe('CI-12: recipient safeguard (ENS / ERS)', () => {
  let ersId, ensId, ersNum, ensNum, a, b, c;
  beforeAll(async () => {
    // A's extension is B's mobile: both allowed (different columns), but one dial target.
    a = await insertContact({ org: orgA1, first: 'Leg', last: 'A', ext: num('7') });
    b = await insertContact({ org: orgA1, first: 'Leg', last: 'B', mobile: `7-${SFX}` });   // same number, written differently
    c = await insertContact({ org: orgA1, first: 'Leg', last: 'C', mobile: num('0708') });
    ({ rows: [{ id: ersId }] } = await query(
      `INSERT INTO ers_configurations (name, organization_id, tenant_id, max_concurrent_conferences, is_active)
       VALUES ('CI ERS', $1, $2, 2, true) RETURNING id`, [orgA1, tenantA]));
    extraConfigs.ers.push(ersId);
    for (const id of [a, b, c]) {
      await query(`INSERT INTO ers_tier_contacts (ers_configuration_id, tier, contact_id) VALUES ($1,'primary',$2)`, [ersId, id]);
    }
    ({ rows: [{ id: ensId }] } = await query(
      `INSERT INTO ens_configurations (organization_id, tenant_id, name, is_active) VALUES ($1,$2,'CI ENS',true) RETURNING id`, [orgA1, tenantA]));
    extraConfigs.ens.push(ensId);
    for (const id of [a, b, c]) {
      await query(`INSERT INTO ens_configuration_contacts (ens_configuration_id, emergency_contact_id) VALUES ($1,$2)`, [ensId, id]);
    }
    ersNum = `9${SFX}1`; ensNum = `9${SFX}2`;
    const { rows: [n1] } = await query(`INSERT INTO emergency_numbers (tenant_id, organization_id, number, type, ers_configuration_id, is_active)
      VALUES ($1,$2,$3,'ERS',$4,true) RETURNING id`, [tenantA, orgA1, ersNum, ersId]);
    const { rows: [n2] } = await query(`INSERT INTO emergency_numbers (tenant_id, organization_id, number, type, ens_configuration_id, is_active)
      VALUES ($1,$2,$3,'ENS',$4,true) RETURNING id`, [tenantA, orgA1, ensNum, ensId]);
    extraConfigs.numbers.push(n1.id, n2.id);
  });

  it('ERS ring-all rings each number once (the lowest contact id is kept)', async () => {
    const legs = await ring.resolveTierResponders(ersId, 'primary');
    expect(legs.map((l) => l.id).sort((x, y) => x - y)).toEqual([a, c]);
  });

  it('a tier without duplicates is returned exactly as the query returns it (same rows, same order)', async () => {
    const d = await insertContact({ org: orgA1, first: 'Leg', last: 'D', mobile: num('0709') });
    for (const id of [c, d]) await query(`INSERT INTO ers_tier_contacts (ers_configuration_id, tier, contact_id) VALUES ($1,'secondary',$2)`, [ersId, id]);
    const legs = await ring.resolveTierResponders(ersId, 'secondary');
    const { rows: raw } = await query(
      `SELECT DISTINCT ec.id, ec.first_name, ec.last_name, ec.mobile_number, ec.extension_number
       FROM emergency_contacts ec WHERE ec.deleted_at IS NULL AND ec.is_active = true
         AND ec.id IN (SELECT contact_id FROM ers_tier_contacts WHERE ers_configuration_id = $1 AND tier = 'secondary')`, [ersId]);
    expect(legs).toEqual(raw);
    expect(legs).toHaveLength(2);
  });

  it('ENS: one contact reached directly and through a group is one recipient', async () => {
    const { rows: [g] } = await query(`INSERT INTO responder_groups (organization_id, name, is_active) VALUES ($1,$2,true) RETURNING id`, [orgA1, `CI ENS Group ${TS}`]);
    await query(`INSERT INTO responder_group_members (responder_group_id, emergency_contact_id) VALUES ($1,$2)`, [g.id, c]);
    await query(`INSERT INTO ens_configuration_groups (ens_configuration_id, responder_group_id) VALUES ($1,$2)`, [ensId, g.id]);
    const ens = await request(server).get('/api/v1/internal/ens/lookup').query({ number: ensNum }).set({ 'X-Internal-Key': process.env.INTERNAL_API_KEY });
    expect(ens.body.data.contacts.filter((n) => n === num('0708'))).toHaveLength(1);
  });

  it('independent configurations / campaigns still each reach the same contact (de-duplication is per execution)', async () => {
    const { rows: [{ id: ens2 }] } = await query(
      `INSERT INTO ens_configurations (organization_id, tenant_id, name, is_active) VALUES ($1,$2,'CI ENS 2',true) RETURNING id`, [orgA1, tenantA]);
    extraConfigs.ens.push(ens2);
    await query(`INSERT INTO ens_configuration_contacts (ens_configuration_id, emergency_contact_id) VALUES ($1,$2)`, [ens2, c]);
    const n3 = `9${SFX}3`;
    const { rows: [nr] } = await query(`INSERT INTO emergency_numbers (tenant_id, organization_id, number, type, ens_configuration_id, is_active)
      VALUES ($1,$2,$3,'ENS',$4,true) RETURNING id`, [tenantA, orgA1, n3, ens2]);
    extraConfigs.numbers.push(nr.id);
    const key = { 'X-Internal-Key': process.env.INTERNAL_API_KEY };
    const first = await request(server).get('/api/v1/internal/ens/lookup').query({ number: ensNum }).set(key);
    const second = await request(server).get('/api/v1/internal/ens/lookup').query({ number: n3 }).set(key);
    expect(first.body.data.contacts).toContain(num('0708'));
    expect(second.body.data.contacts).toEqual([num('0708')]);
  });

  it('the ERS and ENS Lua lookups list each number once', async () => {
    const key = { 'X-Internal-Key': process.env.INTERNAL_API_KEY };
    const ers = await request(server).get('/api/v1/internal/ers/lookup').query({ number: ersNum }).set(key);
    expect(ers.status).toBe(200);
    expect([...ers.body.data.primary_responders].sort()).toEqual([num('0708'), `7-${SFX}`].sort());   // first of the sorted forms is kept
    const ens = await request(server).get('/api/v1/internal/ens/lookup').query({ number: ensNum }).set(key);
    expect(ens.status).toBe(200);
    expect([...ens.body.data.contacts].sort()).toEqual([num('0708'), `7-${SFX}`].sort());   // first of the sorted forms is kept
  });
});
