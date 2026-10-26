// Frontend capability matrix must mirror the server's route guards
// (backend/src/__tests__/unit/mediaRecordingsRbac.test.js holds the same table).
import { describe, it, expect } from 'vitest';
import { can, CAPABILITIES } from '../auth/permissions.js';

const EXPECTED = {
  'media.view':          ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR'],
  'media.upload':        ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR'],
  'media.manage':        ['SUPER_ADMIN', 'ADMIN'],
  'recordings.view':     ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'],
  'recordings.annotate': ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'],
  'recordings.delete':   ['SUPER_ADMIN', 'ADMIN'],
  'reports.view':        ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'],   // reports.js: adminOrOp
};
const ROLES = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'];

describe('capability matrix', () => {
  it('matches the server-enforced matrix exactly', () => {
    expect(CAPABILITIES).toEqual(EXPECTED);
  });
  for (const [cap, roles] of Object.entries(EXPECTED)) {
    for (const role of ROLES) {
      it(`${role} ${roles.includes(role) ? 'can' : 'cannot'} ${cap}`, () => {
        expect(can({ role }, cap)).toBe(roles.includes(role));
      });
    }
  }
  it('denies when there is no user or the capability is unknown', () => {
    expect(can(null, 'media.view')).toBe(false);
    expect(can({ role: 'ADMIN' }, 'media.nuke')).toBe(false);
  });
  it('supervisors are no longer shown scan/deploy/delete (server returns 403 for them)', () => {
    expect(can({ role: 'SUPERVISOR' }, 'media.upload')).toBe(true);
    expect(can({ role: 'SUPERVISOR' }, 'media.manage')).toBe(false);
    expect(can({ role: 'SUPERVISOR' }, 'recordings.delete')).toBe(false);
  });
});
