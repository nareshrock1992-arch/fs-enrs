/**
 * Emergency Contacts — Excel / CSV import templates and Excel import.
 *
 *  CX-1  Excel template: sheets, header order, example rows, instructions, text columns, drop-down
 *  CX-2  CSV template: BOM, CRLF, same header and example rows
 *  CX-3  template access (roles, SUPER_ADMIN modes, no tenant data, bad format)
 *  CX-4  unchanged example rows are rejected; real contacts resembling them are not
 *  CX-5  Excel import (compressed parts, shared + inline strings, numbers, booleans, empty rows,
 *        per-row organization, department and location)
 *  CX-6  row validation messages (preview writes nothing)
 *  CX-7  header errors
 *  CX-8  malformed, hostile and unsupported files
 *  CX-9  file-size and row limits
 *  CX-10 duplicate detection (existing, within the file, across organizations; preview = commit)
 *  CX-11 tenant isolation and SUPER_ADMIN (selected tenant, All Tenants with explicit target)
 *  CX-12 audit records (per organization, format, no personal data; none for a preview)
 *  CX-13 spreadsheet-formula text is stored as text and neutralised on export
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { deflateRawSync } from 'zlib';
import { parse } from 'csv-parse/sync';

process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-32chars-padding!';

import server from '../../../server.js';
import { query } from '../../db/pool.js';
import { crc32, readZip } from '../../utils/zipStore.js';
import { readXlsx } from '../../utils/xlsxReader.js';
import { IMPORT_FIELDS, TEMPLATE_EXAMPLES } from '../../controllers/contactController.js';

const TS = Date.now();
let tenantA, tenantB, tenantOff;
let orgA1, orgA2, orgB1, orgDefault;
let adminA = '', adminB = '', operatorA = '', supervisorA = '', superAdmin = '';
const orgIds = [];
const userIds = [];
const N = {
  a1: `Alpha HQ ${TS}`, a2: `Alpha Branch ${TS}`, b1: `Beta HQ ${TS}`, twin: `Twin ${TS}`,
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function makeUser(email, role, tenantId) {
  const hash = await bcrypt.hash('Test1234!', 4);
  const { rows: [u] } = await query(
    `INSERT INTO users (email, password_hash, role, tenant_id, is_active, full_name)
     VALUES ($1,$2,$3,$4,true,'Contacts Import Test') RETURNING id`, [email, hash, role, tenantId]);
  userIds.push(u.id);
  return (await request(server).post('/api/v1/auth/login').send({ email, password: 'Test1234!' })).body.token;
}
async function makeOrg(name, tenantId) {
  const { rows: [o] } = await query(`INSERT INTO organizations (name, tenant_id) VALUES ($1,$2) RETURNING id`, [name, tenantId]);
  orgIds.push(o.id);
  return o.id;
}
const makeDept = async (org, name) => (await query(`INSERT INTO departments (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, name])).rows[0].id;
const makeLoc = async (org, name) => (await query(`INSERT INTO locations (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, name])).rows[0].id;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const binary = (res, cb) => { const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); };
const getTemplate = (token, format, q = {}) => request(server).get('/api/v1/contacts/import-template')
  .query({ format, ...q }).set(auth(token)).buffer(true).parse(binary);
const countTenant = async (tenantId) => (await query(
  `SELECT COUNT(*)::int n FROM emergency_contacts c JOIN organizations o ON o.id = c.organization_id
   WHERE o.tenant_id = $1 AND c.deleted_at IS NULL`, [tenantId])).rows[0].n;
const lastAuditId = async () => (await query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM audit_logs`)).rows[0].id;
const importAudits = async (since) => (await query(
  `SELECT user_id, details FROM audit_logs WHERE id > $1 AND action = 'contacts_imported' ORDER BY id`, [since])).rows;

function upload(token, file, { filename = 'contacts.xlsx', mode = 'preview', org, tenant } = {}) {
  const r = request(server).post('/api/v1/contacts/bulk-upload').set(auth(token));
  if (mode) r.field('mode', mode);
  if (org !== undefined) r.field('organization_id', String(org));
  if (tenant !== undefined) r.field('tenant_id', String(tenant));
  return r.attach('file', Buffer.isBuffer(file) ? file : Buffer.from(file, 'utf8'), filename);
}

// ZIP with DEFLATE-compressed parts, as Excel and LibreOffice save workbooks.
// opts.sizes / opts.crcs / opts.flags / opts.methods override header fields per part (hostile files).
function zipOf(parts, { sizes = {}, crcs = {}, flags = {}, methods = {}, stored = false } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const method = methods[name] ?? (stored ? 0 : 8);
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const usize = sizes[name] ?? data.length;
    const crc = crcs[name] ?? crc32(data);
    const flag = 0x0800 | (flags[name] ?? 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flag, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flag, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colRef = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/**
 * Workbook parts. rows: array (row i+1) or { rowNumber: cells }. Cell: string (shared string, or
 * inline when opts.inline), { n } number, { b } boolean, { f, v } formula, { e } error,
 * { inline } inline string, null (no cell).
 */
