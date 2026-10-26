/**
 * Range validation + Content-Disposition escaping shared by the media and
 * recording stream/download endpoints (utils/mediaHttp.js).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { contentDisposition, sendFileWithRange } from '../../utils/mediaHttp.js';

const BYTES = Buffer.from('0123456789abcdefghij');   // 20 bytes
let dir, filePath;
const app = express();
app.get('/f', (req, res) => sendFileWithRange(req, res, {
  filePath, size: BYTES.length, mime: 'audio/wav', disposition: contentDisposition('inline', 'a.wav'),
}));
app.get('/missing', (req, res) => sendFileWithRange(req, res, {
  filePath: path.join(os.tmpdir(), 'definitely-not-here.wav'), size: 20, mime: 'audio/wav',
}));
const get = (url, range) => {
  const r = request(app).get(url).buffer(true).parse((res, cb) => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return range ? r.set('Range', range) : r;
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mediahttp-'));
  filePath = path.join(dir, 'a.wav');
  await fs.writeFile(filePath, BYTES);
});
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('sendFileWithRange', () => {
  it('no Range → 200 full body with Accept-Ranges', async () => {
    const r = await get('/f');
    expect(r.status).toBe(200);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['content-length']).toBe('20');
    expect(r.body.equals(BYTES)).toBe(true);
  });
  it('valid range → 206 with the exact slice', async () => {
    const r = await get('/f', 'bytes=2-5');
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 2-5/20');
    expect(r.body.toString()).toBe('2345');
  });
  it('open-ended and suffix ranges', async () => {
    expect((await get('/f', 'bytes=15-')).body.toString()).toBe('fghij');
    const s = await get('/f', 'bytes=-3');
    expect(s.status).toBe(206);
    expect(s.body.toString()).toBe('hij');
  });
  it('end past EOF is clamped instead of reading garbage', async () => {
    const r = await get('/f', 'bytes=18-999');
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 18-19/20');
    expect(r.body.toString()).toBe('ij');
  });
  it('unsatisfiable range → 416 with bytes */size', async () => {
    const r = await get('/f', 'bytes=50-60');
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */20');
  });
  it('a bytes range with non-numeric bounds → 416 (previously NaN Content-Range/Length)', async () => {
    const r = await get('/f', 'bytes=abc-def');
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */20');
  });
  it('unparseable / non-bytes / multi-range headers are ignored → 200 full body', async () => {
    for (const h of ['items=0-5', 'bytes=0-1,5-6', 'garbage']) {
      const r = await get('/f', h);
      expect(r.status, h).toBe(200);
      expect(r.body.equals(BYTES), h).toBe(true);
    }
  });
  it('a file read error answers 500 instead of crashing the process', async () => {
    const r = await get('/missing');
    expect(r.status).toBe(500);
  });
});

describe('contentDisposition', () => {
  it('plain names are unchanged', () => {
    expect(contentDisposition('attachment', 'greeting.wav'))
      .toBe(`attachment; filename="greeting.wav"; filename*=UTF-8''greeting.wav`);
  });
  it('quotes, backslashes and CR/LF cannot break out of the header', () => {
    const v = contentDisposition('attachment', 'a"; filename="evil.exe\r\nX-Injected: 1\\.wav');
    expect(v).not.toMatch(/[\r\n]/);
    const ascii = v.match(/filename="([^"]*)"/)[1];
    expect(ascii).not.toMatch(/["\\]/);
    // exactly: one quoted ASCII filename, then one percent-encoded filename* — nothing else
    expect(v).toMatch(/^attachment; filename="[^"\\]*"; filename\*=UTF-8''[A-Za-z0-9%._~!-]*$/);
  });
  it('non-ASCII names keep the exact UTF-8 name in filename*', () => {
    const v = contentDisposition('inline', 'அறிவிப்பு (1).wav');
    expect(v).toMatch(/^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    expect(decodeURIComponent(v.split("UTF-8''")[1])).toBe('அறிவிப்பு (1).wav');
  });
  it('the header value is accepted by Node (no invalid characters)', async () => {
    const a = express();
    a.get('/', (req, res) => { res.set('Content-Disposition', contentDisposition('attachment', 'x"\r\ny.wav')); res.end(); });
    expect((await request(a).get('/')).status).toBe(200);
  });
});
