// Playback/download links must use scoped signatures, never the session token.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

vi.mock('../api/client.js', () => ({
  BASE: '/enrs/api/v1',
  api: {
    mediaLibrary: { access: vi.fn(async (id, purpose) => ({ sig: `m.${id}.${purpose}`, purpose, expires_in: 3600 })) },
    recordings:   { access: vi.fn(async (id, purpose) => ({ sig: `r.${id}.${purpose}`, purpose, expires_in: 3600 })) },
  },
}));

const { signedMediaUrl, fetchMediaUrl } = await import('../api/mediaAccess.js');
const { api } = await import('../api/client.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..');

describe('signed media URLs', () => {
  it('keeps the deployment sub-path prefix and targets the right endpoint', () => {
    expect(signedMediaUrl('media', 7, 'stream', 'abc')).toBe('/enrs/api/v1/media-library/7/stream?sig=abc');
    expect(signedMediaUrl('recording', 9, 'download', 'a+b/c')).toBe('/enrs/api/v1/recordings/9/download?sig=a%2Bb%2Fc');
  });
  it('rejects unknown resource kinds', () => {
    expect(() => signedMediaUrl('users', 1, 'stream', 'x')).toThrow();
  });
  it('requests a signature for exactly the file and purpose being used', async () => {
    expect(await fetchMediaUrl('media', 7, 'download')).toBe('/enrs/api/v1/media-library/7/download?sig=m.7.download');
    expect(api.mediaLibrary.access).toHaveBeenCalledWith(7, 'download');
    expect(await fetchMediaUrl('recording', 3)).toBe('/enrs/api/v1/recordings/3/stream?sig=r.3.stream');
    expect(api.recordings.access).toHaveBeenCalledWith(3, 'stream');
  });
});

describe('no session token in URLs (source guard)', () => {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (name === '__tests__' || name === 'node_modules') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?)$/.test(name)) files.push(p);
    }
  })(SRC);

  it('no UI code builds ?token= media URLs or uses the removed URL builders', () => {
    const offenders = files.filter(f => {
      const s = readFileSync(f, 'utf8');
      return /[?&]token=/.test(s) || /\.(streamUrl|downloadUrl|waveformUrl)\(/.test(s);
    }).map(f => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
