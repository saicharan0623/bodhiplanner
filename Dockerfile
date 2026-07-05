# ─── Stage 1: Build the React frontend ─────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci --omit=dev || npm install
COPY client/ ./
RUN npm run build

# ─── Stage 2: Production server ───────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Install server dependencies
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && (npm ci --omit=dev || npm install --omit=dev)

# Copy server code
COPY server/ ./server/

# Copy built frontend from stage 1
COPY --from=frontend-build /app/client/dist ./client/dist/

# Non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup
USER appuser

EXPOSE 3001

ENV NODE_ENV=production

CMD ["node", "server/index.js"]