function workbookParts(rows, { sheetName = 'Emergency Contacts', inline = false, before = null, contentTypesExtra = '', sheetPrefix = '' } = {}) {
  const sst = [];
  const index = new Map();
  const shared = (s) => { if (!index.has(s)) { index.set(s, sst.length); sst.push(s); } return index.get(s); };
  const entries = Array.isArray(rows) ? rows.map((r, i) => [i + 1, r]) : Object.entries(rows).map(([k, v]) => [Number(k), v]);
  const cellXml = (c, ref) => {
    if (c === null || c === undefined) return '';
    if (typeof c === 'string') return inline ? `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>` : `<c r="${ref}" t="s"><v>${shared(c)}</v></c>`;
    if (c.n !== undefined) return `<c r="${ref}"><v>${c.n}</v></c>`;
    if (c.b !== undefined) return `<c r="${ref}" t="b"><v>${c.b ? 1 : 0}</v></c>`;
    if (c.f !== undefined) return `<c r="${ref}" t="str"><f>${esc(c.f)}</f><v>${esc(c.v ?? '')}</v></c>`;
    if (c.e !== undefined) return `<c r="${ref}" t="e"><v>${esc(c.e)}</v></c>`;
    if (c.inline !== undefined) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(c.inline)}</t></is></c>`;
    return '';
  };
  const data = entries.map(([n, cells]) => `<row r="${n}">${cells.map((c, i) => cellXml(c, `${colRef(i)}${n}`)).join('')}</row>`).join('');
  const sheets = [];
  if (before) sheets.push(before);
  sheets.push({ name: sheetName, xml: `<?xml version="1.0" encoding="UTF-8"?>${sheetPrefix}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>` });
  const parts = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${contentTypesExtra}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    }<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml]),
  ];
  parts.push(['xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${
    sst.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`]);
  return parts;
}
const workbook = (rows, opts = {}) => zipOf(workbookParts(rows, opts), opts.zip);
const row = (o) => IMPORT_FIELDS.map((f) => (o[f] === undefined ? '' : o[f]));

beforeAll(async () => {
  ({ rows: [{ id: tenantA }] } = await query(`INSERT INTO tenants (name, code) VALUES ($1,$2) RETURNING id`, [`CX-A-${TS}`, `cx-a-${TS}`]));
  ({ rows: [{ id: tenantB }] } = await query(`INSERT INTO tenants (name, code) VALUES ($1,$2) RETURNING id`, [`CX-B-${TS}`, `cx-b-${TS}`]));
  ({ rows: [{ id: tenantOff }] } = await query(`INSERT INTO tenants (name, code, is_active) VALUES ($1,$2,false) RETURNING id`, [`CX-OFF-${TS}`, `cx-off-${TS}`]));
  orgA1 = await makeOrg(N.a1, tenantA);
  orgA2 = await makeOrg(N.a2, tenantA);
  orgB1 = await makeOrg(N.b1, tenantB);
  await makeOrg(N.twin, tenantA);
  await makeOrg(` ${N.twin.toUpperCase()} `, tenantA);           // same name after trim + case → ambiguous
  await makeDept(orgA1, 'IT'); await makeDept(orgA1, 'Ops'); await makeDept(orgA2, 'IT'); await makeDept(orgB1, 'IT');
  await makeLoc(orgA1, 'Bengaluru'); await makeLoc(orgA2, 'Chennai');
  adminA      = await makeUser(`cx-admin-a-${TS}@test.local`, 'ADMIN', tenantA);
  adminB      = await makeUser(`cx-admin-b-${TS}@test.local`, 'ADMIN', tenantB);
  operatorA   = await makeUser(`cx-op-a-${TS}@test.local`, 'OPERATOR', tenantA);
  supervisorA = await makeUser(`cx-sup-a-${TS}@test.local`, 'SUPERVISOR', tenantA);
  superAdmin  = await makeUser(`cx-super-${TS}@test.local`, 'SUPER_ADMIN', null);
});

