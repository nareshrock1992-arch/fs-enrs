/**
 * Scoped media access signatures (middleware/mediaAccess.js).
 * Proves a signature authorises exactly one resource/id/purpose, expires, can
 * never be used as an API bearer token, and that the documented legacy
 * ?token= / Bearer forms still work (backwards compatibility).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

let dbRows = [];
const queries = [];
vi.mock('../../db/pool.js', () => ({
  query: vi.fn(async (sql, params) => { queries.push({ sql, params }); return { rows: dbRows }; }),
  withTransaction: vi.fn(), pool: { connect: vi.fn() },
}));

const { config } = await import('../../config/index.js');
const { signMediaAccess, requireMediaAccess, issueMediaAccess, MEDIA_ACCESS_TTL_SEC } = await import('../../middleware/mediaAccess.js');
const { requireAuth } = await import('../../middleware/auth.js');

const user = { id: 5, role: 'OPERATOR', tenantId: 2 };
const accessJwt = jwt.sign({ id: 5, email: 'op@x', role: 'OPERATOR', tenantId: 2 }, config.jwt.accessSecret, { expiresIn: '15m' });

const app = express();
const echo = (req, res) => res.json({ user: req.user });
app.get('/media/:id/stream',   requireMediaAccess('media', 'stream'), echo);
app.get('/media/:id/download', requireMediaAccess('media', 'download'), echo);
app.get('/rec/:id/stream',     requireMediaAccess('recording', 'stream'), echo);
app.get('/media/:id/access',   (req, res, next) => { req.user = user; next(); }, issueMediaAccess('media'));
app.get('/api/anything',       requireAuth, echo);

describe('scoped media access signatures', () => {
  beforeEach(() => { dbRows = []; queries.length = 0; });

  it('a signature works for exactly its resource, id and purpose', async () => {
    const sig = signMediaAccess({ user, resource: 'media', id: '7', purpose: 'stream' });
    const ok = await request(app).get(`/media/7/stream?sig=${sig}`);
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ id: 5, role: 'OPERATOR', tenantId: 2, viaMediaSignature: true });
    expect((await request(app).get(`/media/8/stream?sig=${sig}`)).status).toBe(401);     // other id
    expect((await request(app).get(`/media/7/download?sig=${sig}`)).status).toBe(401);   // other purpose
    expect((await request(app).get(`/rec/7/stream?sig=${sig}`)).status).toBe(401);       // other resource
  });

  it('an expired or tampered signature is rejected', async () => {
    vi.useFakeTimers({ now: Date.now() });
    const sig = signMediaAccess({ user, resource: 'media', id: '7', purpose: 'stream' });
    vi.setSystemTime(Date.now() + (MEDIA_ACCESS_TTL_SEC + 5) * 1000);
    const expired = await request(app).get(`/media/7/stream?sig=${sig}`);
    vi.useRealTimers();
    expect(expired.status).toBe(401);
    expect(expired.body.error).toBe('Media link expired');
    expect((await request(app).get(`/media/7/stream?sig=${sig.slice(0, -3)}abc`)).status).toBe(401);
  });

  it('a signature can NEVER be used as an API bearer token (derived signing key)', async () => {
    const sig = signMediaAccess({ user, resource: 'media', id: '7', purpose: 'stream' });
    expect((await request(app).get('/api/anything').set('Authorization', `Bearer ${sig}`)).status).toBe(401);
  });

  it('a full session JWT is NOT accepted as a signature', async () => {
    expect((await request(app).get(`/media/7/stream?sig=${accessJwt}`)).status).toBe(401);
  });

  it('backwards compatible: Bearer header and the documented legacy ?token= still work', async () => {
    expect((await request(app).get('/media/7/stream').set('Authorization', `Bearer ${accessJwt}`)).status).toBe(200);
    expect((await request(app).get(`/media/7/stream?token=${accessJwt}`)).status).toBe(200);
    expect((await request(app).get('/media/7/stream')).status).toBe(401);
  });

  it('issuance: tenant-scoped lookup, only for an existing record, no-store, valid purpose only', async () => {
    expect((await request(app).get('/media/7/access')).status).toBe(404);              // not in tenant → no link
    expect(queries[0].params).toEqual(['7', 2]);
    dbRows = [{ id: 7 }];
    const r = await request(app).get('/media/7/access?purpose=download');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ purpose: 'download', expires_in: MEDIA_ACCESS_TTL_SEC });
    expect((await request(app).get(`/media/7/download?sig=${r.body.sig}`)).status).toBe(200);
    expect((await request(app).get('/media/7/access?purpose=delete')).status).toBe(400);
  });
});
