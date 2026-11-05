// SUPER_ADMIN IVR administration — UI gating mirrors the server
// (backend/src/__tests__/integration/superAdminIvr.test.js, TU-7..TU-12).
import { describe, it, expect } from 'vitest';
import { can, needsTenantSelection } from '../auth/permissions.js';
import { numbersForFlowTenant } from '../components/ivr/panels/bindNumbers.js';

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'];

describe('IVR capabilities', () => {
  it('SUPER_ADMIN can edit and deploy IVRs', () => {
    expect(can({ role: 'SUPER_ADMIN' }, 'ivr.edit')).toBe(true);
    expect(can({ role: 'SUPER_ADMIN' }, 'ivr.deploy')).toBe(true);
  });
  it('tenant roles are unchanged: ADMIN/SUPERVISOR edit, only ADMIN deploys', () => {
    expect(ROLES.filter(r => can({ role: r }, 'ivr.edit'))).toEqual(['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR']);
    expect(ROLES.filter(r => can({ role: r }, 'ivr.deploy'))).toEqual(['SUPER_ADMIN', 'ADMIN']);
  });
});

describe('create needs a selected tenant', () => {
  it('SUPER_ADMIN under All Tenants must select a tenant; with one selected may create', () => {
    expect(needsTenantSelection({ role: 'SUPER_ADMIN' }, null)).toBe(true);
    expect(needsTenantSelection({ role: 'SUPER_ADMIN' }, 3)).toBe(false);
  });
  it('tenant users never need to select one', () => {
    for (const role of ROLES.slice(1)) expect(needsTenantSelection({ role }, null)).toBe(false);
  });
});

describe('bind dialog lists only the flow tenant\'s numbers', () => {
  const numbers = [
    { id: 1, number: '1001', tenant_id: 1 },
    { id: 2, number: '2001', tenant_id: 2 },
    { id: 3, number: '1002', tenant_id: 1 },
    { id: 4, number: '9000', tenant_id: null },
  ];
  it('filters to the flow\'s tenant', () => {
    expect(numbersForFlowTenant(numbers, 1).map(n => n.id)).toEqual([1, 3]);
    expect(numbersForFlowTenant(numbers, 2).map(n => n.id)).toEqual([2]);
  });
  it('a flow without a tenant only sees numbers without a tenant; empty input is safe', () => {
    expect(numbersForFlowTenant(numbers, null).map(n => n.id)).toEqual([4]);
    expect(numbersForFlowTenant(undefined, 1)).toEqual([]);
  });
});
