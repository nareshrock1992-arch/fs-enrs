import 'dotenv/config';
import http            from 'http';
import express         from 'express';
import cors            from 'cors';
import helmet          from 'helmet';
import cookieParser    from 'cookie-parser';
import rateLimit       from 'express-rate-limit';

import { config }      from './src/config/index.js';
import { testConnection } from './src/db/pool.js';
import { connect as eslConnect, eslEvents, reconcileAllActiveIncidents } from './src/services/eslService.js';
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
async function start() {
  // Verify DB before starting
  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('[boot] Cannot reach PostgreSQL — check DB_HOST/DB_NAME/DB_PASSWORD in .env');
    process.exit(1);
  }

  // Start listening
  server.listen(config.port, () => {
    console.log(`[boot] fs-enrs API running on port ${config.port}`);
    console.log(`[boot] Environment: ${config.env}`);
  });

  // Non-fatal — a stale registry entry shouldn't block boot, but must be
  // loud, not silent.
  checkNodeTypeApiEndpoints();

  // Connect to FreeSWITCH (non-fatal — app works without ESL)
  try { eslConnect(); }
  catch (err) { console.warn('[boot] ESL connect failed (will retry):', err.message); }

  // Startup incident reconciliation — mark any ACTIVE incident whose
  // deterministic conference room is now empty as COMPLETED. Runs once at
  // boot (catches crashes during downtime), then every 60 s via the sweep
  // in eslService.js. Non-fatal: ESL may not be up yet.
  setTimeout(() => {
    reconcileAllActiveIncidents().catch(err =>
      console.warn('[boot] startup reconciliation skipped:', err.message)
    );
  }, 5000); // wait 5 s for ESL to connect before checking member counts

  // Wire ESL events → campaign engine
  eslEvents.on('CHANNEL_ANSWER', ({ uuid }) => {
    onCallAnswer(uuid).catch(e => console.error('[campaign] answer error:', e.message));
  });
  eslEvents.on('CHANNEL_HANGUP', ({ uuid, cause }) => {
    onCallHangup(uuid, cause).catch(e => console.error('[campaign] hangup error:', e.message));
  });

  // Start outbound campaign engine
  startEngine();

  process.on('SIGTERM', () => { stopEngine(); });
  process.on('SIGINT',  () => { stopEngine(); });
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
