/**
 * mediaDependencyService — "what uses this media file?" and guarded deletion.
 *
 * WHY: a media file is referenced by PATH STRING, not by id. IVR nodes, ENS/ERS
 * configurations and campaigns store `/media/<leaf>` (or occasionally an
 * absolute sound-dir path / bare filename), where <leaf> is the basename of the
 * deployed file (`fs_path`) or, before deployment, of the staging copy
 * (`path_or_uri`). Deleting a record used to remove the deployed file with no
 * check at all, silently breaking any live flow that played it.
 *
 * REFERENCE SOURCES (blocking unless noted)
 *   ivr_flow_draft        ivr_flows.graph                      (non-deleted flows)
 *   ivr_flow_published    ivr_flow_versions.graph — latest version AND
 *                         ivr_flows.last_deployed_version (the live runtime
 *                         plays the latest published version)
 *   ens_configuration     ens_configurations.{expiry,no_pending,unauthorized}_audio_url
 *   ers_configuration     ers_configurations.{queue_announcement_audio,queue_hold_audio,queue_music_path}
 *   ens_campaign_active   ens_campaigns.{message_audio_url,recording_file}
 *                         while status ∈ queued|running|paused
 *   platform_config       config_versions.xml_content where is_active (deployed FS XML)
 *   ivr_template          built-in templates (ALWAYS, from code) + the legacy
 *                         public.ivr_templates table (ONLY if present) — NON-blocking
 *                         warnings (templates never execute calls; flows created
 *                         from them are covered by deploy-time file validation)
 *
 * NOT A SOURCE — notification_templates: dropped by migration 041 (its only FK,
 * ens_configurations.template_id, was dropped by 036); no supported install has it.
 *
 * SCHEMA — one up-front existence lookup per check. REQUIRED source tables
 * missing ⇒ DependencySchemaError (explicit, fail closed). The OPTIONAL legacy
 * public.ivr_templates (only created by 001_initial_schema.sql, which fresh
 * installs skip; not in validateSchema's REQUIRED) missing ⇒ that check is
 * skipped and reported in `skippedSources`.
 *
 * MATCHING — deliberately conservative (a false "in use" only blocks a delete;
 * a false "unused" could break a live emergency flow): any stored string value
 * that equals <leaf> or ends with "/<leaf>", case-insensitive. Covers
 * `/media/<leaf>`, absolute sound-dir paths and bare filenames.
 *
 * TENANCY — the FreeSWITCH sound directory is SHARED by all tenants, so
 * references are searched across ALL tenants. References owned by another
 * tenant still block, but are returned redacted (kind only — no ids/names).
 *
 * FAIL CLOSED — any error while checking dependencies aborts the delete
 * (DependencyCheckError). A failed check is never treated as "unused".
 */
import path from 'path';
import { promises as defaultFs } from 'fs';
import { URL } from 'url';
import { pool as dbPool, withTransaction as dbWithTransaction } from '../db/pool.js';
import { fsPathService as defaultFsPathService } from './freeSwitchPathService.js';
import { BUILTIN_IVR_TEMPLATES } from '../controllers/ivrTemplates.js';
import { logger } from '../infrastructure/index.js';

// Resolved lazily: this module is imported by core writers (e.g. campaignEngine),
// so loading it must not depend on the logger's shape at import time.
let moduleLog;
const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((lvl) => [lvl, (...args) => {
  moduleLog ??= typeof logger.forModule === 'function' ? logger.forModule('media-library') : logger;
  return moduleLog[lvl]?.(...args);
}]));

export const LIVE_CAMPAIGN_STATUSES = ['queued', 'running', 'paused'];
export const QUARANTINE_DIRNAME     = '.deleted';

/** Raised when dependency validation itself fails — callers must NOT delete. */
export class DependencyCheckError extends Error {
  constructor(cause, message = 'Media dependency check failed') {
    super(message);
    this.name  = 'DependencyCheckError';
    this.code  = 'DEPENDENCY_CHECK_FAILED';
    this.cause = cause;
  }
}

// ── Shared per-filename lock ─────────────────────────────────────────────────
// ONE lock identity for every party that deletes, references, deploys or scans
// a media filename: the TWO-key advisory form (namespace, hashtext(lower(leaf))).
// The two-key keyspace never overlaps single-key advisory locks (e.g. the ERS
// per-configuration lock). Session- and transaction-level advisory locks on the
// same key conflict across sessions, so a delete holding the SESSION lock blocks
// writers taking the TRANSACTION lock, and vice versa.
// Lock order (global, deadlock-free): media filename locks first — de-duplicated,
// lower-cased, sorted — then any row locks.
export const MEDIA_LOCK_NS = 0x4d454449;          // 'MEDI'
export const MEDIA_LOCK_TIMEOUT = '10s';

