/**
 * Sprint B1 — Internal API Integration Tests
 *
 * Requires:
 *   DB_HOST / DB_NAME / DB_USER / DB_PASSWORD pointing to fs_enrs_test
 *   INTERNAL_API_KEY=test-internal-key-32charmin
 *   NODE_ENV=test
 *
 * Run: NODE_ENV=test INTERNAL_API_KEY=test-internal-key-32charmin npm test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';

// Set env before app import
process.env.INTERNAL_API_KEY = 'test-internal-key-32charmin';
process.env.NODE_ENV = 'test';

import server from '../../../server.js';
import { query, pool } from '../../db/pool.js';

const KEY = 'test-internal-key-32charmin';
const BAD = 'wrong-key';

// ── Test fixtures ─────────────────────────────────────────────────────────────

let tenantId, orgId, ensConfigId, ersConfigId;
let ensGroupId, ersGroupId, ensContactId, ersResponderId;
let notifUuid, incidentUuid;

async function seed() {
  // Tenant
  const { rows: [t] } = await query(
    `INSERT INTO tenants (name, code) VALUES ('Test Tenant B1', 'TB1')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`
  );
  tenantId = t.id;

  // Organization
  const { rows: [o] } = await query(
    `INSERT INTO organizations (tenant_id, name, code, is_active)
     VALUES ($1, 'Test Org B1', 'TB1ORG', true)
     ON CONFLICT DO NOTHING RETURNING id`,
    [tenantId]
  );
  orgId = o?.id;
  if (!orgId) {
    const { rows: [ex] } = await query(
      `SELECT id FROM organizations WHERE code = 'TB1ORG'`
    );
    orgId = ex.id;
  }

  // ENS Contact — resolveEnsContacts() in ensInternalController.js reads
  // exclusively from emergency_contacts (direct via
  // ens_configuration_contacts.emergency_contact_id, or group-based via
  // responder_group_members + ens_configuration_groups.responder_group_id).
  // ens_contacts/ens_groups/ens_group_members are a dead, superseded
  // subsystem no application controller queries — seeding into them here
  // used to silently test nothing real; a blast against this config would
  // always resolve zero destinations regardless of what the test asserted.
  const { rows: [ec] } = await query(
    `INSERT INTO emergency_contacts (organization_id, first_name, last_name, mobile_number, is_active)
     VALUES ($1, 'Alice', 'Test', '0501110001', true)
     ON CONFLICT DO NOTHING RETURNING id`,
    [orgId]
  );
  ensContactId = ec?.id;
  if (!ensContactId) {
    const r = await query(`SELECT id FROM emergency_contacts WHERE mobile_number = '0501110001'`);
    ensContactId = r.rows[0].id;
  }

  // ENS Group — responder_groups is the active group table; ens_groups is
  // the same dead subsystem as ens_contacts (see above).
  const { rows: [eg] } = await query(
    `INSERT INTO responder_groups (organization_id, name, is_active)
     VALUES ($1, 'Test ENS Group', true) RETURNING id`,
    [orgId]
  );
  ensGroupId = eg.id;
  await query(
    `INSERT INTO responder_group_members (responder_group_id, emergency_contact_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [ensGroupId, ensContactId]
  );

  // ENS Configuration
  const { rows: [en] } = await query(
    `INSERT INTO ens_configurations
       (organization_id, name, destination_number, blast_clid, reply_clid,
        retry_count, retry_delay_seconds, max_concurrent, recording_retention_hours, is_active)
     VALUES ($1, 'Test ENS', '1200', '9995', '9996', 2, 60, 50, 24, true)
     RETURNING id`,
    [orgId]
  );
  ensConfigId = en.id;

  // Link group to ENS config via responder_group_id — the column
  // resolveEnsContacts() actually joins on (ens_group_id is dead).
  await query(
    `INSERT INTO ens_configuration_groups (ens_configuration_id, responder_group_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [ensConfigId, ensGroupId]
  );

  // ERS Responder
  const { rows: [er] } = await query(
    `INSERT INTO ers_responders (organization_id, first_name, last_name, mobile_number, is_active)
     VALUES ($1, 'Bob', 'Responder', '0502220001', true)
     ON CONFLICT DO NOTHING RETURNING id`,
    [orgId]
  );
  ersResponderId = er?.id;
  if (!ersResponderId) {
    const r = await query(`SELECT id FROM ers_responders WHERE mobile_number = '0502220001'`);
    ersResponderId = r.rows[0].id;
  }

  // ERS Responder Group
  const { rows: [erg] } = await query(
    `INSERT INTO ers_responder_groups (organization_id, name, is_active)
     VALUES ($1, 'Test ERS Group', true) RETURNING id`,
    [orgId]
  );
  ersGroupId = erg.id;
  await query(
    `INSERT INTO ers_responder_group_members (group_id, responder_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [ersGroupId, ersResponderId]
  );

  // ERS Configuration
  const { rows: [ers] } = await query(
    `INSERT INTO ers_configurations
       (organization_id, name, emergency_number, rejoin_number, open_access_number,
        conference_room_prefix, primary_ers_group_id, max_concurrent_conferences,
        queue_enabled, record_conferences, is_active)
     VALUES ($1, 'Test ERS', '1222', '1223', '1224', 'ers_test', $2, 2, true, true, true)
     RETURNING id`,
    [orgId, ersGroupId]
  );
  ersConfigId = ers.id;
}

async function cleanup() {
  // Delete in reverse FK order
  await query(`DELETE FROM ers_incident_responders WHERE ers_incident_id IN (
    SELECT id FROM ers_incidents WHERE ers_configuration_id = $1)`, [ersConfigId]);
  await query(`DELETE FROM ers_incidents WHERE ers_configuration_id = $1`, [ersConfigId]);
  await query(`DELETE FROM ers_queues WHERE ers_configuration_id = $1`, [ersConfigId]);
  await query(`DELETE FROM ers_responder_group_members WHERE group_id = $1`, [ersGroupId]);
  await query(`DELETE FROM ers_responder_groups WHERE id = $1`, [ersGroupId]);
  await query(`DELETE FROM ers_responders WHERE id = $1`, [ersResponderId]);
  await query(`DELETE FROM ers_configurations WHERE id = $1`, [ersConfigId]);

  await query(`DELETE FROM ens_notification_deliveries WHERE ens_notification_id IN (
    SELECT id FROM ens_notifications WHERE ens_configuration_id = $1)`, [ensConfigId]);
  await query(`DELETE FROM ens_notifications WHERE ens_configuration_id = $1`, [ensConfigId]);
  await query(`DELETE FROM ens_configuration_groups WHERE ens_configuration_id = $1`, [ensConfigId]);
  await query(`DELETE FROM responder_group_members WHERE responder_group_id = $1`, [ensGroupId]);
  await query(`DELETE FROM responder_groups WHERE id = $1`, [ensGroupId]);
  await query(`DELETE FROM emergency_contacts WHERE id = $1`, [ensContactId]);
  await query(`DELETE FROM ens_configurations WHERE id = $1`, [ensConfigId]);

  await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await seed();
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

// ── Authentication Tests ──────────────────────────────────────────────────────

describe('Internal API — Authentication', () => {
  it('returns 403 when X-Internal-Key is missing', async () => {
    await request(server)
      .get('/api/v1/internal/ens/lookup?number=1200')
      .expect(403);
  });

  it('returns 403 when X-Internal-Key is wrong', async () => {
    await request(server)
      .get('/api/v1/internal/ens/lookup?number=1200')
      .set('X-Internal-Key', BAD)
      .expect(403);
  });

  it('returns 404 (not 401/403) for unknown internal path with correct key', async () => {
    await request(server)
      .get('/api/v1/internal/unknown/path')
      .set('X-Internal-Key', KEY)
      .expect(404);
  });
});

// ── ENS Lookup ────────────────────────────────────────────────────────────────

describe('GET /api/v1/internal/ens/lookup', () => {
  it('resolves a valid destination_number', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ens/lookup?number=1200')
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.configuration_id).toBe(ensConfigId);
    expect(res.body.data.blast_clid).toBe('9995');
    expect(res.body.data.reply_clid).toBe('9996');
    expect(Array.isArray(res.body.data.contacts)).toBe(true);
    expect(res.body.data.contacts).toContain('0501110001');
  });

  it('returns 404 for unknown number', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ens/lookup?number=9999')
      .set('X-Internal-Key', KEY)
      .expect(404);

    expect(res.body.success).toBe(false);
  });

  it('returns 400 when number param is missing', async () => {
    await request(server)
      .get('/api/v1/internal/ens/lookup')
      .set('X-Internal-Key', KEY)
      .expect(400);
  });
});

// ── ENS Queue Status ──────────────────────────────────────────────────────────

describe('GET /api/v1/internal/ens/notifications/queue-status', () => {
  it('returns can_proceed true when no active notification', async () => {
    const res = await request(server)
      .get(`/api/v1/internal/ens/notifications/queue-status?configuration_id=${ensConfigId}`)
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.can_proceed).toBe(true);
    expect(res.body.active_uuid).toBeNull();
  });

  it('returns 400 when configuration_id is missing', async () => {
    await request(server)
      .get('/api/v1/internal/ens/notifications/queue-status')
      .set('X-Internal-Key', KEY)
      .expect(400);
  });
});

// ── ENS Create Notification ───────────────────────────────────────────────────

describe('POST /api/v1/internal/ens/notifications', () => {
  it('creates a notification and returns uuid', async () => {
    const res = await request(server)
      .post('/api/v1/internal/ens/notifications')
      .set('X-Internal-Key', KEY)
      .send({
        configuration_id: ensConfigId,
        triggered_via:    'PHONE',
        caller_number:    '0509999999',
        recording_file:   '/var/lib/freeswitch/recordings/test.wav',
      })
      .expect(201);

    expect(res.body.notification_uuid).toBeTruthy();
    expect(res.body.notification_id).toBeGreaterThan(0);
    notifUuid = res.body.notification_uuid;
  });

  it('rejects invalid triggered_via', async () => {
    await request(server)
      .post('/api/v1/internal/ens/notifications')
      .set('X-Internal-Key', KEY)
      .send({ configuration_id: ensConfigId, triggered_via: 'INVALID' })
      .expect(400);
  });

  it('returns 404 for non-existent configuration_id', async () => {
    await request(server)
      .post('/api/v1/internal/ens/notifications')
      .set('X-Internal-Key', KEY)
      .send({ configuration_id: 99999, triggered_via: 'PHONE' })
      .expect(404);
  });

  it('queue-status returns can_proceed false once notification is IN_PROGRESS', async () => {
    const res = await request(server)
      .get(`/api/v1/internal/ens/notifications/queue-status?configuration_id=${ensConfigId}`)
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.can_proceed).toBe(false);
    expect(res.body.active_uuid).toBe(notifUuid);
  });
});

// ── ENS Pending Contacts ──────────────────────────────────────────────────────

describe('GET /api/v1/internal/ens/notifications/:uuid/pending-contacts', () => {
  it('returns pending contact numbers', async () => {
    const res = await request(server)
      .get(`/api/v1/internal/ens/notifications/${notifUuid}/pending-contacts`)
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(Array.isArray(res.body.contacts)).toBe(true);
    expect(res.body.contacts).toContain('0501110001');
  });

  it('returns 404 for unknown uuid', async () => {
    await request(server)
      .get(`/api/v1/internal/ens/notifications/${uuidv4()}/pending-contacts`)
      .set('X-Internal-Key', KEY)
      .expect(404);
  });
});

// ── ENS Delivery Update ───────────────────────────────────────────────────────

describe('PATCH /api/v1/internal/ens/notifications/:uuid/delivery', () => {
  it('marks a contact as ANSWERED', async () => {
    const res = await request(server)
      .patch(`/api/v1/internal/ens/notifications/${notifUuid}/delivery`)
      .set('X-Internal-Key', KEY)
      .send({
        contact_number: '0501110001',
        status:         'ANSWERED',
        call_uuid:      'test-uuid-123',
        hangup_cause:   'NORMAL_CLEARING',
        answered_at:    new Date().toISOString(),
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('increments total_answered on parent notification', async () => {
    const { rows: [n] } = await query(
      `SELECT total_answered FROM ens_notifications WHERE notification_uuid = $1`,
      [notifUuid]
    );
    expect(n.total_answered).toBeGreaterThan(0);
  });

  it('rejects invalid status value', async () => {
    await request(server)
      .patch(`/api/v1/internal/ens/notifications/${notifUuid}/delivery`)
      .set('X-Internal-Key', KEY)
      .send({ contact_number: '0501110001', status: 'INVALID_STATUS' })
      .expect(400);
  });

  it('marks a different contact as NO_ANSWER', async () => {
    await request(server)
      .patch(`/api/v1/internal/ens/notifications/${notifUuid}/delivery`)
      .set('X-Internal-Key', KEY)
      .send({ contact_number: '0501110002', status: 'NO_ANSWER' })
      .expect(200);
  });
});

// ── ENS Callback Authorize ────────────────────────────────────────────────────

describe('GET /api/v1/internal/ens/callbacks/authorize', () => {
  it('authorizes a caller who was in the blast list', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ens/callbacks/authorize?reply_clid=9996&caller=0501110001')
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.authorized).toBe(true);
    expect(res.body.notification_uuid).toBe(notifUuid);
    expect(res.body.delivery_id).toBeGreaterThan(0);
  });

  it('rejects a caller not in the blast list', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ens/callbacks/authorize?reply_clid=9996&caller=0599999999')
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.authorized).toBe(false);
    expect(res.body.reason).toBe('not_in_blast_list');
  });

  it('rejects unknown reply_clid', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ens/callbacks/authorize?reply_clid=9999&caller=0501110001')
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.authorized).toBe(false);
  });
});

// ── ENS Log Callback ──────────────────────────────────────────────────────────

describe('POST /api/v1/internal/ens/callbacks', () => {
  it('logs a replay and updates delivery to REPLAYED', async () => {
    // Get delivery id first
    const { rows: [del] } = await query(
      `SELECT d.id FROM ens_notification_deliveries d
       JOIN ens_notifications n ON n.id = d.ens_notification_id
       WHERE n.notification_uuid = $1 AND d.contact_number = '0501110001'`,
      [notifUuid]
    );

    const res = await request(server)
      .post('/api/v1/internal/ens/callbacks')
      .set('X-Internal-Key', KEY)
      .send({
        notification_uuid: notifUuid,
        caller_number:     '0501110001',
        reply_clid:        '9996',
        delivery_id:       del.id,
        replayed_at:       new Date().toISOString(),
      })
      .expect(200);

    expect(res.body.ok).toBe(true);

    // Verify status changed to REPLAYED
    const { rows: [updated] } = await query(
      `SELECT delivery_status FROM ens_notification_deliveries WHERE id = $1`,
      [del.id]
    );
    expect(updated.delivery_status).toBe('REPLAYED');
  });
});

// ── ENS Complete ──────────────────────────────────────────────────────────────

describe('POST /api/v1/internal/ens/notifications/:uuid/complete', () => {
  it('marks notification as COMPLETED', async () => {
    await request(server)
      .post(`/api/v1/internal/ens/notifications/${notifUuid}/complete`)
      .set('X-Internal-Key', KEY)
      .send({})
      .expect(200);

    const { rows: [n] } = await query(
      `SELECT status FROM ens_notifications WHERE notification_uuid = $1`,
      [notifUuid]
    );
    expect(n.status).toBe('COMPLETED');
  });

  it('queue-status returns can_proceed true after completion', async () => {
    const res = await request(server)
      .get(`/api/v1/internal/ens/notifications/queue-status?configuration_id=${ensConfigId}`)
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.can_proceed).toBe(true);
  });
});

// ── ERS Lookup ────────────────────────────────────────────────────────────────

describe('GET /api/v1/internal/ers/lookup', () => {
  it('resolves a valid emergency_number', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ers/lookup?number=1222')
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.configuration_id).toBe(ersConfigId);
    expect(Array.isArray(res.body.data.primary_responders)).toBe(true);
    expect(res.body.data.primary_responders).toContain('0502220001');
    expect(res.body.data.queue_enabled).toBe(true);
  });

  it('returns 404 for unknown ERS number', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ers/lookup?number=9999')
      .set('X-Internal-Key', KEY)
      .expect(404);

    expect(res.body.success).toBe(false);
  });
});

// ── ERS Create Incident ───────────────────────────────────────────────────────

describe('POST /api/v1/internal/ers/incidents', () => {
  it('creates an incident and returns uuid', async () => {
    const res = await request(server)
      .post('/api/v1/internal/ers/incidents')
      .set('X-Internal-Key', KEY)
      .send({
        configuration_id: ersConfigId,
        caller_number:    '0509998888',
        caller_name:      'Test Caller',
        conference_room:  'ers_test_primary',
        group_type:       'primary',
        recording_path:   '/var/lib/freeswitch/recordings/ers_test.wav',
        status:           'ACTIVE',
      })
      .expect(201);

    expect(res.body.incident_uuid).toBeTruthy();
    expect(res.body.incident_id).toBeGreaterThan(0);
    incidentUuid = res.body.incident_uuid;
  });

  it('rejects invalid conference_room format', async () => {
    await request(server)
      .post('/api/v1/internal/ers/incidents')
      .set('X-Internal-Key', KEY)
      .send({
        configuration_id: ersConfigId,
        caller_number:    '0509998888',
        conference_room:  'INVALID ROOM NAME!',
        group_type:       'primary',
      })
      .expect(400);
  });

  it('returns 404 for non-existent ERS configuration', async () => {
    await request(server)
      .post('/api/v1/internal/ers/incidents')
      .set('X-Internal-Key', KEY)
      .send({
        configuration_id: 99999,
        caller_number:    '0509998888',
        conference_room:  'ers_test_x',
        group_type:       'primary',
      })
      .expect(404);
  });
});

// ── ERS Responder Update ──────────────────────────────────────────────────────

describe('PATCH /api/v1/internal/ers/incidents/:uuid/responder', () => {
  it('records a JOINED status for a responder', async () => {
    const res = await request(server)
      .patch(`/api/v1/internal/ers/incidents/${incidentUuid}/responder`)
      .set('X-Internal-Key', KEY)
      .send({
        responder_number: '0502220001',
        status:           'JOINED',
        joined_at:        new Date().toISOString(),
        role:             'primary',
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('records a REJOINED status and increments rejoin_count', async () => {
    await request(server)
      .patch(`/api/v1/internal/ers/incidents/${incidentUuid}/responder`)
      .set('X-Internal-Key', KEY)
      .send({ responder_number: '0502220001', status: 'REJOINED' })
      .expect(200);

    const { rows: [r] } = await query(
      `SELECT rejoin_count FROM ers_incident_responders
       WHERE mobile_number = '0502220001'
       AND ers_incident_id = (SELECT id FROM ers_incidents WHERE incident_uuid = $1)`,
      [incidentUuid]
    );
    expect(r.rejoin_count).toBe(1);
  });

  it('returns 404 for unknown incident uuid', async () => {
    await request(server)
      .patch(`/api/v1/internal/ers/incidents/${uuidv4()}/responder`)
      .set('X-Internal-Key', KEY)
      .send({ responder_number: '0502220001', status: 'JOINED' })
      .expect(404);
  });
});

// ── ERS Rejoin Lookup ─────────────────────────────────────────────────────────

describe('GET /api/v1/internal/ers/incidents/rejoin', () => {
  it('authorizes a primary responder', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ers/incidents/rejoin?rejoin_number=1223&caller=0502220001')
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.authorized).toBe(true);
    expect(res.body.role).toBe('primary');
    expect(res.body.incident_uuid).toBe(incidentUuid);
  });

  it('rejects a caller not in any group', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ers/incidents/rejoin?rejoin_number=1223&caller=0599999999')
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.authorized).toBe(false);
    expect(res.body.reason).toBe('not_a_member');
  });

  it('authorizes original caller as initiator', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ers/incidents/rejoin?rejoin_number=1223&caller=0509998888')
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.authorized).toBe(true);
    expect(res.body.role).toBe('initiator');
  });
});

// ── ERS Open Join ─────────────────────────────────────────────────────────────

describe('GET /api/v1/internal/ers/incidents/open-join', () => {
  it('returns conference_room for an active incident', async () => {
    const res = await request(server)
      .get('/api/v1/internal/ers/incidents/open-join?number=1224&caller=0507777777')
      .set('X-Internal-Key', KEY)
      .expect(200);

    expect(res.body.incident_uuid).toBe(incidentUuid);
    expect(res.body.conference_room).toBe('ers_test_primary');
  });

  it('returns 404 for unknown open-access number', async () => {
    await request(server)
      .get('/api/v1/internal/ers/incidents/open-join?number=9999&caller=0507777777')
      .set('X-Internal-Key', KEY)
      .expect(404);
  });
});

// ── ERS Log Observer ──────────────────────────────────────────────────────────

describe('POST /api/v1/internal/ers/incidents/:uuid/observer', () => {
  it('inserts OBSERVER row into ers_incident_responders', async () => {
    const res = await request(server)
      .post(`/api/v1/internal/ers/incidents/${incidentUuid}/observer`)
      .set('X-Internal-Key', KEY)
      .send({
        observer_number: '0507777777',
        joined_via:      '1224',
        joined_at:       new Date().toISOString(),
      })
      .expect(200);

    expect(res.body.ok).toBe(true);

    const { rows: [obs] } = await query(
      `SELECT status, joined_via FROM ers_incident_responders
       WHERE mobile_number = '0507777777'
       AND ers_incident_id = (SELECT id FROM ers_incidents WHERE incident_uuid = $1)`,
      [incidentUuid]
    );
    expect(obs.status).toBe('OBSERVER');
    expect(obs.joined_via).toBe('open_access');
  });
});

// ── ERS Complete Incident ─────────────────────────────────────────────────────

describe('POST /api/v1/internal/ers/incidents/:uuid/complete', () => {
  it('marks incident as COMPLETED and sets ended_at', async () => {
    const res = await request(server)
      .post(`/api/v1/internal/ers/incidents/${incidentUuid}/complete`)
      .set('X-Internal-Key', KEY)
      .send({ recording_file: '/var/lib/freeswitch/recordings/ers_test_final.wav' })
      .expect(200);

    expect(res.body.ok).toBe(true);

    const { rows: [i] } = await query(
      `SELECT status, ended_at FROM ers_incidents WHERE incident_uuid = $1`,
      [incidentUuid]
    );
    expect(i.status).toBe('COMPLETED');
    expect(i.ended_at).not.toBeNull();
  });

  it('returns 404 for unknown incident uuid', async () => {
    await request(server)
      .post(`/api/v1/internal/ers/incidents/${uuidv4()}/complete`)
      .set('X-Internal-Key', KEY)
      .send({})
      .expect(404);
  });

  it('open-join returns 404 after incident is completed', async () => {
    await request(server)
      .get('/api/v1/internal/ers/incidents/open-join?number=1224&caller=0507777777')
      .set('X-Internal-Key', KEY)
      .expect(404);
  });
});

// ── Public ENS router no longer exposes Lua endpoints ────────────────────────

describe('Public ENS router — no Lua leakage', () => {
  it('GET /api/v1/ens/lookup returns 401 (now JWT-protected)', async () => {
    await request(server)
      .get('/api/v1/ens/lookup')
      .expect(401);
  });
});
