// ── Role → capability matrix (Media Library + Recordings) ────────────────────
//
// Mirrors the server's route guards exactly (backend/src/routes/v1/mediaLibrary.js,
// backend/src/routes/v1/recordings.js, backend/src/middleware/rbac.js) so the UI
// only offers actions the API will accept. The server remains the authority;
// this only decides what to show. Verified by
// backend/src/__tests__/unit/mediaRecordingsRbac.test.js and
// frontend/src/__tests__/permissions.test.js. See docs/media-rbac.md.

export const CAPABILITIES = Object.freeze({
  'media.view':          ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPERATOR'],
  'media.upload':        ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR'],
  'media.manage':        ['SUPER_ADMIN', 'ADMIN'],          // scan, deploy, edit, delete
  'recordings.view':     ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'],
  'recordings.annotate': ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'], // notes/tags, archive
  'recordings.delete':   ['SUPER_ADMIN', 'ADMIN'],
  'reports.view':        ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'], // routes/v1/reports.js: adminOrOp
  'ivr.edit':            ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR'], // routes/v1/ivr.js: adminOrSuper
  'ivr.deploy':          ['SUPER_ADMIN', 'ADMIN'],               // routes/v1/deployment.js: adminOnly
  'contacts.view':       ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'],   // routes/v1/contacts.js: adminOrOp (list, export)
  'contacts.edit':       ['SUPER_ADMIN', 'ADMIN'],               // routes/v1/contacts.js: adminOnly (create, edit, delete, upload)
});

/** True when `user` (shape { role }) holds `capability`. Unknown capabilities are denied. */
export function can(user, capability) {
  const roles = CAPABILITIES[capability];
  return !!(user && roles && roles.includes(user.role));
}

/**
 * Creating a tenant-owned resource needs a target tenant: SUPER_ADMIN must select one
 * in the header first (the server rejects the create otherwise). Tenant users always
 * have their own.
 */
export function needsTenantSelection(user, activeTenantId) {
  return user?.role === 'SUPER_ADMIN' && !activeTenantId;
}

/**
 * Navigation entries this user may see: role flags (superAdminOnly / adminOnly) and an
 * optional per-entry `capability`; a group whose children are all hidden is hidden too.
 */
export function visibleNav(nav, user) {
  const allowed = (n) => {
    if (n.superAdminOnly) return user?.role === 'SUPER_ADMIN';
    if (n.adminOnly && !(user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN')) return false;
    return !n.capability || can(user, n.capability);
  };
  return nav.filter(allowed).flatMap((n) => {
    if (!n.children) return [n];
    const children = n.children.filter(allowed);
    return children.length ? [{ ...n, children }] : [];
  });
}
