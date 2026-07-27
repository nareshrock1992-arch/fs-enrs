/**
 * Environment configuration validator — Sprint 0 infrastructure foundation.
 *
 * Validates required environment variables at process startup.
 * In production mode: missing or weak values cause process.exit(1).
 * In development mode: warnings only.
 *
 * Usage (call early in server.js, before any other imports that use env vars):
 *   import { validateEnvironment } from './src/infrastructure/config/validator.js';
 *   validateEnvironment();
 */

import { logger } from '../logger.js';

const log = logger.child({ module: 'config-validator' });

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── Validation rules ─────────────────────────────────────────────────────────

const RULES = [
  // Database
  {
    key: 'DB_PASSWORD',
    required: IS_PRODUCTION,
    weak: ['changeme', 'password', ''],
    message: 'DB_PASSWORD must be set to a strong password.',
  },
  {
    key: 'DB_HOST',
    required: false,
    // No weakness check — localhost is acceptable in dev.
  },

  // JWT secrets
  {
    key: 'JWT_ACCESS_SECRET',
    required: IS_PRODUCTION,
    minLength: 32,
    weak: ['CHANGE_ME_access_secret_32plus', 'REPLACE_WITH_RANDOM_STRING_access_32_chars'],
    message: 'JWT_ACCESS_SECRET must be a random string of at least 32 characters.',
  },
  {
    key: 'JWT_REFRESH_SECRET',
    required: IS_PRODUCTION,
    minLength: 32,
    weak: ['CHANGE_ME_refresh_secret_32plus', 'REPLACE_WITH_RANDOM_STRING_refresh_32_chars'],
    message: 'JWT_REFRESH_SECRET must be a random string of at least 32 characters.',
  },

  // Internal API key
  {
    key: 'INTERNAL_API_KEY',
    required: IS_PRODUCTION,
    minLength: 32,
    weak: ['REPLACE_WITH_RANDOM_HEX_32'],
    message: 'INTERNAL_API_KEY must be at least 32 characters (generate: openssl rand -hex 32).',
  },

  // ESL
  {
    key: 'ESL_PASSWORD',
    required: false,
    weak: ['ClueCon'],
    message: 'ESL_PASSWORD is the public FreeSWITCH default. Change before Internet-facing deployment.',
    severity: 'warn', // Never fatal — valid on many on-prem deployments
  },
];

// ── Validation logic ─────────────────────────────────────────────────────────

export function validateEnvironment() {
  const errors  = [];
  const warnings = [];

  for (const rule of RULES) {
    const value   = process.env[rule.key];
    const isEmpty = !value || value.trim() === '';
    const isWeak  = !isEmpty && rule.weak?.includes(value);
    const isShort = !isEmpty && rule.minLength && value.length < rule.minLength;

    const problem = isEmpty
      ? `${rule.key} is not set.`
      : isWeak
        ? `${rule.key} is set to an insecure default value.`
        : isShort
          ? `${rule.key} is too short (${value.length} chars; minimum ${rule.minLength}).`
          : null;

    if (!problem) continue;

    const msg = rule.message
      ? `${problem} ${rule.message}`
      : problem;

    const severity = rule.severity ?? (rule.required ? 'error' : 'warn');

    if (severity === 'error') {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }

  for (const msg of warnings) {
    log.warn(`[config] SECURITY WARNING: ${msg}`);
  }

  if (errors.length > 0) {
    for (const msg of errors) {
      log.error(`[config] FATAL: ${msg}`);
    }
    if (IS_PRODUCTION) {
      process.exit(1);
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    log.info('Environment configuration validated successfully');
  }
}
