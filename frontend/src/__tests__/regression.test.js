import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// Source-content regression checks for UI fixes that don't need a DOM
// render to verify — the bug was either "this field/text literally isn't
// in the source" or "this file references the wrong strings," both of
// which a plain text match on the component source proves directly and
// far more cheaply than mounting the component.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..');

function read(relPath) {
  return readFileSync(path.join(srcRoot, relPath), 'utf8');
}

describe('Phase 1 item 7 — ServiceRegistry IVR Flow dropdown', () => {
  it('has an IVR flow list state, loads it, and renders a select bound to it', () => {
    const src = read('pages/services/ServiceRegistry.jsx');
    expect(src).toMatch(/flowList/);
    expect(src).toMatch(/api\.ivr\.list/);
    expect(src).toMatch(/showIvr\s*=\s*form\.type\s*===\s*'IVR'/);
    expect(src).toMatch(/<select[^>]*value=\{form\.ivr_flow_id\}/s);
  });
});

describe('Phase 1 item 8 — BindNumbersModal hint text', () => {
  it('points the user at Emergency Config → Service Registry, not the old Settings path', () => {
    const src = read('components/ivr/panels/BindNumbersModal.jsx');
    expect(src).toContain('Emergency Config → Service Registry');
    expect(src).not.toContain('Settings → Emergency Numbers');
  });
});