afterAll(async () => {
  await query(`DELETE FROM emergency_contacts WHERE organization_id = ANY($1::int[])`, [orgIds]);
  await query(`DELETE FROM departments WHERE organization_id = ANY($1::int[])`, [orgIds]);
  await query(`DELETE FROM locations WHERE organization_id = ANY($1::int[])`, [orgIds]);
  await query(`DELETE FROM organizations WHERE id = ANY($1::int[])`, [orgIds]);
  if (userIds.length) await query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  await query(`DELETE FROM tenants WHERE id = ANY($1::int[])`, [[tenantA, tenantB, tenantOff].filter(Boolean)]);
});

// ── templates ─────────────────────────────────────────────────────────────────

describe('CX-1: Excel template', () => {
  let res;
  let zip;
  beforeAll(async () => { res = await getTemplate(adminA, 'xlsx'); zip = readZip(res.body); });

  it('is an .xlsx download', () => {
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="emergency-contacts-template.xlsx"');
  });

  it('has the "Emergency Contacts" sheet first and an "Instructions" sheet', () => {
    const wb = zip.read('xl/workbook.xml').toString();
    expect([...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(['Emergency Contacts', 'Instructions']);
  });

  it('has the ten columns in order and the four example rows exactly', () => {
    const sheet = readXlsx(res.body, { sheetName: 'Emergency Contacts' });
    expect(sheet.rows[0].values).toEqual(['first_name', 'last_name', 'mobile_number', 'extension_number', 'email',
      'role', 'organization', 'department', 'location', 'is_active']);
    expect(sheet.rows.slice(1).map((r) => r.values)).toEqual([
      ['User1', 'Test', '1000', '1000', '', 'IT', 'Default Organization', 'IT', '', 'true'],
      ['User2', 'Test', '1001', '1001', '', '', 'Default Organization', 'IT', '', 'true'],
      ['User3', 'Test', '1002', '1002', '', 'Security', 'Default Organization', 'IT', 'Bengaluru', 'true'],
      ['User4', 'Test', '1003', '1003', '', '', 'Default Organization', 'IT', '', 'true'],
    ]);
    expect(sheet.rows.slice(1).every((r) => r.formulas.length === 0)).toBe(true);
  });

  it('formats mobile_number / extension_number as text, offers an is_active drop-down, freezes and filters the header', () => {
    const styles = zip.read('xl/styles.xml').toString();
    const sheet = zip.read('xl/worksheets/sheet1.xml').toString();
    expect(styles).toContain('<xf numFmtId="49"');                                    // built-in "Text" format
    expect(sheet).toMatch(/<col min="3" max="3" width="\d+" style="10"/);              // mobile_number column
    expect(sheet).toMatch(/<col min="4" max="4" width="\d+" style="10"/);              // extension_number column
    expect(sheet).toMatch(/<c r="C2" s="10" t="inlineStr"><is><t xml:space="preserve">1000<\/t>/);
    expect(sheet).toContain('<dataValidation type="list"');
    expect(sheet).toContain('sqref="J2:J10001"');
    expect(sheet).toContain('<formula1>&quot;true,false&quot;</formula1>');
    expect(sheet).toContain('<ignoredError sqref="C2:D10001" numberStoredAsText="1"/>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:J5"/>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).not.toMatch(/created_at|updated_at|tenant/);
  });

  it('explains every rule on the Instructions sheet', () => {
    const text = readXlsx(res.body, { sheetName: 'Instructions' }).rows.map((r) => r.values.join(' ')).join('\n');
    for (const rule of [
      'Enter one contact per row', 'Do not rename or remove the column headers', 'first_name and last_name are mandatory',
      'At least one of mobile_number or extension_number is mandatory', 'organization is mandatory',
      'Department and location must belong to the selected organization', 'Email is optional', 'Role is optional',
      'is_active accepts true/false, yes/no, and 1/0', 'Leave optional fields blank when not applicable',
      'sample records', 'Remove the sample rows before uploading actual records',
      'Do not enter created_at or updated_at',
    ]) expect(text, rule).toContain(rule);
  });
});

describe('CX-2: CSV template', () => {
  it('has a UTF-8 BOM, CRLF line ends and the same header and example rows', async () => {
    const res = await getTemplate(adminA, 'csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="emergency-contacts-template.csv"');
    const text = res.body.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xFEFF);
    expect(text).toContain('\r\n');
    const rows = parse(text, { bom: true });
    expect(rows[0]).toEqual(IMPORT_FIELDS);
    expect(rows.slice(1)).toEqual(TEMPLATE_EXAMPLES.map((e) => IMPORT_FIELDS.map((f) => e[f])));
  });
});

describe('CX-3: template access', () => {
  it('SUPER_ADMIN and ADMIN may download; OPERATOR and SUPERVISOR may not; unknown format → 400', async () => {
    expect((await getTemplate(superAdmin, 'xlsx')).status).toBe(200);
    expect((await getTemplate(superAdmin, 'csv', { tenant_id: tenantA })).status).toBe(200);
    expect((await getTemplate(adminB, 'xlsx')).status).toBe(200);
    expect((await getTemplate(operatorA, 'xlsx')).status).toBe(403);
    expect((await getTemplate(supervisorA, 'csv')).status).toBe(403);
    expect((await getTemplate(adminA, 'pdf')).status).toBe(400);
  });

  it('contains no tenant data: every caller gets the same content', async () => {
    const values = async (t) => readXlsx((await getTemplate(t, 'xlsx')).body).rows.map((r) => r.values);
    const a = await values(adminA);
    expect(await values(adminB)).toEqual(a);
    expect(await values(superAdmin)).toEqual(a);
    const csv = async (t) => (await getTemplate(t, 'csv')).body.toString('utf8');
    expect(await csv(adminB)).toBe(await csv(adminA));
  });
});

describe('CX-4: template example rows', () => {
  it('an unchanged template (Excel or CSV) imports nothing: every example row is rejected', async () => {
    for (const [format, filename] of [['xlsx', 'template.xlsx'], ['csv', 'template.csv']]) {
      const file = (await getTemplate(adminA, format)).body;
      const res = await upload(adminA, file, { filename, mode: 'commit' });
      expect(res.status, format).toBe(200);
      expect(res.body, format).toMatchObject({ total: 4, inserted: 0, invalid: 4 });
      expect(res.body.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
      expect(res.body.errors.every((e) => e.error === 'This is an example row from the template; remove it before importing')).toBe(true);
    }
  });

  it('a real contact that only resembles an example row is imported', async () => {
    orgDefault = await makeOrg('Default Organization', tenantA);
    await makeDept(orgDefault, 'IT');
    const file = workbook([IMPORT_FIELDS,
      row(TEMPLATE_EXAMPLES[0]),                                   // unchanged → rejected
      row({ ...TEMPLATE_EXAMPLES[0], role: 'Operations' }),        // one value differs → a real contact
    ]);
    const res = await upload(adminA, file, { mode: 'commit' });
    expect(res.body).toMatchObject({ total: 2, inserted: 1, invalid: 1 });
    expect(res.body.errors[0]).toEqual({ line: 2, error: 'This is an example row from the template; remove it before importing' });
  });
});

// ── Excel import ──────────────────────────────────────────────────────────────

describe('CX-5: Excel import', () => {
  it('imports compressed workbooks with shared and inline strings, numbers, booleans and empty rows', async () => {
    const file = workbook({
      1: IMPORT_FIELDS,
      2: row({ first_name: 'Ann', last_name: 'One', mobile_number: '0501234567', email: 'ann@cx.test', role: 'Guard', organization: N.a1, department: 'IT', location: 'Bengaluru', is_active: 'yes' }),
      // row 3 is empty
      4: row({ first_name: 'Ben', last_name: 'Two', mobile_number: { n: '966501234567' }, extension_number: { n: '1002' }, organization: N.a2, department: 'IT', location: 'Chennai', is_active: { b: false } }),
      5: row({ first_name: 'Cy', last_name: 'Three', mobile_number: { n: '9.66501234567E+11' }, organization: N.a1, is_active: { n: '0' } }),
      6: row({ first_name: 'Dee', last_name: 'Four', mobile_number: { inline: '12345678901234567890' }, organization: N.a1 }),
      7: row({ first_name: ' Eve ', last_name: ' Five ', mobile_number: ' 0507 ', organization: ` ${N.a2.toUpperCase()} `, department: ' it ', is_active: 'TRUE' }),
    });
    const res = await upload(adminA, file, { mode: 'commit' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ format: 'xlsx', total: 5, inserted: 5, invalid: 0, skipped: 0, errors: [], duplicates: [] });

    const { rows } = await query(
      `SELECT c.first_name, c.last_name, c.mobile_number, c.extension_number, c.is_active, c.organization_id,
              d.name AS dept, l.name AS loc
       FROM emergency_contacts c LEFT JOIN departments d ON d.id = c.department_id LEFT JOIN locations l ON l.id = c.location_id
       WHERE c.organization_id = ANY($1::int[]) AND c.last_name IN ('One','Two','Three','Four','Five') ORDER BY c.last_name`,
      [[orgA1, orgA2]]);
    const by = Object.fromEntries(rows.map((r) => [r.last_name, r]));
    expect(by.One).toMatchObject({ mobile_number: '0501234567', is_active: true, organization_id: orgA1, dept: 'IT', loc: 'Bengaluru' });
    expect(by.Two).toMatchObject({ mobile_number: '966501234567', extension_number: '1002', is_active: false, organization_id: orgA2, dept: 'IT', loc: 'Chennai' });
    expect(by.Three).toMatchObject({ mobile_number: '966501234567', is_active: false, organization_id: orgA1, dept: null });
    expect(by.Four).toMatchObject({ mobile_number: '12345678901234567890', is_active: true });
    expect(by.Five).toMatchObject({ first_name: 'Eve', mobile_number: '0507', organization_id: orgA2, dept: 'IT' });
  });

  it('reads the sheet named "Emergency Contacts" even when it is not the first one', async () => {
    const notes = { name: 'Notes', xml: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>just notes</t></is></c></row></sheetData></worksheet>' };
    const file = workbook([IMPORT_FIELDS, row({ first_name: 'Sheet', last_name: 'Second', mobile_number: '0511', organization: N.a1 })], { before: notes, inline: true });
    const res = await upload(adminA, file);
    expect(res.body).toMatchObject({ preview: true, total: 1, valid: 1 });
  });
});

describe('CX-6: row validation (preview writes nothing)', () => {
  it('reports one readable message per problem, with spreadsheet row numbers', async () => {
    const before = await countTenant(tenantA);
    const base = { first_name: 'Val', last_name: 'Row', mobile_number: '0599', organization: N.a1 };
    const cells = row(base);
    const stray = [...row({ ...base, last_name: 'Stray' }), 'note'];
    const file = workbook({
      1: IMPORT_FIELDS,
      2: row({ ...base, first_name: '' }),
      3: row({ ...base, mobile_number: '' }),
      4: row({ ...base, organization: 'Nope' }),
      5: row({ ...base, organization: N.b1 }),
      6: row({ ...base, organization: N.twin }),
      7: row({ ...base, organization: N.a2, department: 'Ops' }),
      8: row({ ...base, location: 'Chennai' }),
      9: row({ ...base, organization: '' }),
      10: row({ ...base, is_active: 'maybe' }),
      11: row({ ...base, first_name: { f: 'CONCAT("V","al")', v: 'Val' } }),
      12: row({ ...base, role: { e: '#N/A' } }),
      13: stray,
      14: row({ ...base, email: 'not-an-email' }),
      16: cells,
    });
    const res = await upload(adminA, file);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ preview: true, total: 14, valid: 1, invalid: 13, inserted: 0 });
    expect(res.body.errors).toEqual([
      { line: 2, error: 'First name is required' },
      { line: 3, error: 'Both mobile number and extension number are empty' },
      { line: 4, error: 'Organization not found' },
      { line: 5, error: 'Organization not found' },
      { line: 6, error: 'Organization name matches more than one organization' },
      { line: 7, error: 'Department does not belong to the specified organization' },
      { line: 8, error: 'Location does not belong to the specified organization' },
      { line: 9, error: 'Organization is required' },
      { line: 10, error: 'Status (is_active) must be true/false, yes/no or 1/0' },
      { line: 11, error: 'First name contains a formula; enter the value itself' },
      { line: 12, error: 'Role contains a spreadsheet error value' },
      { line: 13, error: 'Column K has a value but no column heading' },
      { line: 14, error: 'Email is not a valid email address' },
    ]);
    expect(await countTenant(tenantA)).toBe(before);
  });
});

describe('CX-7: header errors', () => {
  it('missing or repeated required columns are refused with a clear message', async () => {
    const noLast = await upload(adminA, workbook([['first_name', 'mobile_number', 'organization'], ['A', '1', N.a1]]));
    expect(noLast.status).toBe(400);
    expect(noLast.body.error).toMatch(/Missing required column: last_name/);
    const noPhone = await upload(adminA, 'first_name,last_name,organization\nA,B,X\n', { filename: 'c.csv' });
    expect(noPhone.status).toBe(400);
    expect(noPhone.body.error).toMatch(/mobile_number or extension_number/);
    const twice = await upload(adminA, 'first_name,last_name,mobile_number,email,Email,organization\nA,B,1,,,X\n', { filename: 'c.csv' });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toMatch(/email appears more than once/);
  });
});

describe('CX-8: malformed, hostile and unsupported files', () => {
  const valid = () => workbookParts([IMPORT_FIELDS, row({ first_name: 'Z', last_name: 'Z', mobile_number: '1', organization: N.a1 })]);
  const expect400 = async (file, filename, pattern, status = 400) => {
    const res = await upload(adminA, file, { filename });
    expect(res.status, String(pattern)).toBe(status);
    expect(res.body.error, String(pattern)).toMatch(pattern);
  };

  it('refuses files that are not .xlsx or .csv, or whose name and content disagree', async () => {
    await expect400(Buffer.from('%PDF-1.4 ...'), 'contacts.pdf', /Files of type \.pdf are not supported/);
    await expect400(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0]), 'old.xlsx', /old Excel \(\.xls\) or password-protected/);
    await expect400(Buffer.from('not a zip at all'), 'contacts.xlsx', /named \.xlsx but is not an Excel workbook/);
    await expect400(workbook([IMPORT_FIELDS]), 'contacts.csv', /named \.csv but contains a workbook/);
    await expect400(Buffer.from([0x61, 0x00, 0x62, 0x00]), 'contacts.csv', /not supported/);
    await expect400(Buffer.alloc(0), 'contacts.csv', /The upload could not be read|file is empty|A file is required/);
  });

  it('refuses malformed workbooks', async () => {
    const good = zipOf(valid());
    await expect400(good.subarray(0, good.length - 40), 'c.xlsx', /not a valid Excel workbook/);
    await expect400(zipOf([['readme.txt', 'hello']]), 'c.xlsx', /not a valid Excel workbook/);
    await expect400(zipOf(valid(), { crcs: { 'xl/worksheets/sheet1.xml': 12345 } }), 'c.xlsx', /corrupt/);
    await expect400(zipOf(valid(), { flags: { 'xl/workbook.xml': 1 } }), 'c.xlsx', /Encrypted/);
    await expect400(zipOf(valid(), { methods: { 'xl/workbook.xml': 12 } }), 'c.xlsx', /unsupported compression method/);
    await expect400(zipOf([...valid(), ['../evil.xml', '<x/>']]), 'c.xlsx', /unsafe file path/);
    const unclosed = workbookParts([IMPORT_FIELDS]);
    unclosed[4] = ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c>'];
    await expect400(zipOf(unclosed), 'c.xlsx', /not a valid Excel workbook/);
  });

  it('refuses macro-enabled workbooks and XML document type declarations', async () => {
    await expect400(workbook([IMPORT_FIELDS], { contentTypesExtra: '<Override PartName="/x.bin" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>' }), 'c.xlsx', /Macro-enabled/);
    await expect400(workbook([IMPORT_FIELDS], { sheetPrefix: '<!DOCTYPE x [<!ENTITY a "aaaaaaaa">]>' }), 'c.xlsx', /document type declaration/);
  });

  it('stops zip bombs and oversized archives before inflating them', async () => {
    const parts = valid();
    // a part that inflates to far more than it declares
    const bomb = [...parts.slice(0, 4), ['xl/worksheets/sheet1.xml', Buffer.alloc(20 * 1024 * 1024)], ...parts.slice(5)];
    await expect400(zipOf(bomb, { sizes: { 'xl/worksheets/sheet1.xml': 1000 } }), 'c.xlsx', /corrupt or larger than declared/);
    await expect400(zipOf(parts, { sizes: { 'xl/worksheets/sheet1.xml': 65 * 1024 * 1024 } }), 'c.xlsx', /larger than 64 MB uncompressed/, 413);
    await expect400(zipOf([...parts, ['a.xml', 'a'], ['b.xml', 'b'], ['c.xml', 'c']],
      { sizes: { 'a.xml': 50 * 1024 * 1024, 'b.xml': 50 * 1024 * 1024, 'c.xml': 50 * 1024 * 1024 } }), 'c.xlsx', /larger than 128 MB uncompressed/, 413);
    const many = [...parts, ...Array.from({ length: 201 - parts.length }, (_, i) => [`x/p${i}.xml`, 'x'])];
    await expect400(zipOf(many), 'c.xlsx', /more than 200 parts/, 413);
  });

  it('rejects unterminated XML quickly (linear scanning, no runaway CPU)', async () => {
    const parts = workbookParts([IMPORT_FIELDS]);
    parts[4] = ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${'<row r="1"><c r="A1">'.repeat(150000)}</sheetData></worksheet>`];
    const t0 = Date.now();
    await expect400(zipOf(parts), 'c.xlsx', /not a valid Excel workbook/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('CX-9: file size and row limits', () => {
  it('a file over 5 MB is refused with 413', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 'a');
    const res = await upload(adminA, big, { filename: 'big.csv' });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('The file is larger than 5 MB');
  });

  it('more than 10,000 data rows are refused for CSV and Excel; exactly 10,000 are accepted', async () => {
    const csvRows = (n) => `first_name,last_name,mobile_number\n${Array.from({ length: n }, (_, i) => `R,${i},${i}`).join('\n')}\n`;
    const over = await upload(adminA, csvRows(10001), { filename: 'rows.csv', org: orgA1 });
    expect(over.status).toBe(413);
    expect(over.body.error).toMatch(/more than 10000 data rows/);
    const ok = await upload(adminA, csvRows(10000), { filename: 'rows.csv', org: orgA1 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ preview: true, total: 10000 });
    const xlsxOver = workbook([['first_name', 'last_name', 'mobile_number'], ...Array.from({ length: 10001 }, (_, i) => ['R', String(i), String(i)])], { inline: true });
    const xo = await upload(adminA, xlsxOver, { org: orgA1 });
    expect(xo.status).toBe(413);
    expect(xo.body.error).toMatch(/more than 10000 data rows/);
  });
});

describe('CX-10: duplicate detection', () => {
  it('existing contacts, repeats within the file and other organizations — preview and commit agree', async () => {
    const file = workbook([IMPORT_FIELDS,
      row({ first_name: 'ann', last_name: 'ONE', mobile_number: '050-123-4567', organization: N.a1 }),   // exists (CX-5)
      row({ first_name: 'Gus', last_name: 'Six', mobile_number: '0509', organization: N.a1 }),
      row({ first_name: 'gus', last_name: 'six', mobile_number: '0509', organization: N.a1 }),             // repeat of row 3
      row({ first_name: 'Gus', last_name: 'Six', mobile_number: '0509', organization: N.a2 }),             // other organization
    ]);
    const preview = await upload(adminA, file);
    expect(preview.body).toMatchObject({ total: 4, valid: 2, skipped: 2 });
    expect(preview.body.duplicates).toEqual([{ line: 2, reason: 'Contact already exists' }, { line: 4, reason: 'Same contact as row 3' }]);
    const commit = await upload(adminA, file, { mode: 'commit' });
    expect(commit.body).toMatchObject({ total: 4, inserted: 2, skipped: 2, duplicates: preview.body.duplicates });
    const again = await upload(adminA, file);
    expect(again.body).toMatchObject({ valid: 0, skipped: 4 });
  });
});

describe('CX-11: tenant isolation and SUPER_ADMIN', () => {
  const one = (organization, extra = {}) => workbook([IMPORT_FIELDS, row({ first_name: 'Ten', last_name: `Ant${TS}`, mobile_number: '0700', organization, ...extra })]);

  it('a tenant ADMIN resolves names only in its own tenant; a tenant_id field is ignored', async () => {
    const res = await upload(adminA, one(N.b1), { tenant: tenantB });
    expect(res.body.errors).toEqual([{ line: 2, error: 'Organization not found' }]);
    const resB = await upload(adminB, one(N.a1));
    expect(resB.body.errors).toEqual([{ line: 2, error: 'Organization not found' }]);
    expect((await upload(adminB, one(N.b1))).body).toMatchObject({ valid: 1 });
  });

  it('SUPER_ADMIN under All Tenants must choose the target tenant explicitly', async () => {
    const res = await upload(superAdmin, one(N.a1));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Select the target tenant/);
  });

  it('SUPER_ADMIN with an explicit / selected tenant imports into that tenant only', async () => {
    const intoB = await upload(superAdmin, one(N.b1), { tenant: tenantB, mode: 'commit' });
    expect(intoB.body).toMatchObject({ inserted: 1 });
    const { rows: [c] } = await query(`SELECT organization_id FROM emergency_contacts WHERE last_name = $1`, [`Ant${TS}`]);
    expect(c.organization_id).toBe(orgB1);
    expect((await upload(superAdmin, one(N.b1), { tenant: tenantA })).body.errors).toEqual([{ line: 2, error: 'Organization not found' }]);
    const off = await upload(superAdmin, one(N.a1), { tenant: tenantOff });
    expect(off.status).toBe(400);
    expect(off.body.error).toMatch(/Tenant not found or inactive/);
    expect((await upload(superAdmin, one(N.a1), { tenant: 'abc' })).status).toBe(400);
  });

  it('older CSV files without an organization column keep using the organization chosen in the dialog', async () => {
    const csv = 'first_name,last_name,mobile_number\nLeg,Acy CX,0711\n';
    const res = await upload(superAdmin, csv, { filename: 'old.csv', org: orgB1, mode: 'commit' });
    expect(res.body).toMatchObject({ inserted: 1 });
    const none = await upload(adminA, csv, { filename: 'old.csv' });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/Choose the organization for this file/);
    expect((await upload(adminA, csv, { filename: 'old.csv', org: orgB1 })).status).toBe(404);   // another tenant's organization
  });

  it('OPERATOR and SUPERVISOR may not import', async () => {
    expect((await upload(operatorA, one(N.a1))).status).toBe(403);
    expect((await upload(supervisorA, one(N.a1))).status).toBe(403);
  });
});

describe('CX-12: audit records', () => {
  it('a commit writes one summary per organization (format, counts; no personal data); a preview writes none', async () => {
    const file = workbook([IMPORT_FIELDS,
      row({ first_name: 'Aud', last_name: 'One', mobile_number: '0801', organization: N.a1 }),
      row({ first_name: 'Aud', last_name: 'Two', mobile_number: '0802', organization: N.a2 }),
      row({ first_name: 'Aud', last_name: 'Three', mobile_number: '0803', organization: 'Missing Org' }),
    ]);
    let since = await lastAuditId();
    await upload(adminA, file);
    expect(await importAudits(since)).toEqual([]);

    since = await lastAuditId();
    await upload(adminA, file, { mode: 'commit' });
    const rows = await importAudits(since);
    expect(rows.map((r) => r.details.organization_id)).toEqual([orgA1, orgA2, null]);
    expect(rows[0].details).toEqual({ role: 'ADMIN', scope_tenant_id: tenantA, tenant_id: tenantA, organization_id: orgA1,
      format: 'xlsx', total_rows: 1, inserted: 1, skipped_duplicates: 0, error_rows: 0, file_rows: 3 });
    expect(rows[2].details).toMatchObject({ organization_id: null, total_rows: 1, inserted: 0, error_rows: 1 });
    const text = JSON.stringify(rows);
    for (const s of ['Aud', '0801', '0802', 'Missing Org', N.a1]) expect(text).not.toContain(s);
  });
});

describe('CX-13: spreadsheet-formula text', () => {
  it('a value that looks like a formula is stored as text and neutralised on export', async () => {
    const file = workbook([IMPORT_FIELDS, row({ first_name: 'Form', last_name: `Ula${TS}`, mobile_number: '0901', role: '=1+1', organization: N.a1 })]);
    expect((await upload(adminA, file, { mode: 'commit' })).body).toMatchObject({ inserted: 1 });
    const { rows: [c] } = await query(`SELECT role FROM emergency_contacts WHERE last_name = $1`, [`Ula${TS}`]);
    expect(c.role).toBe('=1+1');
    const exp = await request(server).get('/api/v1/contacts/export').query({ search: `Ula${TS}` }).set(auth(adminA)).buffer(true).parse(binary);
    const rows = parse(exp.body.toString('utf8'), { columns: true, bom: true });
    expect(rows[0].role).toBe("'=1+1");
  });
});