/** Sorted, de-duplicated, lower-cased lock keys for a set of filenames. */
export function mediaLockKeys(leaves) {
  return [...new Set((leaves || []).filter(Boolean).map((l) => String(l).toLowerCase()))].sort();
}

/**
 * Take the TRANSACTION-level media locks for `leaves` (for reference writers,
 * deploy and scan). Must be called inside a transaction, before row locks.
 * MEDIA_LOCK_TIMEOUT bounds ONLY these lock waits: the caller's previous
 * lock_timeout is restored right after acquisition, so later row-lock waits in
 * the same transaction behave exactly as before. If acquisition fails the
 * transaction is aborted and the transaction-local setting reverts with it.
 */
export async function lockMediaLeaves(tq, leaves) {
  const keys = mediaLockKeys(leaves);
  if (!keys.length) return keys;
  const { rows } = await tq(`SELECT current_setting('lock_timeout') AS prev`);
  const prev = rows?.[0]?.prev ?? '0';
  await tq(`SELECT set_config('lock_timeout', $1, true)`, [MEDIA_LOCK_TIMEOUT]);
  for (const key of keys) {
    await tq('SELECT pg_advisory_xact_lock($1, hashtext($2))', [MEDIA_LOCK_NS, key]);
  }
  await tq(`SELECT set_config('lock_timeout', $1, true)`, [prev]);
  return keys;
}

// ── Reference-writer guard ───────────────────────────────────────────────────
// Writers (IVR save/publish/template, ENS, ERS, campaigns) call
// guardMediaReferences(tq, …storedValues) INSIDE their transaction, BEFORE any
// row lock and before writing. It takes the shared per-filename locks (so a
// concurrent delete either finishes first or waits for us) and rejects
// references to library media that has been soft-deleted. Filenames with no
// library record at all (built-in / manually managed sounds) stay allowed.
const AUDIO_EXT_RE = /\.(wav|mp3|ogg|gsm|ul|flac)$/i;
// FreeSWITCH sources that never name a file in the ENRS sound directory.
const NON_FILE_SCHEME_RE = /^(tone_stream|local_stream|silence_stream|shout|ivr|phrase|say|speak|tts)(:|$)/i;

/**
 * Lower-cased filenames referenced by any stored value (strings, arrays, objects).
 * Aligned with the delete side, which treats a stored value as a reference to
 * <leaf> when it equals <leaf> or ends with "/<leaf>" (case-insensitive,
 * backslashes normalised — see leafOf). So, per string:
 *   - "/media/<…>"            → its leaf (any characters, spaces included)
 *   - "file_string://a!b"     → each part
 *   - "http(s)://…/x.wav?q"   → leaf of the URL path (query/fragment ignored)
 *   - tone_stream / local_stream / silence_stream / say: / phrase: … → none
 *   - anything else           → its leaf, only when it ends in an audio extension
 *     (spaces allowed: "my prompt.wav"). Text without an audio extension —
 *     TTS prompts, prose, variables, numbers — is never a filename.
 * Multi-line strings are prose. Over-extraction is safe: a writer is only
 * rejected when a SOFT-DELETED library record has exactly that leaf.
 */
