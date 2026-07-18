// Load .env from the same directory as this file, regardless of cwd.
// Must be the very first import so that all subsequent imports see the
// correct environment variables. PM2's `env` block values are intentionally
// NOT overridden here (override: false), so explicit PM2 env overrides
// (e.g. a per-deploy NODE_ENV) are still respected.
import './load-env.js';

// ── Global safety net ─────────────────────────────────────────
// Unhandled promise rejections that escape asyncHandler or try/catch would
// silently disappear in Node 20+ (no crash, no log). Surface them so they
// appear in PM2 logs and can be investigated.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[boot] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[boot] Uncaught exception — process will exit:', err);
  process.exit(1);
});

import http            from 'http';
import express         from 'express';
import cors            from 'cors';
import helmet          from 'helmet';
import cookieParser    from 'cookie-parser';
import rateLimit       from 'express-rate-limit';

import { existsSync } from 'fs';
import bcrypt         from 'bcryptjs';
import { config }      from './src/config/index.js';
import { testConnection, query } from './src/db/pool.js';
import { validateSchema }  from './src/db/validateSchema.js';
import { connect as eslConnect, eslEvents, eslStatus, reconcileAllActiveIncidents, startBackgroundJobs, seedConferenceRegistry } from './src/services/eslService.js';
import { fsPathService } from './src/services/freeSwitchPathService.js';
import { scanRecordingDirectory } from './src/controllers/recordingController.js';
import { initSocket }  from './src/services/socketService.js';
import { startEngine, stopEngine, onCallAnswer, onCallHangup } from './src/services/campaignEngine.js';
import v1Routes        from './src/routes/v1/index.js';
import internalRoutes  from './src/routes/internal/index.js';
import { internalAuth, internalRateLimit } from './src/middleware/internalAuth.js';
import { errorHandler } from './src/middleware/asyncHandler.js';
import { checkNodeTypeApiEndpoints } from './src/nodeTypes/selfCheck.js';

const app    = express();
const server = http.createServer(app);

// ── Socket.IO ────────────────────────────────────────────────
initSocket(server);

// ── Security headers ─────────────────────────────────────────
app.use(helmet());

// ── CORS ─────────────────────────────────────────────────────
app.use(cors({
  origin:      config.cors.origins,
  credentials: true,
}));

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Global rate limiting ──────────────────────────────────────
app.use('/api', rateLimit({
  windowMs: 60_000,  // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Rate limit exceeded, slow down' },
}));

// ── Static uploads ────────────────────────────────────────────
app.use('/uploads', express.static('./uploads'));

// ── Health check (no auth) ────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'fs-enrs', time: new Date().toISOString() });
});

// ── Internal API (Lua contract) — X-Internal-Key auth only ───
// IMPORTANT: This must never be exposed to the public internet.
// Add "location /api/v1/internal { deny all; }" in Nginx for WAN.
app.use('/api/v1/internal', internalRateLimit, internalAuth, internalRoutes);

// ── API routes v1 ─────────────────────────────────────────────
app.use('/api/v1', v1Routes);

// ── 404 catch-all ─────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));

// ── Global error handler ──────────────────────────────────────
app.use(errorHandler);

// ── Boot sequence ─────────────────────────────────────────────
// ── Auto-seed admin user ──────────────────────────────────────────────────────
// Creates the default admin user and supporting tenant/org/ESL row if they
// do not already exist. Never mutates an existing user's password — only
// inserts when the row is absent, so existing logins are never disrupted.
async function ensureAdminUser() {
  try {
    const email    = process.env.SEED_ADMIN_EMAIL    || 'admin@enrs.local';
    const password = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';

    // Upsert tenant
    const { rows: [tenant] } = await query(
      `INSERT INTO tenants (name, code) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      ['Default Tenant', 'DEFAULT']
    );

    // Insert admin user only when absent — never overwrite an existing hash
    const { rows: [existing] } = await query(
      `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email.toLowerCase()]
    );

    if (!existing) {
      const hash = await bcrypt.hash(password, 12);
      await query(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, 'System Administrator', 'ADMIN')
         ON CONFLICT (email) DO NOTHING`,
        [tenant.id, email.toLowerCase(), hash]
      );
      console.log(`[boot] Admin user created: ${email} (change password after first login)`);
    }

    // Default organization
    await query(
      `INSERT INTO organizations (tenant_id, name, code, description)
       VALUES ($1, 'Default Organization', 'DEFAULT-ORG', 'Created automatically')
       ON CONFLICT DO NOTHING`,
      [tenant.id]
    );

    // ESL connection record
    await query(
      `INSERT INTO esl_connections (name, host, port, password)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      ['Primary FreeSWITCH',
       process.env.ESL_HOST || '127.0.0.1',
       Number(process.env.ESL_PORT || 8021),
       process.env.ESL_PASSWORD || 'ClueCon']
    ).catch(() => {}); // esl_connections may not exist on all deployments
  } catch (err) {
    console.warn('[boot] ensureAdminUser failed (non-fatal):', err.message);
  }
}

