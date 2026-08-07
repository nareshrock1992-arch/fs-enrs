# =============================================================================
# fs-enrs Frontend — Production Dockerfile
# =============================================================================

# ── Stage 1: Vite build ────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# VITE_BASE_PATH   — Vite --base; sets import.meta.env.BASE_URL for asset URLs.
# VITE_API_URL     — API base the browser sends requests to.
#                      Dev:  /api/v1        — Vite proxy forwards to enrs-backend
#                      Prod: /enrs/api/v1   — nginx routes /enrs/api/* → enrs-backend/api/*
# VITE_SOCKET_PATH — Socket.IO handshake path.
#                      Dev:  /socket.io         — Vite proxy
#                      Prod: /enrs/socket.io    — nginx routes to enrs-backend
ARG VITE_BASE_PATH=/enrs/
ARG VITE_API_URL=/enrs/api/v1
ARG VITE_SOCKET_PATH=/enrs/socket.io

ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_SOCKET_PATH=${VITE_SOCKET_PATH}

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --ignore-scripts; \
    else \
      npm install --ignore-scripts; \
    fi

COPY . .

RUN npm run build -- --base ${VITE_BASE_PATH}

# ── Stage 2: static file server ───────────────────────────────────────────────
FROM nginx:1.27-alpine AS serve

COPY nginx.prod.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
