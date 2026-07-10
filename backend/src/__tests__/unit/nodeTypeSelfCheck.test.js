import { describe, it, expect, vi, afterEach } from 'vitest';

// No DB dependency — Express routers don't touch the DB at import/mount
// time, only when a request actually hits a handler.

describe('Phase 3 item 4 — node-type registry self-check', () => {
  afterEach(() => { vi.resetModules(); });

  it('reports zero problems for the real registry (every declared apiEndpoint is actually registered)', async () => {
    const { checkNodeTypeApiEndpoints } = await import('../../nodeTypes/selfCheck.js');
    const problems = checkNodeTypeApiEndpoints();
    expect(problems).toEqual([]);
  });

  it('catches a node type whose apiEndpoint points at a route that does not exist', async () => {
    // Regression proof: this is exactly the class of drift that let
    // exec_ers/exec_ens call nonexistent paths (/ers/start, /ens/trigger)
    // for a full day before a real test call surfaced it. Simulate that
    // by mocking the registry with a deliberately broken endpoint.
    vi.doMock('../../nodeTypes/registry.js', () => ({
      NODE_TYPE_REGISTRY: [
        { type: 'ers', apiEndpoint: { method: 'POST', path: '/api/v1/internal/ers/start' } }, // wrong path
      ],
    }));
    const { checkNodeTypeApiEndpoints } = await import('../../nodeTypes/selfCheck.js');
    const problems = checkNodeTypeApiEndpoints();
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain('ers');
    expect(problems[0]).toContain('/ers/start');
  });
});
