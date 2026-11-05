// Numbers offered by the Bind Numbers dialog: only those of the flow's own tenant.
// For tenant users the list is already their tenant; for SUPER_ADMIN under
// "All Tenants" it spans every tenant. The backend enforces the same rule on
// bind/unbind (ivrController.bindNumber / unbindNumber); this only decides what to show.
export function numbersForFlowTenant(numbers, flowTenantId) {
  return (numbers || []).filter(n => (n.tenant_id ?? null) === (flowTenantId ?? null));
}