// ── Credential security checks ────────────────────────────────────────────────
// Policy:
//   development — warn only, never exit. Devs use default passwords intentionally.
//   production  — fatal exit for weak JWT, missing INTERNAL_API_KEY, weak DB_PASSWORD.
//                 ESL_PASSWORD=ClueCon is WARN only even in production, because
//                 ClueCon is a valid password on many lab and on-prem FreeSWITCH
//                 deployments. Change it before Internet-facing deploys.
function checkCredentials() {
  const isProduction = config.env === 'production';
  const warn  = (msg) => console.warn(`[boot] SECURITY WARNING: ${msg}`);
  const fatal = (msg) => { console.error(`[boot] FATAL: ${msg}`); process.exit(1); };

  // Diagnostic: always log the effective NODE_ENV and ESL_PASSWORD presence
  // so the value is visible in PM2 logs before any checks run.
  console.log(`[boot] NODE_ENV=${config.env}  ESL_PASSWORD=${process.env.ESL_PASSWORD ? '(set)' : '(unset)'}`);

  const WEAK_JWT = ['CHANGE_ME_access_secret_32plus', 'CHANGE_ME_refresh_secret_32plus'];
  if (WEAK_JWT.includes(config.jwt.accessSecret) || WEAK_JWT.includes(config.jwt.refreshSecret)) {
    (isProduction ? fatal : warn)(
      'JWT secrets are set to insecure defaults. Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in .env.'
    );
  }
  if (!process.env.INTERNAL_API_KEY || process.env.INTERNAL_API_KEY.length < 32) {
    (isProduction ? fatal : warn)(
      'INTERNAL_API_KEY must be at least 32 characters. Set INTERNAL_API_KEY in .env.'
    );
  }
  if (process.env.DB_PASSWORD === 'changeme' || !process.env.DB_PASSWORD) {
    (isProduction ? fatal : warn)(
      'DB_PASSWORD is set to an insecure default. Set DB_PASSWORD in .env.'
    );
  }
  // ESL_PASSWORD — warn only in both dev and production.
  // ClueCon is the upstream FreeSWITCH default and is valid on many
  // lab and on-prem systems. Change it before Internet-facing deployment.
  if (process.env.ESL_PASSWORD === 'ClueCon' || !process.env.ESL_PASSWORD) {
    warn(
      'ESL_PASSWORD is the publicly-known FreeSWITCH default (ClueCon). ' +
      'Change it before Internet-facing deployment.'
    );
  }
}

// ── Startup Validation Banner ─────────────────────────────────────────────────
// Prints a formatted summary of every subsystem check 3 seconds after the
// server starts listening. The delay lets ESL complete its handshake and
// conference sync run before we sample their state.
//
// Each row: label (left-padded to a fixed width) : value  status-icon
// OK = ✓  WARN = ⚠  FAIL = ✗
async function printStartupBanner() {
  const W = 57; // total banner width between the === borders

  const ok   = (v) => `${v} \x1b[32m✓\x1b[0m`;
  const warn = (v) => `${v} \x1b[33m⚠\x1b[0m`;
  const fail = (v) => `${v} \x1b[31m✗\x1b[0m`;

  const line  = '='.repeat(W);
  const blank = '';

  // Collect checks
  const rows = [];

  const add = (label, value) => rows.push({ label, value });

  // ── Environment ──
  add('Environment',      config.env === 'production' ? ok(config.env) : warn(config.env + ' (not production)'));
  add('Node',             ok(process.version));
  add('Backend Port',     ok(config.port));
  add('Frontend Port',    ok(process.env.FRONTEND_PORT || 8100));

  // ── Database ──
  let dbStatus;
  try {
    const dbOk = await testConnection();
    dbStatus = dbOk ? ok('Connected') : fail('Unreachable');
  } catch {
    dbStatus = fail('Error');
  }
  add('Database', dbStatus);

  // ── FreeSWITCH ESL ──
  const esl = eslStatus();
  add('FreeSWITCH ESL',
    esl.connected
      ? ok(`Connected  (${esl.host}:${esl.port})`)
      : warn(`Offline — will retry  (${esl.host}:${esl.port})`));

  // ── Credentials ──
  const WEAK_JWT = ['CHANGE_ME_access_secret_32plus', 'CHANGE_ME_refresh_secret_32plus'];
  const jwtOk = !WEAK_JWT.includes(config.jwt.accessSecret) && !WEAK_JWT.includes(config.jwt.refreshSecret);
  add('JWT', jwtOk ? ok('OK') : (config.env === 'production' ? fail('Weak secrets') : warn('Weak secrets')));

  const apiKeyOk = process.env.INTERNAL_API_KEY && process.env.INTERNAL_API_KEY.length >= 32;
  add('Internal API Key', apiKeyOk ? ok('OK') : (config.env === 'production' ? fail('Missing / short') : warn('Missing / short')));

  // ── FreeSWITCH Paths ──
  const checkPath = (label, dir) => {
    if (!dir) { add(label, warn('Not configured')); return; }
    add(label, existsSync(dir) ? ok(dir) : warn(`Not found: ${dir}`));
  };

  checkPath('Recordings Path', fsPathService.getRecordingDir());
  checkPath('Lua Scripts Path', fsPathService.getScriptDir());
  checkPath('Sound Path',       fsPathService.getSoundDir());
  checkPath('Dialplan Path',    fsPathService.getDialplanDir());

  // ── Conference Sync ──
  let syncStatus;
  try {
    const confs = await seedConferenceRegistry();
    syncStatus = ok(`${confs.length} conference${confs.length !== 1 ? 's' : ''} loaded`);
  } catch (e) {
    syncStatus = esl.connected
      ? warn(`Sync failed: ${e.message}`)
      : warn('Skipped (ESL offline)');
  }
  add('Conference Sync', syncStatus);

  // ── Render ──
  const COL = 17; // label column width
  const renderRow = ({ label, value }) => {
    const padded = label.padEnd(COL);
    return `  ${padded}: ${value}`;
  };

  const lines = [
    blank,
    line,
    '  FS-ENRS Startup Validation',
    line,
    blank,
    ...rows.map(renderRow),
    blank,
    line,
    '  READY',
    line,
    blank,
  ];

  console.log(lines.join('\n'));
}

