import { describe, it, expect, vi, beforeEach } from 'vitest';

// The IVR config pickers: a configuration created after the builder loaded must
// appear (no page-load cache), and lists longer than one API page must not be
// truncated silently.
const lists = vi.hoisted(() => ({ ers: vi.fn(), ens: vi.fn() }));
vi.mock('../api/client.js', () => ({ api: { ers: { list: lists.ers }, ens: { list: lists.ens } } }));

import { fetchAllConfigs, loadOptions, PAGE_SIZE } from '../hooks/useConfigOptions.js';

const cfg = (id) => ({ id, name: `C${id}`, description: null, tenant_id: 1 });
const pageOf = (from, n, total) => ({ configurations: Array.from({ length: n }, (_, i) => cfg(from + i)), total });

beforeEach(() => { lists.ers.mockReset(); lists.ens.mockReset(); });

describe('fetchAllConfigs', () => {
  it('requests pages of the API maximum until total is reached', async () => {
    lists.ers
      .mockResolvedValueOnce(pageOf(1, PAGE_SIZE, 450))
      .mockResolvedValueOnce(pageOf(201, PAGE_SIZE, 450))
      .mockResolvedValueOnce(pageOf(401, 50, 450));
    const opts = await fetchAllConfigs(lists.ers);
    expect(opts).toHaveLength(450);
    expect(opts.at(-1)).toEqual({ id: 450, name: 'C450', description: '' });
    expect(lists.ers.mock.calls.map(c => c[0])).toEqual([
      { limit: PAGE_SIZE, page: 1 }, { limit: PAGE_SIZE, page: 2 }, { limit: PAGE_SIZE, page: 3 },
    ]);
  });

  it('makes one request for a short list', async () => {
    lists.ers.mockResolvedValueOnce(pageOf(73, 1, 1));
    expect(await fetchAllConfigs(lists.ers)).toEqual([{ id: 73, name: 'C73', description: '' }]);
    expect(lists.ers).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty page even when total is missing', async () => {
    lists.ens.mockResolvedValueOnce(pageOf(1, PAGE_SIZE)).mockResolvedValueOnce({ configurations: [] });
    expect(await fetchAllConfigs(lists.ens)).toHaveLength(PAGE_SIZE);
    expect(lists.ens).toHaveBeenCalledTimes(2);
  });
});

describe('loadOptions', () => {
  it('refetches on every load, so a newly created configuration appears without a reload', async () => {
    lists.ers.mockResolvedValueOnce(pageOf(1, 1, 1));
    expect((await loadOptions('ers')).map(o => o.id)).toEqual([1]);
    lists.ers.mockResolvedValueOnce({ configurations: [cfg(1), cfg(73)], total: 2 });
    expect((await loadOptions('ers')).map(o => o.id)).toEqual([1, 73]);
  });

  it('shares one request between concurrent pickers', async () => {
    let resolve;
    lists.ens.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const a = loadOptions('ens'); const b = loadOptions('ens');
    resolve(pageOf(5, 1, 1));
    expect(await a).toEqual(await b);
    expect(lists.ens).toHaveBeenCalledTimes(1);
  });

  it('recovers after a failed request', async () => {
    lists.ens.mockRejectedValueOnce(new Error('network'));
    await expect(loadOptions('ens')).rejects.toThrow('network');
    lists.ens.mockResolvedValueOnce(pageOf(9, 1, 1));
    expect((await loadOptions('ens')).map(o => o.id)).toEqual([9]);
  });
});
