# =============================================================================
# fs-enrs Backend — Production Dockerfile
# =============================================================================
# Multi-stage build:
#   deps        — installs production-only npm dependencies (cached layer)
#   production  — final lean image running as non-root with tini PID 1
# =============================================================================

# ── Stage 1: dependency installation ─────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts; \
    else \
      npm install --omit=dev --ignore-scripts; \
    fi

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20-alpine AS production

# tini for correct PID-1 signal forwarding; wget for HEALTHCHECK
# curl: required by diagnosticsService.js (execSync('curl --version')) to probe
# curl availability — the /diagnostics endpoint will FAIL if curl is absent.
# NOTE: this satisfies the container-side check only. The FreeSWITCH HOST also
# requires curl independently (Lua io.popen calls) — see deploy/DEPENDENCIES.md.
RUN apk add --no-cache tini wget curl

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

# Copy the entrypoint first (separate layer — changes rarely)
COPY docker-entrypoint.sh /docker-entrypoint.sh

COPY . .

# Entrypoint runs migrations before starting the server (runs as root during
# build so it can chmod; the node user runs it at container start time).
RUN chmod +x /docker-entrypoint.sh \
    && mkdir -p uploads logs recordings \
    && chown -R node:node /app

USER node

EXPOSE 4100

# ENRS exposes richer health endpoints:
#   /health/live  — process is alive (no external deps)
#   /health/ready — DB + ESL connections established (gates load balancer traffic)
#
# start-period covers migration time on a fresh database (schema.sql + all
# numbered migrations). Idempotent runs on an existing database are ~2 s.
# Allow 90 s so even a first-boot with 30+ migration files has headroom.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4100/health/ready || exit 1

# tini (PID 1) → /docker-entrypoint.sh → exec node server.js
# The exec replaces the shell process so tini manages node directly.
ENTRYPOINT ["/sbin/tini", "--", "/docker-entrypoint.sh"]
CMD ["node", "server.js"]