async function start() {
  checkCredentials();

  // Verify DB before starting
  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('[boot] Cannot reach PostgreSQL — check DB_HOST/DB_NAME/DB_PASSWORD in .env');
    process.exit(1);
  }

  // Verify that all required columns exist — exits with a clear message if
  // migrations haven't been run yet (catches controller/schema drift at boot)
  await validateSchema();

  // Auto-seed admin user if it does not exist yet.
  // This ensures login always works on first boot without requiring a manual
  // `npm run seed` step. Never overwrites an existing user's password.
  await ensureAdminUser();

  // Start listening
  server.listen(config.port, () => {
    console.log(`[boot] fs-enrs listening on :${config.port}  (${config.env})`);
  });

  // Non-fatal — a stale registry entry shouldn't block boot, but must be
  // loud, not silent.
  checkNodeTypeApiEndpoints();

  // Connect to FreeSWITCH (non-fatal — app works without ESL)
  try { eslConnect(); }
  catch (err) { console.warn('[boot] ESL connect failed (will retry):', err.message); }

  // Start heartbeat + reconciliation sweep intervals. Must be called here
  // (not at module load time) so that scripts/tests that import eslService
  // don't inherit intervals that outlive their pool.
  startBackgroundJobs();

  // Startup validation banner — fires 3 s after listen so ESL has time to
  // complete its handshake before we sample its connected state.
  setTimeout(() => {
    printStartupBanner().catch(err =>
      console.error('[boot] startup banner error:', err.message)
    );
  }, 3000);

  // Startup incident reconciliation — mark any ACTIVE incident whose
  // deterministic conference room is now empty as COMPLETED. Runs once at
  // boot (catches crashes during downtime), then every 60 s via the sweep
  // in eslService.js. Non-fatal: ESL may not be up yet.
  setTimeout(() => {
    reconcileAllActiveIncidents().catch(err =>
      console.warn('[boot] startup reconciliation skipped:', err.message)
    );
  }, 5000); // wait 5 s for ESL to connect before checking member counts

  // Startup recording directory scan — imports any conference recordings that
  // exist on disk but are not yet tracked in the DB (e.g. from a previous run
  // that crashed before the stop-recording ESL event fired, or manual recordings).
  setTimeout(() => {
    scanRecordingDirectory().catch(err =>
      console.warn('[boot] recording directory scan failed:', err.message)
    );
  }, 8000);

  // Wire ESL events → campaign engine
  eslEvents.on('CHANNEL_ANSWER', ({ uuid }) => {
    onCallAnswer(uuid).catch(e => console.error('[campaign] answer error:', e.message));
  });
  eslEvents.on('CHANNEL_HANGUP', ({ uuid, cause }) => {
    onCallHangup(uuid, cause).catch(e => console.error('[campaign] hangup error:', e.message));
  });

  // Start outbound campaign engine
  startEngine();

  const gracefulShutdown = (signal) => {
    console.log(`[boot] ${signal} received — shutting down gracefully`);
    stopEngine();
    server.close(() => {
      console.log('[boot] HTTP server closed');
      process.exit(0);
    });
    // Force exit if close takes too long (e.g. hanging WebSocket connections)
    setTimeout(() => { console.error('[boot] Forced exit after timeout'); process.exit(1); }, 10_000);
  };
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
}

// Export server for supertest in test environment
if (process.env.NODE_ENV !== 'test') {
  start();
} else {
  // In test env: connect DB only, do not listen (supertest manages port)
  testConnection().catch(err => {
    console.error('[test] DB connection failed:', err.message);
    process.exit(1);
  });
}

export default server;
