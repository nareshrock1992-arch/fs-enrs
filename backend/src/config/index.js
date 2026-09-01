// dotenv is loaded by load-env.js at the server.js entry point.
// Do NOT call dotenv.config() here — that would use process.cwd() which
// may be wrong under PM2, and would re-parse .env after env vars are set.
import { fsConfig } from './fsConfig.js';

// All configuration read from environment variables.
// Never hardcode secrets — change them in .env only.
export { fsConfig };

export const config = {
  env:  process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4100,

  db: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT) || 5432,
    name:     process.env.DB_NAME     || 'fs_enrs',
    user:     process.env.DB_USER     || 'fs_enrs',
    password: process.env.DB_PASSWORD || 'changeme',
    ssl:      process.env.DB_SSL === 'true',
  },

  jwt: {
    accessSecret:  process.env.JWT_ACCESS_SECRET  || 'CHANGE_ME_access_secret_32plus',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'CHANGE_ME_refresh_secret_32plus',
    accessExpiry:  process.env.JWT_ACCESS_EXPIRY  || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },

  esl: {
    host:        process.env.ESL_HOST        || '127.0.0.1',
    port:        Number(process.env.ESL_PORT) || 8021,
    password:    process.env.ESL_PASSWORD    || 'ClueCon',
    reconnectMs: Number(process.env.ESL_RECONNECT_MS) || 3000,
    // SIP domain used for sofia/internal/<ext>@<domain> dial strings
    // (dialResolver.js). Was referenced here before but never defined —
    // always silently fell through to the 127.0.0.1 default.
    domain:      process.env.SIP_DOMAIN || process.env.ESL_DOMAIN || '127.0.0.1',
  },

  cors: {
    // Comma-separated list of allowed origins
    origins: (process.env.CORS_ORIGIN || 'http://localhost:8100')
      .split(',').map(o => o.trim()),
  },

  uploads: {
    dir: process.env.UPLOAD_DIR || './uploads',
    maxSizeMb: Number(process.env.UPLOAD_MAX_MB) || 50,
  },

  fs: fsConfig,

  freeswitch: {
    // URL that FreeSWITCH Lua scripts use to reach this backend
    apiUrl:         process.env.ENRS_API_URL       || `http://127.0.0.1:${Number(process.env.PORT) || 4100}`,
    // TTS engine string passed to FreeSWITCH speak application: "engine|voice"
    ttsEngine:      process.env.FS_TTS_ENGINE       || 'flite|kal',
    // SIP gateway name in FreeSWITCH for outbound ENS campaign calls
    defaultGateway: process.env.FS_DEFAULT_GATEWAY  || 'default',
    // SIP domain for P-Asserted-Identity headers (e.g. "yerp.com").
    // Per-gateway sip_domain takes priority; this is the global fallback.
    // Leave empty ('') to suppress PAI when no gateway sip_domain is set.
    sipDomain:      process.env.FS_SIP_DOMAIN        || '',
  },

  // Piper TTS synthesis service.
  // Docker: PIPER_URL=http://piper:5000 (set by docker-compose).
  // Source-level DEV: PIPER_URL=http://127.0.0.1:5002 (set in backend/.env.dev).
  // The backend (ENS pre-synthesis via piperClient.js) calls this service.
  // IVR Lua scripts call Piper directly via curl using the PIPER_URL injected at deploy time.
  piper: {
    // Base URL of the Piper HTTP service
    url:            process.env.PIPER_URL             || 'http://piper:5000',
    // Default voice model name (must be registered in Piper's VOICE_REGISTRY)
    defaultVoice:   process.env.PIPER_DEFAULT_VOICE   || 'en_US-lessac-medium',
    // HTTP request timeout for synthesis calls (ms).
    // lessac-medium cold synthesis takes 12-16s — 30s gives safe headroom.
    timeoutMs:      Number(process.env.PIPER_TIMEOUT_MS)     || 30000,
    // Target output sample rate — must match FreeSWITCH codec profile
    // Verify: fs_cli -x "global_getvar default_sample_rate"
    sampleRate:     Number(process.env.PIPER_SAMPLE_RATE)    || 8000,
    // Max concurrent synthesis requests (matches Piper's PIPER_MAX_CONCURRENT)
    maxConcurrent:  Number(process.env.PIPER_MAX_CONCURRENT) || 2,
  },
};
