// Inspector error bucketing (Workstream B) — pure, display-only.
import { describe, it, expect } from 'vitest';
import { bucketNodeErrors } from '../components/ivr/panels/inspectorErrors.js';

describe('bucketNodeErrors', () => {
  it('scopes a field error to its field key, prefix stripped', () => {
    const r = bucketNodeErrors(['node abc123.audio_url: must start with /media/']);
    expect(r.byField).toEqual({ audio_url: ['must start with /media/'] });
    expect(r.node).toEqual([]);
  });
  it('keeps node-level errors separate, prefix stripped', () => {
    const r = bucketNodeErrors(['node abc123: can never be reached from the entry node']);
    expect(r.byField).toEqual({});
    expect(r.node).toEqual(['can never be reached from the entry node']);
  });
  it('groups multiple errors on the same field', () => {
    const r = bucketNodeErrors([
      'node n1.destination: required',
      'node n1.destination: must be a valid extension',
    ]);
    expect(r.byField.destination).toEqual(['required', 'must be a valid extension']);
  });
  it('mixes field and node errors correctly', () => {
    const r = bucketNodeErrors([
      'node n1.queue: required',
      'node n1: has an unconnected required output',
    ]);
    expect(r.byField).toEqual({ queue: ['required'] });
    expect(r.node).toEqual(['has an unconnected required output']);
  });
  it('is safe on empty / non-array / non-string input', () => {
    expect(bucketNodeErrors()).toEqual({ byField: {}, node: [] });
    expect(bucketNodeErrors(null)).toEqual({ byField: {}, node: [] });
    expect(bucketNodeErrors([42, null])).toEqual({ byField: {}, node: [] });
  });
});
