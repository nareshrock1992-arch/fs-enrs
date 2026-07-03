import 'dotenv/config';
import http            from 'http';
import express         from 'express';
import cors            from 'cors';
import helmet          from 'helmet';
import cookieParser    from 'cookie-parser';
import rateLimit       from 'express-rate-limit';

import { config }      from './src/config/index.js';
import { testConnection } from './src/db/pool.js';
import { connect as eslConnect } from './src/services/eslService.js';
import { initSocket }  from './src/services/socketService.js';
import v1Routes        from './src/routes/v1/index.js';
import { errorHandler } from './src/middleware/asyncHandler.js';

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

  // Connect to FreeSWITCH (non-fatal — app works without ESL)
  try { eslConnect(); }
  catch (err) { console.warn('[boot] ESL connect failed (will retry):', err.message); }
}

start();
