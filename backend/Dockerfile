FROM node:20-alpine

WORKDIR /app

# Install deps using lockfile for reproducible builds
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Create upload directory with correct ownership
RUN mkdir -p /app/uploads && chown -R node:node /app

# Drop root privileges
USER node

EXPOSE 4100

HEALTHCHECK --interval=15s --timeout=5s --start-period=45s \
  CMD wget -qO- http://localhost:4100/api/health || exit 1

# Run migrations then start the server.
# migrate.js is idempotent — safe to run on every container start.
CMD ["sh", "-c", "node src/db/migrate.js && node server.js"]
