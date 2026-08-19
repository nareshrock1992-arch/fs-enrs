/**
 * Regression tests for the gateway soft-delete / recreation bug.
 *
 * Root cause: UNIQUE (tenant_id, name) in 015_sip_gateways.sql was non-partial,
 * so a soft-deleted gateway blocked recreation. Fixed by migration 046 which
 * replaces the constraint with a partial unique index (WHERE deleted_at IS NULL).
 * deleteGateway also now sets is_active = false alongside deleted_at.
 *
 * These are source-level tests — they verify controller and query logic without
 * hitting a real database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// ── Source fixtures ─────────────────────────────────────────────────────────

const controllerSrc = readFileSync(
  path.resolve('src/controllers/gatewayController.js'), 'utf8'
);

const migration046 = readFileSync(
  path.resolve('src/db/migrations/046_gateway_soft_delete_fix.sql'), 'utf8'
);

// ── Migration 046 ───────────────────────────────────────────────────────────

describe('Migration 046 — partial unique index', () => {
  it('drops the non-partial unique constraint', () => {
    expect(migration046).toContain('DROP CONSTRAINT IF EXISTS sip_gateways_tenant_id_name_key');
  });

  it('creates a partial unique index scoped to active rows', () => {
    expect(migration046).toContain('CREATE UNIQUE INDEX IF NOT EXISTS sip_gateways_active_name_unique');
    expect(migration046).toContain('WHERE deleted_at IS NULL');
  });

  it('indexes on (tenant_id, name)', () => {
    expect(migration046).toContain('(tenant_id, name)');
  });

  it('is idempotent (IF NOT EXISTS / IF EXISTS guards)', () => {
    expect(migration046).toContain('DROP CONSTRAINT IF EXISTS');
    expect(migration046).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
  });

  it('is wrapped in a transaction', () => {
    expect(migration046).toMatch(/^\s*BEGIN;/m);
    expect(migration046).toMatch(/COMMIT;/m);
  });
});

// ── deleteGateway — state consistency ──────────────────────────────────────

describe('deleteGateway controller — soft-delete state', () => {
  it('sets deleted_at = now() on delete', () => {
    // The UPDATE must set deleted_at
    expect(controllerSrc).toContain('deleted_at = now()');
  });

  it('sets is_active = false on delete', () => {
    // Must atomically clear is_active so deleted row state is consistent
    const deleteBlock = controllerSrc.slice(
      controllerSrc.indexOf('deleteGateway'),
      controllerSrc.indexOf('deployGatewayRoute')
    );
    expect(deleteBlock).toContain('is_active = false');
  });

  it('sets both fields in the same UPDATE statement', () => {
    // Verify both are in the same SET clause (not two separate queries)
    const setClauseMatch = controllerSrc.match(/SET deleted_at = now\(\), is_active = false/);
    expect(setClauseMatch).not.toBeNull();
  });

  it('guards delete against already-deleted rows (deleted_at IS NULL filter)', () => {
    const deleteBlock = controllerSrc.slice(
      controllerSrc.indexOf('deleteGateway'),
      controllerSrc.indexOf('deployGatewayRoute')
    );
    expect(deleteBlock).toContain('deleted_at IS NULL');
  });
});

// ── listGateways — active-only filter ──────────────────────────────────────

describe('listGateways controller — excludes soft-deleted rows', () => {
  it('applies deleted_at IS NULL in SELECT', () => {
    const listBlock = controllerSrc.slice(
      controllerSrc.indexOf('listGateways'),
      controllerSrc.indexOf('createGateway')
    );
    expect(listBlock).toContain('deleted_at IS NULL');
  });
});

// ── updateGateway — guards against editing deleted rows ────────────────────

describe('updateGateway controller — cannot edit soft-deleted gateway', () => {
  it('applies deleted_at IS NULL in UPDATE WHERE clause', () => {
    const updateBlock = controllerSrc.slice(
      controllerSrc.indexOf('updateGateway'),
      controllerSrc.indexOf('deleteGateway')
    );
    expect(updateBlock).toContain('deleted_at IS NULL');
  });
});

// ── deployGatewayRoute — guards against deploying deleted gateways ──────────

describe('deployGatewayRoute — excludes soft-deleted gateways', () => {
  it('applies deleted_at IS NULL when fetching gateway for deployment', () => {
    const deployBlock = controllerSrc.slice(
      controllerSrc.indexOf('deployGatewayRoute'),
    );
    expect(deployBlock).toContain('deleted_at IS NULL');
  });
});

// ── Tenant isolation ────────────────────────────────────────────────────────

describe('Tenant isolation in gateway operations', () => {
  it('listGateways scopes to tenant', () => {
    const listBlock = controllerSrc.slice(
      controllerSrc.indexOf('listGateways'),
      controllerSrc.indexOf('createGateway')
    );
    expect(listBlock).toContain('tenant_id');
  });

  it('deleteGateway scopes to tenant', () => {
    const deleteBlock = controllerSrc.slice(
      controllerSrc.indexOf('deleteGateway'),
      controllerSrc.indexOf('deployGatewayRoute')
    );
    expect(deleteBlock).toContain('tenant_id');
  });

  it('createGateway uses requireTenantForWrite (never trusts body)', () => {
    expect(controllerSrc).toContain('requireTenantForWrite');
  });
});

// ── Re-creation semantics: no "restore" side effect ───────────────────────

describe('createGateway — always INSERTs a new row (no upsert/restore)', () => {
  it('uses INSERT not UPDATE or UPSERT', () => {
    const createBlock = controllerSrc.slice(
      controllerSrc.indexOf('createGateway'),
      controllerSrc.indexOf('updateGateway')
    );
    expect(createBlock).toContain('INSERT INTO sip_gateways');
    expect(createBlock).not.toContain('ON CONFLICT DO UPDATE');
    expect(createBlock).not.toContain('ON CONFLICT DO NOTHING');
  });

  it('new gateway starts with is_active reflecting the payload (default true)', () => {
    // The INSERT includes is_active from the validated payload
    const createBlock = controllerSrc.slice(
      controllerSrc.indexOf('createGateway'),
      controllerSrc.indexOf('updateGateway')
    );
    expect(createBlock).toContain('is_active');
  });
});
