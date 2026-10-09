// Fix C verification (dependency-free): the inspector auto-expands any section
// containing a field with a validation error. There is no DOM/RTL test env in
// this project, so we cannot mount <CollapsibleSection>. Instead we test the
// exact DATA composition the component uses to decide `forceOpen`:
//   fieldErrors = bucketNodeErrors(nodeErrorStrings).byField
//   forceOpen(section) = section.fields.some(f => fieldErrors[f.key]?.length)
// against real registered node schemas. This proves the targeting logic; the
// React state wiring (useEffect → setOpen, non-disruptive on clear) is argued by
// construction and noted as not render-tested.
import { describe, it, expect } from 'vitest';
import { bucketNodeErrors } from '../components/ivr/panels/inspectorErrors.js';
import { groupFields, sectionDefaultOpen } from '../components/ivr/panels/fieldSections.js';
import { NODE_TYPE_REGISTRY } from '../../../backend/src/nodeTypes/registry.js';

const schemaOf = (type) => NODE_TYPE_REGISTRY.find(n => n.type === type).configSchema;

// Mirror of the component's per-section forceOpen computation.
function sectionsForcedOpen(schema, nodeErrorStrings) {
  const { byField } = bucketNodeErrors(nodeErrorStrings);
  return groupFields(schema)
    .filter(s => s.fields.some(f => (byField[f.key] || []).length))
    .map(s => s.title);
}

describe('Fix C — section auto-expansion targeting', () => {
  const gather = schemaOf('gather'); // has timeout_seconds (Timeouts, collapsed) + prompt_text (Content, open)

  it('a collapsed section with an errored field is flagged to open', () => {
    expect(sectionDefaultOpen('Timeouts')).toBe(false); // precondition: collapsed by default
    expect(sectionsForcedOpen(gather, ['node g1.timeout_seconds: must be between 1 and 15'])).toEqual(['Timeouts']);
  });

  it('a section without errors is NOT flagged (retains default state)', () => {
    expect(sectionsForcedOpen(gather, [])).toEqual([]);
  });

  it('errors in multiple sections flag each affected section', () => {
    const forced = sectionsForcedOpen(gather, [
      'node g1.prompt_text: required',
      'node g1.timeout_seconds: out of range',
    ]);
    expect(forced).toContain('Content');
    expect(forced).toContain('Timeouts');
  });

  it('node-level (graph) errors do not force any field section open', () => {
    // These belong in the top summary block, not a field section.
    expect(sectionsForcedOpen(gather, ['node g1: has an unreachable path'])).toEqual([]);
  });

  it('works for a routing node (queue_eligibility): a queue error flags Routing', () => {
    const qe = schemaOf('queue_eligibility');
    expect(sectionsForcedOpen(qe, ['node q1.queue: required'])).toEqual(['Routing']);
  });
});
