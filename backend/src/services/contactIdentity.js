// ── Contact identity: one extension / one mobile number = one contact ─────────
//
// The single implementation of the platform-wide identity rules (docs/enterprise/
// CONTACT_UPSERT_DESIGN.md), used by every path that creates or changes contacts:
// POST/PUT /contacts, the CSV / Excel import and POST /ers/broadcast-users.
//
//   - normalisation mirrors the generated columns of migration 051 exactly;
//   - the lookup is platform-wide (uniqueness is), but callers only ever reveal a
//     matched contact to the caller when it is in the caller's own organization;
//   - writers hold IDENTITY_LOCK for the rest of their transaction so concurrent
//     requests see each other's result; the unique indexes are the final guard.

/** Extension: whitespace and ( ) . - removed, lower-case; empty → null. */
export function normalizeExtension(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).replace(/[\s().-]/g, '').toLowerCase();
  return v || null;
}

/** Mobile: digits and +; leading 00 → +; only a leading + kept; empty or "+" → null. */
export function normalizeMobile(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/[^0-9+]/g, '').replace(/^00/, '+');
  const v = s.startsWith('+') ? `+${s.replace(/[^0-9]/g, '')}` : s.replace(/[^0-9]/g, '');
  return v && v !== '+' ? v : null;
}

/**
 * Legacy same-user test of POST /ers/broadcast-users (its original match key was the last 9
 * digits). Kept for local ↔ international pairs such as 0501234567 / +966501234567, but two
 * numbers that both carry a country code are the same only when all their digits agree, so
 * +971501234567 never matches +966501234567 (country codes stay significant).
 */
export function legacyMobileMatch(stored, incoming) {
  const a = normalizeMobile(stored);
  const b = normalizeMobile(incoming);
  if (!a || !b) return false;
  const da = a.replace('+', '');
  const db = b.replace('+', '');
  if (da === db) return true;
  if (da.slice(-9) !== db.slice(-9)) return false;
  const local = (n, d) => !n.startsWith('+') && (d.startsWith('0') || d.length <= 9);
  return local(a, da) || local(b, db);
}

/** Normalised dial target (either kind) for per-execution recipient de-duplication. */
export const dialKey = (value) => normalizeMobile(value) ?? normalizeExtension(value);

/** Masked identifier for logs and audit records: never the full number. */
export const maskIdentifier = (value) => (value ? `***${String(value).slice(-3)}` : null);

export const IDENTITY_LOCK = `SELECT pg_advisory_xact_lock(hashtext('enrs:contact-identity'))`;

export const OTHER_ORG_MESSAGE = {
  extension: 'This extension is already assigned to a contact in another organization',
  mobile: 'This mobile number is already assigned to a contact in another organization',
  both: 'This extension and mobile number are already assigned to a contact in another organization',
};
export const CONFLICT_MESSAGE = 'The extension and the mobile number belong to two different existing contacts; resolve this before saving';

/**
 * Live contacts holding the given normalised identifiers (platform-wide).
 * @returns { byExtension: row|null, byMobile: row|null }
 */
export async function findIdentityMatches(q, { extension, mobile, excludeId = null }) {
  const ext = normalizeExtension(extension);
  const mob = normalizeMobile(mobile);
  if (!ext && !mob) return { byExtension: null, byMobile: null };
  const { rows } = await q(
    `SELECT id, organization_id, first_name, last_name, extension_norm, mobile_norm
     FROM emergency_contacts
     WHERE deleted_at IS NULL AND ($3::int IS NULL OR id <> $3)
       AND (($1::text IS NOT NULL AND extension_norm = $1) OR ($2::text IS NOT NULL AND mobile_norm = $2))`,
    [ext, mob, excludeId]
  );
  return {
    byExtension: ext ? rows.find((r) => r.extension_norm === ext) || null : null,
    byMobile: mob ? rows.find((r) => r.mobile_norm === mob) || null : null,
  };
}

/**
 * Decide what a create / import row may do.
 * @returns { kind: 'new' }
 *        | { kind: 'update', contact, matchedBy: 'extension'|'mobile'|'both' }
 *        | { kind: 'other_organization', field: 'extension'|'mobile'|'both' }
 *        | { kind: 'conflict', sameOrganization: boolean, contacts: [rowA, rowB] }
 */
export function classifyIdentity({ byExtension, byMobile }, organizationId) {
  if (!byExtension && !byMobile) return { kind: 'new' };
  if (byExtension && byMobile && byExtension.id !== byMobile.id) {
    const same = byExtension.organization_id === organizationId && byMobile.organization_id === organizationId;
    return { kind: 'conflict', sameOrganization: same, contacts: [byExtension, byMobile] };
  }
  const contact = byExtension || byMobile;
  if (contact.organization_id !== organizationId) {
    return { kind: 'other_organization', field: byExtension && byMobile ? 'both' : byExtension ? 'extension' : 'mobile' };
  }
  return { kind: 'update', contact, matchedBy: byExtension && byMobile ? 'both' : byExtension ? 'extension' : 'mobile' };
}

/** Postgres unique violation on one of the identity indexes (a concurrent writer won). */
export const isIdentityViolation = (err) =>
  err?.code === '23505' && /uq_contacts_(extension|mobile)_norm/.test(`${err.constraint || ''} ${err.message || ''}`);

/**
 * Per-execution recipient safeguard: keep the first item for each normalised dial target
 * (items without a number are kept). Used by ENS campaign creation, ERS ring-all and the
 * Lua lookups so one person is never called twice in the same run.
 * @returns { kept: item[], dropped: item[] }
 */
export function uniqueByDialTarget(items, numberOf) {
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const item of items) {
    const key = dialKey(numberOf(item));
    if (key && seen.has(key)) { dropped.push(item); continue; }
    if (key) seen.add(key);
    kept.push(item);
  }
  return { kept, dropped };
}