export function extractMediaLeaves(...values) {
  const out = new Set();
  const addPath = (s, allowAnyExt) => {
    const leaf = leafOf(s);
    if (leaf && (allowAnyExt || AUDIO_EXT_RE.test(leaf))) out.add(leaf.toLowerCase());
  };
  const visitString = (raw) => {
    const s = raw.trim();
    if (!s || /[\r\n\0]/.test(s)) return;
    if (s.startsWith('/media/')) return addPath(s, true);
    if (NON_FILE_SCHEME_RE.test(s)) return;
    const fileString = /^file_string:\/\/(.*)$/i.exec(s);
    if (fileString) { fileString[1].split('!').forEach((p) => p.trim() && visitString(p)); return; }
    if (/^https?:\/\//i.test(s)) {
      let p; try { p = new URL(s).pathname; } catch { return; }
      try { p = decodeURIComponent(p); } catch { /* keep encoded */ }
      return visitString(p);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return;                   // other URL schemes
    addPath(s, false);
  };
  const visit = (v) => {
    if (v == null) return;
    if (typeof v === 'string') { visitString(v); return; }
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (typeof v === 'object') Object.values(v).forEach(visit);
  };
  values.forEach(visit);
  return [...out].sort();
}

/** 409 — the payload references library media that has been deleted. */
export class MediaReferenceDeletedError extends Error {
  constructor(files) {
    super(`Referenced media has been deleted from the library: ${files.join(', ')}`);
    this.name  = 'MediaReferenceDeletedError';
    this.code  = 'MEDIA_DELETED';
    this.files = files;
  }
}

/**
 * Reject filenames that only exist as SOFT-DELETED library media (no live
 * record anywhere — the physical file may already be in .deleted/). Checked
 * across all tenants because the sound directory is shared; only the caller's
 * own filenames are echoed back. Query errors propagate (fail closed).
 */
export async function assertMediaNotDeleted(tq, leaves) {
  const deleted = await findDeletedMediaLeaves(tq, leaves);
  if (deleted.length) throw new MediaReferenceDeletedError(deleted);
}

/** Lower-cased leaves (of `leaves`) that exist ONLY as soft-deleted library media. */
export async function findDeletedMediaLeaves(tq, leaves) {
  leaves = mediaLockKeys(leaves);
  if (!leaves.length) return [];
  // Same normalisation as leafOf(): backslashes → '/', then the last segment.
  const base = (col) => `lower(regexp_replace(translate(coalesce(m.${col}, ''), '\\', '/'), '^.*/', ''))`;
  const { rows } = await tq(
    `SELECT l AS leaf FROM unnest($1::text[]) AS l
      WHERE NOT EXISTS (SELECT 1 FROM media_files m WHERE m.deleted_at IS NULL
                          AND (${base('fs_path')} = l OR ${base('path_or_uri')} = l))
        AND EXISTS     (SELECT 1 FROM media_files m WHERE m.deleted_at IS NOT NULL
                          AND (${base('fs_path')} = l OR ${base('path_or_uri')} = l))`,
    [leaves],
  );
  return rows.map((r) => r.leaf).sort();
}

/** The filename a stored path refers to — the single normalisation used everywhere. */
export function mediaLeafOf(p) { return leafOf(p); }

/** Lock + deleted-media check for everything a writer is about to store. */
export async function guardMediaReferences(tq, ...values) {
  return guardMedia(tq, { check: values });
}

/**
 * Writer guard with two classes of value, locked together in ONE sorted
 * acquisition (global lock order):
 *   check    — library references: locked AND rejected (409) if soft-deleted
 *   lockOnly — generated files that are never library media (e.g. phone-recorded
 *              ENS blasts): locked only, never rejected
 * Errors are tagged for the shared errorHandler (409 MEDIA_DELETED / 503 MEDIA_BUSY).
 */
export async function guardMedia(tq, { check = [], lockOnly = [] } = {}) {
  const checkLeaves = extractMediaLeaves(...check);
  const lockLeaves  = [...checkLeaves, ...extractMediaLeaves(...lockOnly)];
  if (!lockLeaves.length) return checkLeaves;
  try {
    await lockMediaLeaves(tq, lockLeaves);
    await assertMediaNotDeleted(tq, checkLeaves);
  } catch (err) { throw tagGuardError(err); }
  return checkLeaves;
}

/**
 * query()-shaped helper for single-statement writers: runs `sql` in its own
 * transaction behind guardMediaReferences(values). Usage:
 *   await guardedQuery([d.expiry_audio_url, …])(sql, params)
 */
export function guardedQuery(values, { withTx = dbWithTransaction } = {}) {
  return (sql, params) => withTx(async (tq) => {
    await guardMediaReferences(tq, ...values);
    return tq(sql, params);
  });
}

function tagGuardError(err) {
  const mapped = mediaGuardErrorResponse(err);
  if (mapped && err && typeof err === 'object') { err.status = mapped.status; err.httpBody = mapped.body; }
  return err;
}

/**
 * Deploy (copy into the sound dir) a library record UNDER the shared per-filename
 * lock, so a concurrent guarded delete either finishes first (we then see the
 * record deleted and copy nothing) or waits until our copy + fs_path update has
 * committed. `copy()` performs the actual file copy and returns the dest path.
 * Returns the dest path, or null if the record was deleted / no longer exists.
 * Throws MediaLockError('MEDIA_CHANGED') if the record's files changed since the
 * caller read it, or the 55P03 lock-timeout error (both tagged → 503).
 */
export async function deployMediaLocked(record, destLeaf, copy, { withTx = dbWithTransaction } = {}) {
  const keys = mediaLockKeys(mediaReferenceKeys(record));
  try {
    return await withTx(async (tq) => {
      await lockMediaLeaves(tq, [...keys, leafOf(destLeaf)]);
      const { rows: [cur] } = await tq(
        `SELECT id, fs_path, path_or_uri FROM media_files WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [record.id],
      );
      if (!cur) return null;
      if (mediaLockKeys(mediaReferenceKeys(cur)).join('\n') !== keys.join('\n')) throw new MediaLockError('MEDIA_CHANGED');
      const destPath = await copy();
      await tq(`UPDATE media_files SET fs_path=$2, is_deployed=true, deployed_at=now() WHERE id=$1`, [record.id, destPath]);
      return destPath;
    });
  } catch (err) { throw tagGuardError(err); }
}

/**
 * Scan import of ONE sound-dir file under the shared per-filename lock: re-verify
 * (after any concurrent delete has finished its move) that the file still exists,
 * still has the size the caller measured, and is not tracked by a live record —
 * then run `insert(tq)`. Returns its result, or null when the file was skipped.
 */
export async function importScannedFileLocked(filePath, insert, { expectedSize = null, withTx = dbWithTransaction, fs = defaultFs } = {}) {
  const leaf = leafOf(filePath);
  return withTx(async (tq) => {
    await lockMediaLeaves(tq, [leaf]);
    let stat;
    try { stat = await fs.stat(filePath); } catch (err) { if (err?.code === 'ENOENT') return null; throw err; }
    if (!stat.isFile() || (expectedSize != null && stat.size !== Number(expectedSize))) return null;
    const { rows } = await tq(
      `SELECT 1 FROM media_files WHERE deleted_at IS NULL AND (fs_path = $1 OR name = $2) LIMIT 1`,
      [filePath, leaf],
    );
    if (rows.length) return null;
    return insert(tq);
  });
}

/** Map a writer-guard error to an HTTP response, or null if it is not one. */
export function mediaGuardErrorResponse(err) {
  if (err?.code === 'MEDIA_DELETED') {
    return { status: 409, body: {
      error: 'MEDIA_DELETED',
      message: 'This change references media that has been deleted from the Media Library. ' +
               'Choose another file or restore it first. Nothing was saved.',
      files: err.files,
    } };
  }
  if (err?.code === '55P03' || err?.code === 'MEDIA_BUSY') {
    return { status: 503, body: { error: 'MEDIA_BUSY',
      message: 'A referenced media file is being changed right now. Nothing was saved — try again shortly.' } };
  }
  if (err?.code === 'MEDIA_CHANGED') {
    return { status: 503, body: { error: 'MEDIA_CHANGED',
      message: 'The item changed while it was being saved. Nothing was saved — try again.' } };
  }
  return null;
}

/** A REQUIRED reference-source table is missing — schema/configuration error. */
export class DependencySchemaError extends DependencyCheckError {
  constructor(missingTables) {
    super(null, `Media dependency check cannot run: required table(s) missing: ${missingTables.join(', ')}`);
    this.name          = 'DependencySchemaError';
    this.code          = 'DEPENDENCY_SCHEMA_ERROR';
    this.missingTables = missingTables;
  }
}

// ── Reference keys & match patterns (pure) ───────────────────────────────────

function leafOf(p) {
  if (typeof p !== 'string') return null;
  const s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s) return null;
  const leaf = path.posix.basename(s);
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : null;
}

/** Filenames by which a media record can be referenced (deployed + staging leaf). */
export function mediaReferenceKeys(record) {
  const leaves = new Set();
  for (const p of [record?.fs_path, record?.path_or_uri]) {
    const leaf = leafOf(p);
    if (leaf) leaves.add(leaf);
  }
  return [...leaves].sort();
}

const likeEscape      = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);
const jsonEscapeInner = (s) => JSON.stringify(s).slice(1, -1);

/**
 * ILIKE patterns for each storage shape.
 *   scalar — a text column holding a single path:  "<leaf>" or ".../<leaf>"
 *   json   — a JSONB document cast to text: any string VALUE "<leaf>" or ".../<leaf>"
 *   text   — free text (XML): ".../<leaf>" anywhere
 */
export function buildPatterns(leaves) {
  const scalar = [], json = [], text = [];
  for (const leaf of leaves) {
    const l = likeEscape(leaf);
    scalar.push(`%/${l}`, l);
    const j = likeEscape(jsonEscapeInner(leaf));
    json.push(`%/${j}"%`, `%"${j}"%`);
    text.push(`%/${l}%`);
  }
  return { scalar, json, text };
}

// ── Reference sources ────────────────────────────────────────────────────────
// Each source returns rows shaped { id, ref_uuid, name, tenant_id, field }.
// `tables` are checked for existence first (to_regclass, resolved exactly as
// the query resolves them). `optional: true` ⇒ skip when absent; otherwise a
// missing table is a schema error (fail closed).

const UNION_COLUMNS = (table, cols) => cols.map((c) =>
  `SELECT id, name, tenant_id, '${c}' AS field, ${c} AS v FROM ${table} WHERE deleted_at IS NULL AND ${c} IS NOT NULL`,
).join(' UNION ALL ');

export const REFERENCE_SOURCES = [
  {
    kind: 'ivr_flow_draft', blocking: true, needs: 'json', tables: ['ivr_flows'],
    sql: `SELECT f.id::text AS id, f.flow_uuid::text AS ref_uuid, f.name, f.tenant_id, 'draft' AS field
            FROM ivr_flows f
           WHERE f.deleted_at IS NULL AND f.graph::text ILIKE ANY($1::text[])`,
    params: (p) => [p.json],
  },
  {
    kind: 'ivr_flow_published', blocking: true, needs: 'json', tables: ['ivr_flows', 'ivr_flow_versions'],
    sql: `SELECT f.id::text AS id, f.flow_uuid::text AS ref_uuid, f.name, f.tenant_id,
                 'version ' || v.version_number AS field
            FROM ivr_flows f
            JOIN ivr_flow_versions v ON v.ivr_flow_id = f.id
           WHERE f.deleted_at IS NULL
             AND (v.version_number = (SELECT MAX(v2.version_number) FROM ivr_flow_versions v2
                                       WHERE v2.ivr_flow_id = f.id)
                  OR v.version_number = f.last_deployed_version)
             AND v.graph::text ILIKE ANY($1::text[])`,
    params: (p) => [p.json],
  },
  {
    kind: 'ens_configuration', blocking: true, needs: 'scalar', tables: ['ens_configurations'],
    sql: `SELECT s.id::text AS id, NULL AS ref_uuid, s.name, s.tenant_id, s.field
            FROM (${UNION_COLUMNS('ens_configurations',
                    ['expiry_audio_url', 'no_pending_audio_url', 'unauthorized_audio_url'])}) s
           WHERE s.v ILIKE ANY($1::text[])`,
    params: (p) => [p.scalar],
  },
  {
    kind: 'ers_configuration', blocking: true, needs: 'scalar', tables: ['ers_configurations'],
    sql: `SELECT s.id::text AS id, NULL AS ref_uuid, s.name, s.tenant_id, s.field
            FROM (${UNION_COLUMNS('ers_configurations',
                    ['queue_announcement_audio', 'queue_hold_audio', 'queue_music_path'])}) s
           WHERE s.v ILIKE ANY($1::text[])`,
    params: (p) => [p.scalar],
  },
  {
    kind: 'ens_campaign_active', blocking: true, needs: 'scalar', tables: ['ens_campaigns', 'ens_configurations'],
    sql: `SELECT c.id::text AS id, NULL AS ref_uuid,
                 COALESCE(cfg.name, 'Campaign ' || c.id) AS name, cfg.tenant_id, c.status AS field
            FROM ens_campaigns c
            LEFT JOIN ens_configurations cfg ON cfg.id = c.ens_configuration_id
           WHERE c.status = ANY($2::text[])
             AND (c.message_audio_url ILIKE ANY($1::text[]) OR c.recording_file ILIKE ANY($1::text[]))`,
    params: (p) => [p.scalar, LIVE_CAMPAIGN_STATUSES],
  },
  {
    kind: 'platform_config', blocking: true, needs: 'text', tables: ['config_versions'],
    sql: `SELECT id::text AS id, NULL AS ref_uuid, file_path AS name, tenant_id, provider_id AS field
            FROM config_versions
           WHERE is_active = true AND xml_content ILIKE ANY($1::text[])`,
    params: (p) => [p.text],
  },
  {
    kind: 'ivr_template', blocking: false, needs: 'json',
    // Legacy table: created only by 001_initial_schema.sql (skipped by fresh
    // installs), absent from validateSchema REQUIRED ⇒ optional. Schema-
    // qualified in BOTH the existence lookup and the query.
    tables: ['public.ivr_templates'], optional: true,
    sql: `SELECT id::text AS id, slug AS ref_uuid, name, NULL::int AS tenant_id, 'graph' AS field
            FROM public.ivr_templates
           WHERE is_active = true AND graph::text ILIKE ANY($1::text[])`,
    params: (p) => [p.json],
  },
];

function builtinTemplateRefs(leaves, templates) {
  const wanted = leaves.map((l) => l.toLowerCase());
  const refs = [];
  for (const [slug, tpl] of Object.entries(templates || {})) {
    const fields = new Set();
    for (const [nodeId, node] of Object.entries(tpl?.graph?.nodes || {})) {
      for (const [key, val] of Object.entries(node || {})) {
        if (typeof val !== 'string') continue;
        const leaf = leafOf(val);
        if (leaf && wanted.includes(leaf.toLowerCase())) fields.add(`${nodeId}.${key}`);
      }
    }
    if (fields.size) {
      refs.push({ kind: 'ivr_template', blocking: false, id: slug, ref_uuid: slug,
        name: tpl.name, tenant_id: null, field: [...fields].join(', '), builtin: true });
    }
  }
  return refs;
}

/**
 * Find everything that references `record`. Searches all tenants (shared sound
 * dir); redacts other tenants' references for a tenant-scoped viewer.
 *
 * @param q        bound query fn (transaction or pool)
 * @param record   media_files row (id, fs_path, path_or_uri)
 * @param opts.viewerTenantId  null = unrestricted (SUPER_ADMIN / system)
 * @returns { references, blocking, warnings, hiddenCount }
 * @throws  DependencyCheckError on ANY failure (fail closed)
 */
export async function findMediaReferences(q, record, { viewerTenantId = null, templates = BUILTIN_IVR_TEMPLATES } = {}) {
  const started = Date.now();
  try {
    const leaves   = mediaReferenceKeys(record);
    const patterns = buildPatterns(leaves);
    const found = [];
    const skippedSources = [];

    // Every source matches by filename; a record with no path cannot be referenced.
    if (leaves.length > 0) {
      const present = await sourceTablePresence(q);
      const missingRequired = [...new Set(REFERENCE_SOURCES
        .filter((s) => !s.optional).flatMap((s) => s.tables).filter((t) => !present.get(t)))];
      if (missingRequired.length) throw new DependencySchemaError(missingRequired);

      for (const src of REFERENCE_SOURCES) {
        if (src.optional && !src.tables.every((t) => present.get(t))) { skippedSources.push(src.kind); continue; }
        const { rows } = await q(src.sql, src.params(patterns));
        for (const r of rows || []) found.push({ kind: src.kind, blocking: src.blocking, ...r });
      }
    }
    // Built-in templates are code, not data — always checked.
    found.push(...builtinTemplateRefs(leaves, templates));

    let hiddenCount = 0;
    const references = found.map((r) => {
      const foreign = viewerTenantId != null && r.tenant_id != null && Number(r.tenant_id) !== Number(viewerTenantId);
      if (foreign) {
        hiddenCount++;
        return { kind: r.kind, blocking: r.blocking, other_tenant: true };
      }
      return {
        kind: r.kind, blocking: r.blocking, id: r.id, ref_uuid: r.ref_uuid ?? null,
        name: r.name ?? null, field: r.field ?? null, ...(r.builtin ? { builtin: true } : {}),
      };
    });

    log.debug('media.dependency_check', {
      mediaId: record.id, leaves, references: references.length, skippedSources,
      durationMs: Date.now() - started,
    });
    return {
      references,
      blocking: references.filter((r) => r.blocking),
      warnings: references.filter((r) => !r.blocking),
      hiddenCount,
      skippedSources,
    };
  } catch (err) {
    log.error('media.dependency_check_failed', {
      mediaId: record?.id, code: err?.code ?? null, error: err.message,
      ...(err?.missingTables ? { missingTables: err.missingTables } : {}),
    });
    throw err instanceof DependencyCheckError ? err : new DependencyCheckError(err);
  }
}

/**
 * Which reference-source tables exist — ONE read-only catalog lookup.
 * to_regclass resolves each name exactly as the source query does: unqualified
 * names through search_path (like the queries), the optional legacy table via
 * its explicit schema-qualified name. Any error propagates (fail closed).
 */
async function sourceTablePresence(q) {
  const names = [...new Set(REFERENCE_SOURCES.flatMap((s) => s.tables))];
  const { rows } = await q(
    'SELECT t.name, to_regclass(t.name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)',
    [names],
  );
  const present = new Map((rows || []).map((r) => [r.name, r.present === true]));
  if (names.some((n) => !present.has(n))) throw new Error('table existence lookup returned incomplete results');
  return present;
}

/** Other live media records that point at the same physical (deployed) file. */
export async function findSharedFileHolders(q, record) {
  if (!record?.fs_path) return [];
  const leaf = leafOf(record.fs_path);
  const { rows } = await q(
    `SELECT id FROM media_files
      WHERE id <> $1 AND deleted_at IS NULL AND fs_path IS NOT NULL
        AND (fs_path = $2 OR lower(regexp_replace(fs_path, '^.*/', '')) = lower($3))`,
    [record.id, record.fs_path, leaf],
  );
  return rows || [];
}

// ── Guarded deletion ─────────────────────────────────────────────────────────

/**
 * Delete a media record only if nothing references it, then retire its
 * deployed file safely.
 *
 * Sequence (DB is the source of truth; the filesystem step can never be rolled
 * back, so it happens strictly AFTER commit and only when re-verified). ONE
 * dedicated connection holds the per-filename SESSION locks from before the
 * transaction until after the file move, so no reference writer, deploy or scan
 * (which take the same locks at transaction level) can interleave anywhere in
 * check → commit → re-check → move:
 *   0. unlocked read of the row (learn its filenames)
 *   1. pg_advisory_lock(MEDIA_LOCK_NS, hashtext(leaf)) per filename, sorted
 *   TX 2. SELECT … FOR UPDATE; filenames must be unchanged since step 0
 *      3. dependency check — any error ⇒ rollback, nothing deleted
 *      4. blocking references ⇒ rollback, return 'blocked'
 *      5. shared-file holders; soft-delete the row; COMMIT
 *   FS 6. re-check references + holders — still under the locks
 *      7. MOVE (not unlink) the file into <sound-dir>/.deleted/ — recoverable,
 *         and invisible to the non-recursive media scan
 *   8. unlock in `finally`; a connection whose unlock fails is destroyed, never
 *      returned to the pool holding a lock
 *
 * @param opts.tenantId            effective tenant (null = unrestricted)
 * @param opts.allowSystemShared   legacy route semantics: tenant may delete
 *                                 tenant_id IS NULL (system) records
 * @returns { status: 'not_found'|'blocked'|'deleted', record?, ...deps, file? }
 * @throws  DependencyCheckError — nothing was deleted
 */
export async function deleteMediaSafely(
  { id, tenantId = null, allowSystemShared = false, correlationId = null },
  deps = {},
) {
  const {
    connect       = () => dbPool.connect(),
    fs            = defaultFs,
    fsPathService = defaultFsPathService,
    templates     = BUILTIN_IVR_TEMPLATES,
  } = deps;

  if (!/^\d+$/.test(String(id))) return { status: 'not_found' };

  const scope = `($2::int IS NULL OR tenant_id = $2${allowSystemShared ? ' OR tenant_id IS NULL' : ''})`;
  const client = await connect();
  const q = (sql, params) => client.query(sql, params);
  const held = [];
  let destroy = false;

  try {
    // 0. Learn the filenames to lock (no lock yet — re-verified in step 2).
    const { rows: [pre] } = await q(
      `SELECT id, fs_path, path_or_uri FROM media_files WHERE id = $1 AND deleted_at IS NULL AND ${scope}`,
      [id, tenantId],
    );
    if (!pre) return { status: 'not_found' };
    const keys = mediaLockKeys(mediaReferenceKeys(pre));

    // 1. Session locks, held through commit, re-check and file move.
    await q(`SET lock_timeout = '${MEDIA_LOCK_TIMEOUT}'`);
    for (const key of keys) {
      await q('SELECT pg_advisory_lock($1, hashtext($2))', [MEDIA_LOCK_NS, key]);
      held.push(key);
    }

    // 2–5. Transaction.
    let outcome;
    await q('BEGIN');
    try {
      const { rows: [record] } = await q(
        `SELECT * FROM media_files WHERE id = $1 AND deleted_at IS NULL AND ${scope} FOR UPDATE`,
        [id, tenantId],
      );
      if (!record) {
        outcome = { status: 'not_found' };
      } else if (mediaLockKeys(mediaReferenceKeys(record)).join('\n') !== keys.join('\n')) {
        throw new MediaLockError('MEDIA_CHANGED', null);
      } else {
        const deps2 = await findMediaReferences(q, record, { viewerTenantId: tenantId, templates });
        if (deps2.blocking.length > 0) {
          outcome = { status: 'blocked', record, ...deps2 };
        } else {
          const sharedWith = (await findSharedFileHolders(q, record)).map((r) => r.id);
          await q('UPDATE media_files SET deleted_at = now() WHERE id = $1', [record.id]);
          outcome = { status: 'deleted', record, ...deps2, sharedWith };
        }
      }
      await q(outcome.status === 'deleted' ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      await q('ROLLBACK').catch(() => { destroy = true; });
      throw err;
    }

    if (outcome.status === 'blocked') {
      log.info('media.delete_blocked', {
        correlationId, mediaId: outcome.record.id,
        blocking: outcome.blocking.length, kinds: [...new Set(outcome.blocking.map((r) => r.kind))],
      });
      return outcome;
    }
    if (outcome.status !== 'deleted') return outcome;

    // 6–7. Still holding the session locks.
    outcome.file = await retireDeployedFile(outcome.record, outcome.sharedWith, { query: q, fs, fsPathService, templates });
    log.info('media.deleted', {
      correlationId, mediaId: outcome.record.id, fileAction: outcome.file.action, reason: outcome.file.reason ?? null,
      warnings: outcome.warnings.length,
    });
    return outcome;
  } catch (err) {
    if (err?.code === '55P03') throw new MediaLockError('MEDIA_BUSY', err);   // lock_timeout
    throw err;
  } finally {
    // 8. Release locks; never return a connection to the pool still holding one.
    for (const key of held.reverse()) {
      try {
        const { rows: [r] } = await q('SELECT pg_advisory_unlock($1, hashtext($2)) AS ok', [MEDIA_LOCK_NS, key]);
        if (!r?.ok) destroy = true;
      } catch { destroy = true; }
    }
    try { await q('RESET lock_timeout'); } catch { destroy = true; }
    if (destroy) log.warn('media.lock_release_failed', { mediaId: id, keys: held.length });
    client.release(destroy ? true : undefined);
  }
}

/** Lock contention or a concurrent filename change — retryable, nothing deleted. */
export class MediaLockError extends DependencyCheckError {
  constructor(code, cause) {
    super(cause, code === 'MEDIA_BUSY'
      ? 'Media file is busy (another operation holds it)'
      : 'Media file changed during delete');
    this.name = 'MediaLockError';
    this.code = code;
  }
}

/** Post-commit, re-verified, recoverable removal of the deployed copy. */
async function retireDeployedFile(record, sharedWith, { query, fs, fsPathService, templates }) {
  const fsPath = record.fs_path;
  if (!fsPath) return { action: 'none', reason: 'not_deployed' };
  if (sharedWith?.length) return { action: 'retained', reason: 'shared_with_other_media', sharedWith };

  // Only ever touch files inside the ENRS sound directory (never arbitrary paths).
  const soundDir = path.posix.resolve(fsPathService.getEnrsSoundDir());
  const resolved = path.posix.resolve(fsPath);
  if (path.posix.dirname(resolved) !== soundDir) {
    log.warn('media.delete_file_retained', { mediaId: record.id, reason: 'outside_media_dir' });
    return { action: 'retained', reason: 'outside_media_dir' };
  }

  // Re-check: a reference or another record may have appeared after our
  // in-transaction check (e.g. an IVR saved concurrently). Fail closed.
  try {
    const again = await findMediaReferences(query, record, { viewerTenantId: null, templates });
    if (again.blocking.length > 0) {
      log.warn('media.delete_file_retained', { mediaId: record.id, reason: 'referenced_after_delete' });
      return { action: 'retained', reason: 'referenced_after_delete' };
    }
    const holders = await findSharedFileHolders(query, record);
    if (holders.length > 0) {
      return { action: 'retained', reason: 'shared_with_other_media', sharedWith: holders.map((h) => h.id) };
    }
  } catch (err) {
    log.warn('media.delete_file_retained', { mediaId: record.id, reason: 'recheck_failed', error: err.message });
    return { action: 'retained', reason: 'recheck_failed' };
  }

  const qdir = path.posix.join(soundDir, QUARANTINE_DIRNAME);
  const dest = path.posix.join(qdir, `${record.id}_${Date.now()}_${path.posix.basename(resolved)}`);
  try {
    await fs.mkdir(qdir, { recursive: true });
    await fs.rename(resolved, dest);
    return { action: 'quarantined', path: dest };
  } catch (err) {
    if (err?.code === 'ENOENT') return { action: 'none', reason: 'file_missing' };
    log.warn('media.delete_file_retained', { mediaId: record.id, reason: 'quarantine_failed', error: err.message });
    return { action: 'retained', reason: 'quarantine_failed' };
  }
}

/** HTTP 503 body when the dependency check could not run (nothing was deleted). */
export function dependencyFailureBody(err) {
  if (err?.code === 'MEDIA_BUSY' || err?.code === 'MEDIA_CHANGED') {
    return {
      error:   err.code,
      message: err.code === 'MEDIA_BUSY'
        ? 'This media file is in use by another operation right now. Nothing was deleted — try again shortly.'
        : 'This media file changed while it was being deleted. Nothing was deleted — try again.',
    };
  }
  if (err?.code === 'DEPENDENCY_SCHEMA_ERROR') {
    return {
      error:   'DEPENDENCY_SCHEMA_ERROR',
      message: 'Media dependency checks cannot run because required database tables are missing ' +
               `(${(err.missingTables || []).join(', ')}). Nothing was deleted — check that all migrations have been applied.`,
    };
  }
  return {
    error:   'DEPENDENCY_CHECK_FAILED',
    message: 'Could not verify whether this media file is in use. Nothing was deleted — try again.',
  };
}

/** HTTP 409 body for a blocked delete (shared by both delete routes). */
export function blockedDeleteBody(result) {
  const n = result.blocking.length;
  return {
    error:   'MEDIA_IN_USE',
    message: `This media file is used by ${n} item${n === 1 ? '' : 's'} and cannot be deleted. ` +
             'Remove or replace these references first.',
    dependencies:     result.blocking,
    hidden_count:     result.hiddenCount || 0,
    warnings:         result.warnings,
  };
}
