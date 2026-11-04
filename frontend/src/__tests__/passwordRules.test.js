import { describe, it, expect } from 'vitest';
import { passwordProblems } from '../components/layout/passwordRules.js';

// Must agree with backend/src/validators/passwordPolicy.js (the server decides).
describe('password checklist', () => {
  it('lists every rule for an empty password', () => expect(passwordProblems('')).toHaveLength(5));
  it.each(['Aa1!aaaa', 'Correct-Horse-9'])('%s meets every rule', (p) => expect(passwordProblems(p)).toEqual([]));
  it.each([['aaaaaaaa', 'An uppercase letter'], ['AAAAAAA1', 'A lowercase letter'], ['Aa1aaaaa', 'A symbol'], ['Aa1!', 'At least 8 characters']])(
    '%s misses "%s"', (p, rule) => expect(passwordProblems(p)).toContain(rule));
});
