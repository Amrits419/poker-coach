# ── Build stage ──────────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
