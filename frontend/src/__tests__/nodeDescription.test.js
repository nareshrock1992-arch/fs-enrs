import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { nodeSubtitleLines, renderSummaryTemplate } from '../components/ivr/canvas/nodeSubtitle.js';

// Combined-display rules for the generic node `description`:
//  - summary stays as the primary line; description is a secondary line beneath.
//  - Go To Node: a set description REPLACES the raw-node-id summary.
// The composition logic is pure (no DOM), so it is unit-tested directly.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..');
const read = rel => readFileSync(path.join(srcRoot, rel), 'utf8');

const transferCfg = { summaryTemplate: '→ ${destination}' };
const conditionCfg = { summaryTemplate: '${variable} ${operator} ${expected_value}' };
const gotoCfg = { summaryTemplate: '→ ${target_node_id}' };

describe('nodeSubtitleLines — combined summary + description', () => {
  it('shows summary only when no description is set (legacy behavior)', () => {
    const r = nodeSubtitleLines({ type: 'transfer', destination: '7352' }, transferCfg);
    expect(r).toEqual({ primary: '→ 7352', secondary: null });
  });

  it('shows BOTH summary (primary) and description (secondary) when set', () => {
    const r = nodeSubtitleLines(
      { type: 'transfer', destination: '7352', description: 'Send to Tier 2' },
      transferCfg,
    );
    expect(r.primary).toBe('→ 7352');
    expect(r.secondary).toBe('Send to Tier 2');
  });

  it('keeps a Condition expression as the primary line with description beneath', () => {
    const r = nodeSubtitleLines(
      { type: 'condition', variable: 'x', operator: '==', expected_value: '1', description: 'billing?' },
      conditionCfg,
    );
    expect(r.primary).toBe('x == 1');
    expect(r.secondary).toBe('billing?');
  });

  it('Go To Node: a description REPLACES the raw-node-id summary', () => {
    const r = nodeSubtitleLines(
      { type: 'goto', target_node_id: 'node_1789147344817_10', description: 'Back to main menu' },
      gotoCfg,
    );
    expect(r).toEqual({ primary: 'Back to main menu', secondary: null });
  });

  it('Go To Node: with no description, still shows the summary (unchanged)', () => {
    const r = nodeSubtitleLines({ type: 'goto', target_node_id: 'node_x' }, gotoCfg);
    expect(r.primary).toBe('→ node_x');
    expect(r.secondary).toBeNull();
  });

  it('treats a whitespace-only description as empty (falls back to summary)', () => {
    const r = nodeSubtitleLines({ type: 'transfer', destination: '7352', description: '   ' }, transferCfg);
    expect(r).toEqual({ primary: '→ 7352', secondary: null });
  });

  it('renderSummaryTemplate renders "?" for missing referenced fields (unchanged)', () => {
    expect(renderSummaryTemplate({ type: 'transfer' }, transferCfg)).toBe('→ ?');
  });
});

describe('source wiring', () => {
  it('FlowNode uses the shared subtitle helper and renders a secondary description line', () => {
    const src = read('components/ivr/canvas/FlowNode.jsx');
    expect(src).toMatch(/import \{ nodeSubtitleLines \} from '\.\/nodeSubtitle\.js'/);
    expect(src).toMatch(/secondary/);
  });

  it('PropertyPanel exposes an editable description writing node.description', () => {
    const src = read('components/ivr/panels/PropertyPanel.jsx');
    expect(src).toMatch(/onChange\(\{ description: e\.target\.value \|\| undefined \}\)/);
    expect(src).toMatch(/maxLength=\{500\}/);
  });
});
