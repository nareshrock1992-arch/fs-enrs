import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// Regression guard for the "branch/route target dropdown snaps back to the
// placeholder" bug: BranchesMapField had a `Row` component DEFINED INSIDE its
// render body, so React remounted the native <select> every render and the
// selection could not stick. The fix hoists the row to a module-scope
// BranchRow so the <select> reconciles in place.
//
// This is a source-shape guard (the real fix is a rendering behavior that needs
// a DOM to exercise; this cheaply prevents the exact anti-pattern from
// reappearing in this file).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  path.resolve(__dirname, '../components/ivr/panels/PropertyPanel.jsx'),
  'utf8',
);

describe('BranchesMapField — no component defined inside its render body', () => {
  it('BranchRow is declared at module scope (column 0)', () => {
    expect(src).toMatch(/\nfunction BranchRow\(/);
  });

  it('renders rows via <BranchRow>, not a locally-defined component', () => {
    expect(src).toContain('<BranchRow');
    expect(src).not.toContain('const Row =');
  });

  it('contains NO inside-defined component (indented `const X = (...) => (` returning JSX)', () => {
    // The anti-pattern: a capitalized component declared inside another function
    // body (indented) that returns JSX. Module-scope components start at col 0.
    const antiPattern = /\n[ \t]+const [A-Z][A-Za-z0-9]* = \([^)]*\)\s*=>\s*\(/;
    expect(antiPattern.test(src)).toBe(false);
  });
});
