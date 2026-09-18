import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { IVR_VARIABLES, IVR_VARIABLE_CATEGORIES, insertAtCursor } from '../components/ivr/ivrVariables.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..');
const read = rel => readFileSync(path.join(srcRoot, rel), 'utf8');

describe('ivrVariables catalog', () => {
  it('is non-empty and every entry has the fields the picker needs', () => {
    expect(IVR_VARIABLES.length).toBeGreaterThan(0);
    for (const v of IVR_VARIABLES) {
      expect(typeof v.name).toBe('string');
      expect(v.name.length).toBeGreaterThan(0);
      expect(typeof v.label).toBe('string');
      expect(typeof v.description).toBe('string');
      expect(typeof v.example).toBe('string');
      expect(typeof v.availability).toBe('string');
      expect(typeof v.category).toBe('string');
    }
  });

  it('includes caller_id_name with a live example', () => {
    const cn = IVR_VARIABLES.find(v => v.name === 'caller_id_name');
    expect(cn).toBeTruthy();
    expect(cn.example).toMatch(/\$\{caller_id_name\}/);
  });

  it('exposes distinct categories', () => {
    expect(IVR_VARIABLE_CATEGORIES).toEqual([...new Set(IVR_VARIABLE_CATEGORIES)]);
    expect(IVR_VARIABLE_CATEGORIES).toContain('Caller');
  });

  it('flags context-dependent variables in their availability text', () => {
    const gr = IVR_VARIABLES.find(v => v.name === 'gather_result');
    expect(gr.availability.toLowerCase()).toContain('after');
  });
});

describe('insertAtCursor', () => {
  it('inserts a token in the middle at the cursor', () => {
    const r = insertAtCursor('Welcome  now', 8, 8, '${caller_id_name}');
    expect(r.text).toBe('Welcome ${caller_id_name} now');
    expect(r.caret).toBe(8 + '${caller_id_name}'.length);
  });

  it('replaces the current selection', () => {
    const r = insertAtCursor('Welcome NAME now', 8, 12, '${caller_id_name}');
    expect(r.text).toBe('Welcome ${caller_id_name} now');
  });

  it('appends when no selection position is provided', () => {
    const r = insertAtCursor('Welcome ', null, null, '${caller_id_name}');
    expect(r.text).toBe('Welcome ${caller_id_name}');
    expect(r.caret).toBe(r.text.length);
  });

  it('handles an empty starting value', () => {
    const r = insertAtCursor('', 0, 0, '${uuid}');
    expect(r.text).toBe('${uuid}');
  });
});

describe('source wiring', () => {
  it('PropertyPanel imports the catalog + insertAtCursor and uses InterpolableTextarea for textareas', () => {
    const src = read('components/ivr/panels/PropertyPanel.jsx');
    expect(src).toMatch(/import \{ IVR_VARIABLES, insertAtCursor \} from '\.\.\/ivrVariables\.js'/);
    expect(src).toMatch(/case 'textarea':[\s\S]*InterpolableTextarea/);
    expect(src).toContain('function VariableInserter');
  });
});
