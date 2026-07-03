FROM node:20-alpine

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Create upload directory
RUN mkdir -p /app/uploads

EXPOSE 4100

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
  CMD wget -qO- http://localhost:4100/api/health || exit 1

CMD ["node", "server.js"]
